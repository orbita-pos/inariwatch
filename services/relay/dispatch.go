// HTTP /dispatch handler — server-to-server endpoint web's router calls
// to forward a task to the user's Inari Live sidecar.
//
// Per INARI_AI_ARCHITECTURE.md §4.3:
// - Auth: Bearer RELAY_DISPATCH_SECRET (constant-time compare).
// - Body: { user_id, task, payload, timeout_ms? }.
// - User offline → 503 Service Unavailable. Web's router fallback rule
//   then routes to cloud transparently (no user-visible difference).
// - Timeout: 5s end-to-end. Sidecar contract from §4.3 is a 2s SLO; we
//   give it 5s headroom for tail latency.

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

const (
	defaultDispatchTimeout = 5 * time.Second
	maxDispatchTimeout     = 30 * time.Second
)

type dispatchRequest struct {
	UserID    string          `json:"user_id"`
	Task      string          `json:"task"`
	Payload   json.RawMessage `json:"payload"`
	TimeoutMS int             `json:"timeout_ms,omitempty"`
}

type dispatchResponse struct {
	RequestID string          `json:"request_id"`
	UserID    string          `json:"user_id"`
	Task      string          `json:"task"`
	Status    string          `json:"status"`
	Body      json.RawMessage `json:"body,omitempty"`
	Receipt   json.RawMessage `json:"receipt,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// handleDispatch wires the HTTP endpoint to the WS hub.
func handleDispatch(h *hub, dispatchSecret []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := verifyDispatchAuth(r, dispatchSecret); err != nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: err.Error()})
			return
		}
		var req dispatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid body: " + err.Error()})
			return
		}
		if req.UserID == "" || req.Task == "" {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "user_id + task required"})
			return
		}
		timeout := defaultDispatchTimeout
		if req.TimeoutMS > 0 {
			timeout = time.Duration(req.TimeoutMS) * time.Millisecond
			if timeout > maxDispatchTimeout {
				timeout = maxDispatchTimeout
			}
		}

		requestID := newRequestID()
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		rf, err := h.dispatchToUser(ctx, req.UserID, requestID, req.Task, req.Payload)
		if err != nil {
			switch {
			case errors.Is(err, errSidecarOffline):
				writeJSON(w, http.StatusServiceUnavailable, dispatchResponse{
					RequestID: requestID,
					UserID:    req.UserID,
					Task:      req.Task,
					Status:    "error",
					Error:     "sidecar-offline",
				})
			case errors.Is(err, errSidecarTimeout):
				writeJSON(w, http.StatusGatewayTimeout, dispatchResponse{
					RequestID: requestID,
					UserID:    req.UserID,
					Task:      req.Task,
					Status:    "error",
					Error:     "sidecar-timeout",
				})
			case errors.Is(err, errSidecarDisconnect):
				writeJSON(w, http.StatusServiceUnavailable, dispatchResponse{
					RequestID: requestID,
					UserID:    req.UserID,
					Task:      req.Task,
					Status:    "error",
					Error:     "sidecar-disconnect",
				})
			default:
				writeJSON(w, http.StatusInternalServerError, dispatchResponse{
					RequestID: requestID,
					UserID:    req.UserID,
					Task:      req.Task,
					Status:    "error",
					Error:     err.Error(),
				})
			}
			return
		}
		writeJSON(w, http.StatusOK, dispatchResponse{
			RequestID: requestID,
			UserID:    req.UserID,
			Task:      req.Task,
			Status:    rf.Status,
			Body:      rf.Body,
			Receipt:   rf.Receipt,
			Error:     rf.Error,
		})
	}
}

// handleAdminConnections exposes a snapshot of online users + metadata
// for the /admin/ops widget. Auth: same RELAY_DISPATCH_SECRET — only
// web (admin path) ever calls this.
func handleAdminConnections(h *hub, dispatchSecret []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := verifyDispatchAuth(r, dispatchSecret); err != nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: err.Error()})
			return
		}
		snap := h.snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"count":       len(snap),
			"connections": snap,
		})
	}
}

// handleHealth — public, unauthenticated, used by Caddy + the /admin/ops
// widget's reachability probe.
func handleHealth(h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":            "ok",
			"online_users":      len(h.snapshot()),
			"server_time":       time.Now().UTC().Format(time.RFC3339),
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Crypto/rand should never fail; fall back to time-based id.
		return time.Now().UTC().Format("20060102T150405.000000000")
	}
	return hex.EncodeToString(b[:])
}
