// WebSocket hub: tracks online users + routes dispatch frames.
//
// Per INARI_AI_ARCHITECTURE.md §4.3 (WS Relay Protocol):
// - Inari Live registers on boot via `register({ user_id, capabilities })`.
// - Relay tracks online users in-memory (Redis-backed registry deferred —
//   single-node Hetzner is fine for v0.1; horizontal scaling is a Phase 4
//   concern when concurrent users > 1k).
// - Relay forwards `dispatch` frames over the user's WS, awaits a
//   matching `response` keyed by request_id, returns to the HTTP caller.
// - Heartbeat: server sends ping every 30s, drops conn if no pong in 60s.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// pingInterval is how often the relay pings each connected sidecar.
	// Matches the §4.3 contract — Inari Live must respond to a ping in
	// readWait or the relay drops the connection.
	pingInterval = 30 * time.Second
	// readWait must be > pingInterval so a missed pong is the signal,
	// not normal idle. 60s = 2× pingInterval.
	readWait = 60 * time.Second
	writeWait = 10 * time.Second
	// maxMessageSize caps the inbound frame size to defend against
	// memory pressure from a misbehaving sidecar. 1 MB is plenty for
	// notify.compose.* responses (largest expected); larger payloads
	// (postmortem-prose) will be chunked or compressed before reaching
	// here in Phase 4.
	maxMessageSize = 1 << 20
)

// upgrader is package-level so tests can override it. CheckOrigin is
// permissive because this server only accepts WS traffic that already
// passed JWT verification — the JWT is the trust boundary, not Origin.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// frame types travelling over the WS.
const (
	frameRegister = "register"
	frameDispatch = "dispatch"
	frameResponse = "response"
	frameError    = "error"
	frameAck      = "ack"
)

type registerFrame struct {
	Type         string   `json:"type"`
	Capabilities []string `json:"capabilities"`
	AppVersion   string   `json:"app_version,omitempty"`
	OS           string   `json:"os,omitempty"`
	Arch         string   `json:"arch,omitempty"`
}

type dispatchFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Task      string          `json:"task"`
	Payload   json.RawMessage `json:"payload"`
	TimeoutMS int             `json:"timeout_ms,omitempty"`
}

type responseFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	Status    string          `json:"status"` // "ok" | "error"
	Body      json.RawMessage `json:"body,omitempty"`
	Receipt   json.RawMessage `json:"receipt,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// connection wraps a single WS bound to a user_id.
type connection struct {
	hub          *hub
	conn         *websocket.Conn
	userID       string
	capabilities []string
	appVersion   string
	os           string
	arch         string
	connectedAt  time.Time
	lastSeenMu   sync.RWMutex
	lastSeen     time.Time
	send         chan []byte

	// pending request_id → responseFrame channel. Cleared on disconnect.
	pendingMu sync.Mutex
	pending   map[string]chan responseFrame
}

func newConnection(h *hub, ws *websocket.Conn, userID string) *connection {
	now := time.Now()
	return &connection{
		hub:         h,
		conn:        ws,
		userID:      userID,
		connectedAt: now,
		lastSeen:    now,
		send:        make(chan []byte, 16),
		pending:     make(map[string]chan responseFrame),
	}
}

func (c *connection) updateLastSeen() {
	c.lastSeenMu.Lock()
	c.lastSeen = time.Now()
	c.lastSeenMu.Unlock()
}

func (c *connection) getLastSeen() time.Time {
	c.lastSeenMu.RLock()
	defer c.lastSeenMu.RUnlock()
	return c.lastSeen
}

// readLoop pumps inbound frames. The first frame MUST be `register`; any
// other type before register closes the connection. After register, the
// loop dispatches `response` frames to the matching pending request.
func (c *connection) readLoop() {
	defer c.hub.unregister(c)
	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(readWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(readWait))
		c.updateLastSeen()
		return nil
	})
	registered := false
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		c.updateLastSeen()
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			continue
		}
		switch probe.Type {
		case frameRegister:
			if registered {
				continue
			}
			var rf registerFrame
			if err := json.Unmarshal(raw, &rf); err != nil {
				continue
			}
			c.capabilities = rf.Capabilities
			c.appVersion = rf.AppVersion
			c.os = rf.OS
			c.arch = rf.Arch
			registered = true
			c.hub.register(c)
			ack := map[string]string{"type": frameAck, "status": "registered"}
			ackBytes, _ := json.Marshal(ack)
			c.queueSend(ackBytes)
		case frameResponse:
			if !registered {
				continue
			}
			var rf responseFrame
			if err := json.Unmarshal(raw, &rf); err != nil {
				continue
			}
			c.deliverResponse(rf)
		default:
			// Unknown frames are dropped silently — protocol is forward-compatible.
		}
	}
}

// writeLoop pumps outbound frames + sends pings.
func (c *connection) writeLoop() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *connection) queueSend(b []byte) {
	defer func() {
		// Recover from send-on-closed-channel during graceful shutdown.
		_ = recover()
	}()
	select {
	case c.send <- b:
	default:
		// Drop frame on slow consumer rather than block. Caller of
		// dispatch() will hit the timeout path.
	}
}

func (c *connection) deliverResponse(rf responseFrame) {
	c.pendingMu.Lock()
	ch, ok := c.pending[rf.RequestID]
	if ok {
		delete(c.pending, rf.RequestID)
	}
	c.pendingMu.Unlock()
	if !ok {
		return
	}
	// Non-blocking: pending channel is buffered with 1 slot.
	select {
	case ch <- rf:
	default:
	}
}

// hub owns the userID → connection registry.
type hub struct {
	mu    sync.RWMutex
	conns map[string]*connection // userID → connection
}

func newHub() *hub {
	return &hub{conns: make(map[string]*connection)}
}

// register adds a connection. If a previous connection exists for the
// same user_id (e.g. user opened a second laptop), the old one is
// closed — last-write wins. This matches the contract in §4.3 where
// only one Inari Live per user is expected.
func (h *hub) register(c *connection) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if prev, ok := h.conns[c.userID]; ok && prev != c {
		// Don't close the channel here — writeLoop owns its lifetime.
		// Closing the WS triggers the prev's readLoop to exit and call
		// unregister, which is a no-op because we replace below.
		_ = prev.conn.Close()
	}
	h.conns[c.userID] = c
}

func (h *hub) unregister(c *connection) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.conns[c.userID]; ok && cur == c {
		delete(h.conns, c.userID)
	}
	// Drain pending: every awaiter sees a synthetic disconnect frame so
	// the dispatch HTTP handler returns 503 instead of hanging.
	c.pendingMu.Lock()
	for id, ch := range c.pending {
		select {
		case ch <- responseFrame{
			Type:      frameError,
			RequestID: id,
			Status:    "error",
			Error:     "sidecar-disconnect",
		}:
		default:
		}
		delete(c.pending, id)
	}
	c.pendingMu.Unlock()
}

func (h *hub) get(userID string) (*connection, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.conns[userID]
	return c, ok
}

// snapshot returns a copy of the current connection metadata for the
// admin endpoint. Cheap O(N) walk; N is tiny (hundreds of connections).
type connectionSnapshot struct {
	UserID       string    `json:"user_id"`
	Capabilities []string  `json:"capabilities"`
	AppVersion   string    `json:"app_version,omitempty"`
	OS           string    `json:"os,omitempty"`
	Arch         string    `json:"arch,omitempty"`
	ConnectedAt  time.Time `json:"connected_at"`
	LastSeen     time.Time `json:"last_seen"`
}

func (h *hub) snapshot() []connectionSnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]connectionSnapshot, 0, len(h.conns))
	for _, c := range h.conns {
		out = append(out, connectionSnapshot{
			UserID:       c.userID,
			Capabilities: append([]string(nil), c.capabilities...),
			AppVersion:   c.appVersion,
			OS:           c.os,
			Arch:         c.arch,
			ConnectedAt:  c.connectedAt,
			LastSeen:     c.getLastSeen(),
		})
	}
	return out
}

// dispatchToUser sends a dispatch frame to the user's WS and waits for a
// matching response. ctx controls cancellation + timeout. Returns
// (response, true) on success, (zero, false) if user offline.
func (h *hub) dispatchToUser(
	ctx context.Context,
	userID, requestID, task string,
	payload json.RawMessage,
) (responseFrame, error) {
	c, ok := h.get(userID)
	if !ok {
		return responseFrame{}, errSidecarOffline
	}
	df := dispatchFrame{
		Type:      frameDispatch,
		RequestID: requestID,
		Task:      task,
		Payload:   payload,
	}
	b, err := json.Marshal(df)
	if err != nil {
		return responseFrame{}, err
	}
	respCh := make(chan responseFrame, 1)
	c.pendingMu.Lock()
	c.pending[requestID] = respCh
	c.pendingMu.Unlock()

	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, requestID)
		c.pendingMu.Unlock()
	}()

	c.queueSend(b)

	select {
	case rf := <-respCh:
		if rf.Type == frameError {
			return rf, errSidecarDisconnect
		}
		return rf, nil
	case <-ctx.Done():
		return responseFrame{}, errSidecarTimeout
	}
}

var (
	errSidecarOffline    = errors.New("sidecar-offline")
	errSidecarTimeout    = errors.New("sidecar-timeout")
	errSidecarDisconnect = errors.New("sidecar-disconnect")
)
