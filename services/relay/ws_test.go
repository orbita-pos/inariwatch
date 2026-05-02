package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// startTestServer spins up the production handler graph against an
// httptest.Server, registers a single user via WS, and returns the
// hub + client conn for the test to drive.
func startTestServer(t *testing.T, userID string) (*hub, *websocket.Conn, *httptest.Server, []byte) {
	t.Helper()
	jwtKey := deriveJWTKey("test-jwt-key")
	secret := []byte("test-dispatch-secret")
	h := newHub()
	cfg := config{JWTKey: jwtKey, DispatchSecret: secret}
	srv := httptest.NewServer(buildMux(h, cfg))

	tok := signJWT(jwtClaims{
		Sub: userID,
		Exp: time.Now().Add(1 * time.Hour).Unix(),
	}, jwtKey)

	wsURL, _ := url.Parse(srv.URL)
	wsURL.Scheme = "ws"
	wsURL.Path = "/ws"

	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	hdrs := map[string][]string{"Authorization": {"Bearer " + tok}}
	conn, _, err := dialer.Dial(wsURL.String(), hdrs)
	if err != nil {
		srv.Close()
		t.Fatalf("ws dial failed: %v", err)
	}

	// Send register frame.
	regBody, _ := json.Marshal(registerFrame{
		Type:         frameRegister,
		Capabilities: []string{"notify.compose.email", "voice.tts"},
		AppVersion:   "0.3.0-test",
		OS:           "darwin",
		Arch:         "arm64",
	})
	if err := conn.WriteMessage(websocket.TextMessage, regBody); err != nil {
		t.Fatalf("write register: %v", err)
	}

	// Wait for ack to confirm registration.
	if err := waitForAck(conn, 2*time.Second); err != nil {
		t.Fatalf("waiting for ack: %v", err)
	}

	// Spin a few microseconds for hub.register to complete.
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		if _, ok := h.get(userID); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("user never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}

	t.Cleanup(func() {
		_ = conn.Close()
		srv.Close()
	})
	return h, conn, srv, secret
}

func waitForAck(conn *websocket.Conn, timeout time.Duration) error {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	defer conn.SetReadDeadline(time.Time{})
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var probe map[string]any
		if err := json.Unmarshal(msg, &probe); err != nil {
			continue
		}
		if probe["type"] == "ack" {
			return nil
		}
	}
}

func TestWSHandshake_RejectsBadJWT(t *testing.T) {
	jwtKey := deriveJWTKey("real")
	secret := []byte("s")
	h := newHub()
	srv := httptest.NewServer(buildMux(h, config{JWTKey: jwtKey, DispatchSecret: secret}))
	defer srv.Close()

	wrongToken := signJWT(jwtClaims{
		Sub: "u",
		Exp: time.Now().Add(1 * time.Hour).Unix(),
	}, deriveJWTKey("evil"))

	wsURL, _ := url.Parse(srv.URL)
	wsURL.Scheme = "ws"
	wsURL.Path = "/ws"

	hdrs := map[string][]string{"Authorization": {"Bearer " + wrongToken}}
	_, resp, err := websocket.DefaultDialer.Dial(wsURL.String(), hdrs)
	if err == nil {
		t.Fatal("expected dial to fail with bad jwt")
	}
	if resp == nil || resp.StatusCode != 401 {
		gotStatus := -1
		if resp != nil {
			gotStatus = resp.StatusCode
		}
		t.Fatalf("expected 401, got %d (err=%v)", gotStatus, err)
	}
}

func TestWSRegister_TracksCapabilities(t *testing.T) {
	h, _, _, _ := startTestServer(t, "user-A")
	c, ok := h.get("user-A")
	if !ok {
		t.Fatal("hub did not register user")
	}
	if len(c.capabilities) != 2 {
		t.Fatalf("expected 2 capabilities, got %d", len(c.capabilities))
	}
	if c.appVersion != "0.3.0-test" {
		t.Fatalf("expected version captured, got %q", c.appVersion)
	}
}

func TestWSRegister_IgnoresPreRegisterFrames(t *testing.T) {
	jwtKey := deriveJWTKey("test")
	h := newHub()
	srv := httptest.NewServer(buildMux(h, config{JWTKey: jwtKey, DispatchSecret: []byte("s")}))
	defer srv.Close()

	tok := signJWT(jwtClaims{Sub: "u", Exp: time.Now().Add(1 * time.Hour).Unix()}, jwtKey)
	wsURL, _ := url.Parse(srv.URL)
	wsURL.Scheme = "ws"
	wsURL.Path = "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), map[string][]string{"Authorization": {"Bearer " + tok}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Send a response frame before registering — must be ignored.
	bad, _ := json.Marshal(responseFrame{Type: frameResponse, RequestID: "x", Status: "ok"})
	if err := conn.WriteMessage(websocket.TextMessage, bad); err != nil {
		t.Fatalf("write: %v", err)
	}
	// User still not registered.
	if _, ok := h.get("u"); ok {
		t.Fatal("user should not be registered before register frame")
	}
}

