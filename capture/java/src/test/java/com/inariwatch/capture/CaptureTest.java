package com.inariwatch.capture;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class CaptureTest {

    static class Recording implements Transport.Sender {
        final List<ErrorEvent> events = new ArrayList<>();
        @Override public void send(ErrorEvent ev) { events.add(ev); }
    }

    Recording fresh() {
        Capture.resetForTesting();
        Capture.init(new Config().silent(true).environment("test"));
        Recording r = new Recording();
        Capture.setSenderForTesting(r);
        return r;
    }

    @BeforeEach
    void clear() { Scope.clear(); Breadcrumbs.clear(); }

    @Test
    void capturesRuntimeAndFingerprint() {
        Recording r = fresh();
        Capture.captureException(new IllegalStateException("boom"), null);
        assertEquals(1, r.events.size());
        ErrorEvent ev = r.events.get(0);
        assertEquals("java", ev.runtime);
        assertEquals("error", ev.eventType);
        assertEquals(64, ev.fingerprint.length());
        assertTrue(ev.title.contains("boom"));
    }

    @Test
    void captureMessageRecordsSeverity() {
        Recording r = fresh();
        Capture.captureMessage("disk almost full", "warning");
        assertEquals("warning", r.events.get(0).severity);
    }

    @Test
    void beforeSendCanDropEvent() {
        Capture.resetForTesting();
        Recording r = new Recording();
        Capture.init(new Config().silent(true).beforeSend(ev -> null));
        Capture.setSenderForTesting(r);
        Capture.captureException(new IllegalStateException("nope"), null);
        assertEquals(0, r.events.size());
    }

    @Test
    void uninitializedIsNoOp() {
        Capture.resetForTesting();
        // Must not throw.
        Capture.captureException(new IllegalStateException("ignored"), null);
    }

    @Test
    void captureLogPropagatesMetadata() {
        Recording r = fresh();
        Map<String, Object> meta = new HashMap<>();
        meta.put("attempt", 3);
        Capture.captureLog("retry exhausted", "error", meta);
        assertEquals("log", r.events.get(0).eventType);
        assertEquals(3, r.events.get(0).metadata.get("attempt"));
    }
}
