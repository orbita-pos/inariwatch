package main

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVerifyJWT_Valid(t *testing.T) {
	key := deriveJWTKey("seed-for-tests")
	now := time.Now()
	tok := signJWT(jwtClaims{
		Sub: "user-123",
		Exp: now.Add(1 * time.Hour).Unix(),
	}, key)

	uid, err := verifyJWT(tok, key, now)
	if err != nil {
		t.Fatalf("verifyJWT failed: %v", err)
	}
	if uid != "user-123" {
		t.Fatalf("expected user-123, got %q", uid)
	}
}

func TestVerifyJWT_BadSignature(t *testing.T) {
	key := deriveJWTKey("good")
	wrong := deriveJWTKey("evil")
	now := time.Now()
	tok := signJWT(jwtClaims{Sub: "u", Exp: now.Add(1 * time.Hour).Unix()}, wrong)

	if _, err := verifyJWT(tok, key, now); err != errBadSignature {
		t.Fatalf("expected errBadSignature, got %v", err)
	}
}

func TestVerifyJWT_Expired(t *testing.T) {
	key := deriveJWTKey("seed")
	tok := signJWT(jwtClaims{
		Sub: "u",
		Exp: time.Now().Add(-1 * time.Hour).Unix(),
	}, key)

	if _, err := verifyJWT(tok, key, time.Now()); err != errExpiredJWT {
		t.Fatalf("expected errExpiredJWT, got %v", err)
	}
}

func TestVerifyJWT_BadAlgorithm(t *testing.T) {
	// Forge a header with alg=none — must be rejected.
	// Build manually because signJWT only emits HS256.
	noneToken := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1In0."
	if _, err := verifyJWT(noneToken, []byte("k"), time.Now()); err != errBadAlgorithm {
		t.Fatalf("expected errBadAlgorithm, got %v", err)
	}
}

func TestVerifyJWT_MissingSub(t *testing.T) {
	key := deriveJWTKey("seed")
	tok := signJWT(jwtClaims{Exp: time.Now().Add(1 * time.Hour).Unix()}, key)
	if _, err := verifyJWT(tok, key, time.Now()); err != errMissingSubject {
		t.Fatalf("expected errMissingSubject, got %v", err)
	}
}

func TestVerifyDispatchAuth_Valid(t *testing.T) {
	secret := []byte("super-secret")
	r := httptest.NewRequest("POST", "/dispatch", nil)
	r.Header.Set("Authorization", "Bearer super-secret")
	if err := verifyDispatchAuth(r, secret); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestVerifyDispatchAuth_Wrong(t *testing.T) {
	secret := []byte("super-secret")
	r := httptest.NewRequest("POST", "/dispatch", nil)
	r.Header.Set("Authorization", "Bearer wrong")
	err := verifyDispatchAuth(r, secret)
	if err != errBadDispatchAuth {
		t.Fatalf("expected errBadDispatchAuth, got %v", err)
	}
}

func TestVerifyDispatchAuth_Missing(t *testing.T) {
	secret := []byte("s")
	r := httptest.NewRequest("POST", "/dispatch", nil)
	if err := verifyDispatchAuth(r, secret); err != errMissingAuth {
		t.Fatalf("expected errMissingAuth, got %v", err)
	}
}

func TestExtractBearer_QueryFallback(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws?token=abc.def.ghi", nil)
	if got := extractBearer(r); got != "abc.def.ghi" {
		t.Fatalf("expected query fallback, got %q", got)
	}
}

func TestExtractBearer_HeaderWins(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws?token=querytoken", nil)
	r.Header.Set("Authorization", "Bearer headertoken")
	if got := extractBearer(r); got != "headertoken" {
		t.Fatalf("expected header to win, got %q", got)
	}
}

func TestVerifyJWT_MalformedToken(t *testing.T) {
	key := deriveJWTKey("k")
	// Two parts only.
	if _, err := verifyJWT("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0", key, time.Now()); err != errInvalidJWT {
		t.Fatalf("expected errInvalidJWT, got %v", err)
	}
	// Garbage in middle segment — any rejection error is acceptable;
	// the signature compare fires first (constant-time-friendly), but
	// errInvalidJWT for bad b64 is also fine when the segments parse
	// in a different order on a future refactor.
	garbage := "eyJhbGciOiJIUzI1NiJ9." + strings.Repeat("!", 4) + ".sig"
	if _, err := verifyJWT(garbage, key, time.Now()); err == nil {
		t.Fatalf("expected error for malformed middle segment, got nil")
	}
}