func TestDispatch_OnlineUserGetsResponse(t *testing.T) {
	h, conn, srv, secret := startTestServer(t, "user-D")

	// Spin a goroutine that mimics the sidecar: read dispatch, echo
	// back response with body.
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("sidecar read: %v", err)
			return
		}
		var df dispatchFrame
		if err := json.Unmarshal(raw, &df); err != nil {
			t.Errorf("sidecar unmarshal: %v", err)
			return
		}
		body, _ := json.Marshal(map[string]string{"echo": df.Task})
		rf, _ := json.Marshal(responseFrame{
			Type:      frameResponse,
			RequestID: df.RequestID,
			Status:    "ok",
			Body:      body,
		})
		_ = conn.WriteMessage(websocket.TextMessage, rf)
	}()

	// Dispatch HTTP call.
	body := `{"user_id":"user-D","task":"notify.compose.email","payload":{"alert":"x"}}`
	req, _ := newPOST(srv.URL+"/dispatch", body, secret)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var dr dispatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dr.Status != "ok" {
		t.Fatalf("expected status ok, got %q", dr.Status)
	}
	if !strings.Contains(string(dr.Body), "notify.compose.email") {
		t.Fatalf("body did not echo task: %s", string(dr.Body))
	}
	_ = h
	<-done
}

func TestDispatch_OfflineUserReturns503(t *testing.T) {
	jwtKey := deriveJWTKey("k")
	secret := []byte("s")
	h := newHub()
	srv := httptest.NewServer(buildMux(h, config{JWTKey: jwtKey, DispatchSecret: secret}))
	defer srv.Close()

	body := `{"user_id":"ghost","task":"notify.compose.email","payload":{}}`
	req, _ := newPOST(srv.URL+"/dispatch", body, secret)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Fatalf("expected 503, got %d", resp.StatusCode)
	}
	var dr dispatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&dr); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dr.Error != "sidecar-offline" {
		t.Fatalf("expected sidecar-offline, got %q", dr.Error)
	}
}

func TestDispatch_RejectsBadBearer(t *testing.T) {
	jwtKey := deriveJWTKey("k")
	secret := []byte("real-secret")
	h := newHub()
	srv := httptest.NewServer(buildMux(h, config{JWTKey: jwtKey, DispatchSecret: secret}))
	defer srv.Close()

	body := `{"user_id":"u","task":"x","payload":{}}`
	req, _ := newPOST(srv.URL+"/dispatch", body, []byte("WRONG"))
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestDispatch_FallbackOnDisconnect(t *testing.T) {
	h, conn, srv, secret := startTestServer(t, "user-DC")

	// Sidecar reads dispatch, then closes WITHOUT responding.
	go func() {
		_, _, _ = conn.ReadMessage()
		_ = conn.Close()
	}()

	body := `{"user_id":"user-DC","task":"notify.compose.email","payload":{},"timeout_ms":3000}`
	req, _ := newPOST(srv.URL+"/dispatch", body, secret)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	defer resp.Body.Close()
	// Either 503 (sidecar-disconnect) or 504 (sidecar-timeout) is acceptable —
	// both signal "fallback to cloud" to the router.
	if resp.StatusCode != 503 && resp.StatusCode != 504 {
		t.Fatalf("expected 503 or 504 on disconnect, got %d", resp.StatusCode)
	}
	var dr dispatchResponse
	_ = json.NewDecoder(resp.Body).Decode(&dr)
	if dr.Error != "sidecar-disconnect" && dr.Error != "sidecar-timeout" {
		t.Fatalf("expected sidecar-disconnect/timeout, got %q", dr.Error)
	}
	_ = h
}

func TestDispatch_TimeoutWhenSidecarSilent(t *testing.T) {
	_, conn, srv, secret := startTestServer(t, "user-T")

	// Sidecar reads but never replies.
	go func() {
		_, _, _ = conn.ReadMessage()
		// Hold conn open without responding until test cleanup.
	}()

	body := `{"user_id":"user-T","task":"notify.compose.email","payload":{},"timeout_ms":250}`
	req, _ := newPOST(srv.URL+"/dispatch", body, secret)
	start := time.Now()
	resp, err := srv.Client().Do(req)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 504 {
		t.Fatalf("expected 504 on timeout, got %d", resp.StatusCode)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("expected fast timeout, took %s", elapsed)
	}
}

func TestAdminConnections_ListsRegistered(t *testing.T) {
	_, _, srv, secret := startTestServer(t, "user-Adm")
	req, _ := newGET(srv.URL+"/admin/connections", secret)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body struct {
		Count       int                  `json:"count"`
		Connections []connectionSnapshot `json:"connections"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Count != 1 {
		t.Fatalf("expected count=1, got %d", body.Count)
	}
	if body.Connections[0].UserID != "user-Adm" {
		t.Fatalf("expected user-Adm, got %q", body.Connections[0].UserID)
	}
}

// ── tiny request helpers (kept here so tests stay self-contained) ───────

func newPOST(url, body string, bearer []byte) (*http.Request, error) {
	r, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	if len(bearer) > 0 {
		r.Header.Set("Authorization", "Bearer "+string(bearer))
	}
	r.Header.Set("Content-Type", "application/json")
	return r, nil
}

func newGET(url string, bearer []byte) (*http.Request, error) {
	r, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if len(bearer) > 0 {
		r.Header.Set("Authorization", "Bearer "+string(bearer))
	}
	return r, nil
}

// dispatchToUser context-cancellation cover (defensive — the hub's own
// errSidecarTimeout already exercises the timeout path; this case
// covers ctx cancelled by parent before the timer fires).
func TestHub_DispatchContextCancelled(t *testing.T) {
	h, conn, _, _ := startTestServer(t, "user-Ctx")
	go func() {
		_, _, _ = conn.ReadMessage() // discard
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately
	_, err := h.dispatchToUser(ctx, "user-Ctx", "rid", "notify.compose.email", json.RawMessage(`{}`))
	if err != errSidecarTimeout {
		t.Fatalf("expected errSidecarTimeout (ctx cancelled), got %v", err)
	}
}
