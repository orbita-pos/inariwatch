package com.inariwatch.capture;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class DsnTest {

    @Test
    void parsesLocalDsn() {
        Dsn d = Dsn.parse("http://devsecret@localhost:3000/capture/abc");
        assertTrue(d.isLocal);
        assertEquals("abc", d.projectId);
        assertEquals("devsecret", d.secret);
        assertTrue(d.url.endsWith("/api/webhooks/capture/abc"));
    }

    @Test
    void parsesCloudDsn() {
        Dsn d = Dsn.parse("https://prodsecret@app.inariwatch.com/capture/proj42");
        assertFalse(d.isLocal);
        assertEquals("proj42", d.projectId);
        assertTrue(d.url.startsWith("https://"));
    }

    @Test
    void httpRequiresLocalhost() {
        assertThrows(IllegalArgumentException.class,
            () -> Dsn.parse("http://secret@example.com/capture/abc"));
    }

    @Test
    void rejectsMissingSecret() {
        assertThrows(IllegalArgumentException.class,
            () -> Dsn.parse("https://app.inariwatch.com/capture/abc"));
    }

    @Test
    void rejectsMissingProjectId() {
        assertThrows(IllegalArgumentException.class,
            () -> Dsn.parse("https://secret@app.inariwatch.com/capture/"));
    }

    @Test
    void hmacMatchesKnownReference() {
        // openssl-computed HMAC-SHA256("hello", "secret")
        assertEquals(
            "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
            Hmac.signSha256Hex("hello".getBytes(), "secret"));
    }
}
