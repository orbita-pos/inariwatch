// JWT auth for the WS handshake + Bearer auth for /dispatch (server→server).
//
// Per INARI_AI_ARCHITECTURE.md §4.4 (WS Relay Protocol): the user JWT is
// issued by web on Inari Live login and embedded in the WS handshake.
// The relay verifies signature + expiry, extracts user_id, scopes
// the connection. Web → relay /dispatch is authed with a separate shared
// secret (RELAY_DISPATCH_SECRET).
//
// JWT verification is HS256-only and stdlib-only: hmac + sha256 + base64
// + json. We do NOT pull in github.com/golang-jwt/jwt to keep the relay
// dep surface minimal (gorilla/websocket is the only third-party dep).

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var (
	errMissingAuth     = errors.New("missing authorization header")
	errInvalidJWT      = errors.New("invalid jwt")
	errExpiredJWT      = errors.New("expired jwt")
	errBadSignature    = errors.New("bad jwt signature")
	errBadAlgorithm    = errors.New("unsupported jwt algorithm — relay requires HS256")
	errMissingSubject  = errors.New("jwt missing 'sub' claim (user_id)")
	errBadDispatchAuth = errors.New("bad dispatch bearer")
)

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ,omitempty"`
}

type jwtClaims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp,omitempty"`
	Iat int64  `json:"iat,omitempty"`
	Iss string `json:"iss,omitempty"`
	Aud string `json:"aud,omitempty"`
}

// verifyJWT validates an HS256 JWT signed with `key` and returns the
// `sub` claim (the user_id). `now` is injected for tests.
func verifyJWT(token string, key []byte, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errInvalidJWT
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", errInvalidJWT
	}
	var hdr jwtHeader
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		return "", errInvalidJWT
	}
	if hdr.Alg != "HS256" {
		return "", errBadAlgorithm
	}
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	expected := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errInvalidJWT
	}
	if subtle.ConstantTimeCompare(expected, got) != 1 {
		return "", errBadSignature
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errInvalidJWT
	}
	var claims jwtClaims
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		return "", errInvalidJWT
	}
	if claims.Sub == "" {
		return "", errMissingSubject
	}
	if claims.Exp != 0 && now.Unix() >= claims.Exp {
		return "", errExpiredJWT
	}
	return claims.Sub, nil
}

// signJWT is intended for tests + the unit test harness only — production
// signing happens inside the web app. Kept here so relay tests can build a
// valid token without importing jwt libs.
func signJWT(claims jwtClaims, key []byte) string {
	hdr := jwtHeader{Alg: "HS256", Typ: "JWT"}
	hb, _ := json.Marshal(hdr)
	cb, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." +
		base64.RawURLEncoding.EncodeToString(cb)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig
}

// extractBearer pulls the token out of an `Authorization: Bearer ...`
// header. Falls back to a `?token=` query param for the WS handshake on
// browsers that strip Authorization (gorilla/websocket clients support
// custom headers, but the fallback keeps us compatible with non-Rust
// WS clients down the line).
func extractBearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimPrefix(h, "Bearer ")
		}
		if strings.HasPrefix(h, "bearer ") {
			return strings.TrimPrefix(h, "bearer ")
		}
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}

// verifyDispatchAuth checks the Authorization header carries the
// shared-secret bearer that web uses for server→relay /dispatch + admin
// calls. Constant-time compare to defend against timing oracles.
func verifyDispatchAuth(r *http.Request, secret []byte) error {
	if len(secret) == 0 {
		return fmt.Errorf("relay dispatch secret not configured")
	}
	got := extractBearer(r)
	if got == "" {
		return errMissingAuth
	}
	if subtle.ConstantTimeCompare([]byte(got), secret) != 1 {
		return errBadDispatchAuth
	}
	return nil
}
