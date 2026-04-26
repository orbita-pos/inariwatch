package com.inariwatch.capture;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ScopeTest {

    @BeforeEach
    void reset() { Scope.clear(); Breadcrumbs.clear(); }

    @Test
    void setUserDoesNotIncludeEmail() {
        Scope.setUser("u1", "admin");
        Map<String, Object> u = Scope.getUser();
        assertEquals("u1", u.get("id"));
        assertEquals("admin", u.get("role"));
        assertNull(u.get("email"));
    }

    @Test
    void redactRequestScrubsHeaders() {
        Map<String, Object> headers = new HashMap<>();
        headers.put("Authorization", "Bearer abc");
        headers.put("X-Auth-Token", "leak");
        headers.put("Accept", "application/json");
        Map<String, Object> req = new HashMap<>();
        req.put("method", "POST");
        req.put("url", "/x");
        req.put("headers", headers);
        Scope.setRequestContext(req);
        @SuppressWarnings("unchecked")
        Map<String, Object> out = (Map<String, Object>) Scope.getRequestContext().get("headers");
        assertEquals("[REDACTED]", out.get("Authorization"));
        assertEquals("[REDACTED]", out.get("X-Auth-Token"));
        assertEquals("application/json", out.get("Accept"));
    }

    @Test
    void breadcrumbRingCapsAt30() {
        for (int i = 0; i < 50; i++) Breadcrumbs.add("test", "crumb-" + i);
        assertEquals(30, Breadcrumbs.get().size());
        assertEquals("crumb-20", Breadcrumbs.get().get(0).get("message"));
        assertEquals("crumb-49", Breadcrumbs.get().get(29).get("message"));
    }

    @Test
    void breadcrumbsScrubBearerTokens() {
        Breadcrumbs.add("http", "GET /x with Authorization: Bearer abcdef");
        String msg = (String) Breadcrumbs.get().get(0).get("message");
        assertTrue(msg.contains("[REDACTED]"));
    }

    @Test
    void redactBodyScrubsNestedSecrets() {
        Map<String, Object> body = new HashMap<>();
        body.put("user", "alice");
        body.put("password", "hunter2");
        Map<String, Object> nested = new HashMap<>();
        nested.put("api_key", "sk_xxx");
        body.put("nested", nested);
        @SuppressWarnings("unchecked")
        Map<String, Object> safe = (Map<String, Object>) Scope.redactBody(body);
        assertEquals("[REDACTED]", safe.get("password"));
        @SuppressWarnings("unchecked")
        Map<String, Object> safeNested = (Map<String, Object>) safe.get("nested");
        assertEquals("[REDACTED]", safeNested.get("api_key"));
        assertEquals("alice", safe.get("user"));
    }
}
