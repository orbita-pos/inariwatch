// inari-relay — WS relay infrastructure for InariWatch's AI router (v0.3 S2).
//
// Per INARI_AI_ARCHITECTURE.md §4 (LOCKED 2026-05-02). This service runs
// alongside the existing Go staging server (:9400) and Node.js worker
// (:9401) on the Hetzner box. Caddy fronts it as
// `wss://relay.inariwatch.com`.
//
// Stateless beyond connection tracking. No payloads logged.

package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	defaultPort    = "9402"
	shutdownGrace  = 10 * time.Second
)

type config struct {
	Addr           string
	JWTKey         []byte
	DispatchSecret []byte
}

func loadConfigFromEnv() (config, error) {
	port := os.Getenv("RELAY_PORT")
	if port == "" {
		port = defaultPort
	}
	addr := os.Getenv("RELAY_ADDR")
	if addr == "" {
		addr = "0.0.0.0:" + port
	}

	rawJWT := os.Getenv("INARI_LIVE_RELAY_JWT_KEY")
	if rawJWT == "" {
		return config{}, errors.New("INARI_LIVE_RELAY_JWT_KEY is required")
	}
	jwtKey := deriveJWTKey(rawJWT)

	dispatch := os.Getenv("RELAY_DISPATCH_SECRET")
	if dispatch == "" {
		return config{}, errors.New("RELAY_DISPATCH_SECRET is required")
	}

	return config{
		Addr:           addr,
		JWTKey:         jwtKey,
		DispatchSecret: []byte(dispatch),
	}, nil
}

// deriveJWTKey hashes the raw seed once with SHA-256 so a short or
// human-readable seed still produces a 32-byte HMAC key. Web's signer
// runs the same derivation (web/lib/relay/jwt.ts).
func deriveJWTKey(raw string) []byte {
	h := sha256.Sum256([]byte("inariwatch-relay-jwt:" + raw))
	return h[:]
}

func main() {
	cfg, err := loadConfigFromEnv()
	if err != nil {
		log.Fatalf("[relay] config: %v", err)
	}

	h := newHub()
	mux := buildMux(h, cfg)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("[relay] listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[relay] listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[relay] shutting down (grace=%s)", shutdownGrace)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[relay] shutdown: %v", err)
	}
}

// buildMux wires routes — extracted so tests share the exact production
// handler graph. The /ws handler is the only public path; everything
// else requires the dispatch bearer.
func buildMux(h *hub, cfg config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth(h))
	mux.HandleFunc("/ws", handleWS(h, cfg.JWTKey))
	mux.HandleFunc("/dispatch", handleDispatch(h, cfg.DispatchSecret))
	mux.HandleFunc("/admin/connections", handleAdminConnections(h, cfg.DispatchSecret))
	return mux
}

// handleWS upgrades the HTTP request to WS after JWT verification.
func handleWS(h *hub, jwtKey []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := extractBearer(r)
		if token == "" {
			http.Error(w, "missing jwt", http.StatusUnauthorized)
			return
		}
		userID, err := verifyJWT(token, jwtKey, time.Now())
		if err != nil {
			// Don't leak which validation step failed — a bad JWT could
			// be a wrong key, expired, or malformed; surface a single
			// 401 with a generic message.
			http.Error(w, "invalid jwt", http.StatusUnauthorized)
			return
		}
		// Optional defence-in-depth: reject obviously malformed user_ids.
		if strings.ContainsAny(userID, " \t\r\n\x00") {
			http.Error(w, "invalid jwt", http.StatusUnauthorized)
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			// Upgrade already wrote the error.
			return
		}
		c := newConnection(h, ws, userID)
		go c.writeLoop()
		c.readLoop()
	}
}
