package com.inariwatch.capture;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Cross-language fingerprint conformance.
 *
 * Loads the same {@code shared/fingerprint-test-vectors.json} that every
 * other SDK consumes. If any vector diverges this SDK has drifted from
 * the canonical algorithm — do not regenerate the vectors unless every
 * implementation is being updated in the same PR.
 */
class FingerprintGoldenVectorsTest {

    private static Path repoRoot() {
        // capture/java/  ->  ../../  =>  repo root
        return Path.of(System.getProperty("user.dir")).resolve("..").resolve("..").normalize();
    }

    @Test
    void crossLanguageGoldenVectors() throws Exception {
        Path vectorsFile = repoRoot().resolve("shared").resolve("fingerprint-test-vectors.json");
        String raw = Files.readString(vectorsFile);
        JsonNode parsed = new ObjectMapper().readTree(raw);
        JsonNode vectors = parsed.get("vectors");
        StringBuilder failures = new StringBuilder();
        int total = 0;
        for (JsonNode v : vectors) {
            total++;
            String got = Fingerprint.computeErrorFingerprint(
                v.get("title").asText(), v.get("body").asText());
            String expected = v.get("expected").asText();
            if (!expected.equals(got)) {
                failures.append(v.get("id").asText())
                    .append(": expected ")
                    .append(expected)
                    .append(" got ")
                    .append(got)
                    .append('\n');
            }
        }
        assertEquals(0, failures.length(), failures.toString());
        assertTrue(total >= 20, "expected 20+ vectors, found " + total);
    }

    @Test
    void sameInputSameHash() {
        assertEquals(
            Fingerprint.computeErrorFingerprint("Err", "stack"),
            Fingerprint.computeErrorFingerprint("Err", "stack"));
    }

    @Test
    void uuidNormalised() {
        String a = Fingerprint.computeErrorFingerprint(
            "Err", "user 550e8400-e29b-41d4-a716-446655440000 not found");
        String b = Fingerprint.computeErrorFingerprint(
            "Err", "user 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found");
        assertEquals(a, b);
    }
}
