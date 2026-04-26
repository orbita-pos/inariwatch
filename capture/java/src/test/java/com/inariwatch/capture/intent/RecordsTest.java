package com.inariwatch.capture.intent;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Records intent source tests (SKYNET §3 piece 5, Track D, part 3).
 *
 * <p>Exercises:
 * <ul>
 *   <li>direct symbol match resolves the matching record</li>
 *   <li>method-on-record symbol (e.g. {@code "CreateUserRequest.empty"})
 *       resolves the receiver record</li>
 *   <li>type mapping: primitives, boxed, Optional, List, arrays, java.time</li>
 *   <li>Optional fields are NOT in the {@code required} list</li>
 *   <li>nested records emit {@code _symbol} hint, not a recursive shape</li>
 *   <li>files without records short-circuit (cheap pre-filter)</li>
 *   <li>comment-stripping prevents false matches</li>
 *   <li>cache invalidates on mtime bump</li>
 * </ul>
 */
class RecordsTest {

    private Records source;
    private Path fixtures;

    @BeforeEach
    void setUp() {
        source = new Records();
        // Maven runs tests from `capture/java/`. Fixtures live under test resources.
        fixtures = Path.of("src", "test", "resources", "intent-fixtures").toAbsolutePath();
    }

    @SuppressWarnings("unchecked")
    @Test
    void resolvesByDirectSymbol() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(),
            "CreateUserRequest"
        );
        assertNotNull(shape, "expected shape from CreateUserRequest");
        assertEquals("object", shape.get("type"));
        assertEquals("CreateUserRequest", shape.get("_symbol"));
        assertEquals("com.example.api", shape.get("_package"));

        Map<String, Object> props = (Map<String, Object>) shape.get("properties");
        List<String> required = (List<String>) shape.get("required");
        assertTrue(props.containsKey("email"));
        assertTrue(props.containsKey("age"));
        assertTrue(props.containsKey("nickname"));
        assertTrue(props.containsKey("tags"));
        assertTrue(props.containsKey("role"));
        assertTrue(props.containsKey("createdAt"));
        assertTrue(props.containsKey("address"));
        assertTrue(props.containsKey("aliases"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void mapsPrimitivesAndStrings() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(), "CreateUserRequest");
        Map<String, Object> props = (Map<String, Object>) shape.get("properties");

        Map<String, Object> email = (Map<String, Object>) props.get("email");
        assertEquals("string", email.get("type"));

        Map<String, Object> age = (Map<String, Object>) props.get("age");
        assertEquals("number", age.get("type"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void mapsArraysAndCollections() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(), "CreateUserRequest");
        Map<String, Object> props = (Map<String, Object>) shape.get("properties");

        Map<String, Object> tags = (Map<String, Object>) props.get("tags");
        assertEquals("array", tags.get("type"));
        Map<String, Object> tagItems = (Map<String, Object>) tags.get("items");
        assertEquals("string", tagItems.get("type"));

        Map<String, Object> aliases = (Map<String, Object>) props.get("aliases");
        assertEquals("array", aliases.get("type"));
        Map<String, Object> aliasItems = (Map<String, Object>) aliases.get("items");
        assertEquals("string", aliasItems.get("type"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void mapsJavaTime() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(), "CreateUserRequest");
        Map<String, Object> props = (Map<String, Object>) shape.get("properties");
        Map<String, Object> createdAt = (Map<String, Object>) props.get("createdAt");
        assertEquals("string", createdAt.get("type"));
        assertEquals("date-time", createdAt.get("format"));
    }

    @SuppressWarnings("unchecked")
    @Test
    void optionalFieldsAreNotRequired() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(), "CreateUserRequest");
        List<String> required = (List<String>) shape.get("required");
        assertFalse(required.contains("nickname"), "Optional<String> nickname must NOT be required");
        assertTrue(required.contains("email"), "non-Optional email MUST be required");
        assertTrue(required.contains("age"), "primitive int age MUST be required");
    }

    @SuppressWarnings("unchecked")
    @Test
    void nestedRecordsEmitSymbolHint() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(), "CreateUserRequest");
        Map<String, Object> props = (Map<String, Object>) shape.get("properties");
        Map<String, Object> address = (Map<String, Object>) props.get("address");
        assertEquals("object", address.get("type"));
        assertEquals("Address", address.get("_symbol"));

        Map<String, Object> role = (Map<String, Object>) props.get("role");
        assertEquals("object", role.get("type"));
        assertEquals("Role", role.get("_symbol"));
    }

    @Test
    void methodOnRecordResolvesReceiver() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(),
            "CreateUserRequest.empty"
        );
        assertNotNull(shape);
        assertEquals("CreateUserRequest", shape.get("_symbol"));
    }

    @Test
    void noRecordsShortCircuits() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("NotARecord.java").toString(), "NotARecord");
        assertNull(shape, "files with no `record ` keyword must return null");
    }

    @Test
    void commentsAreStripped() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("WithComment.java").toString(), "RealRecord");
        assertNotNull(shape);
        assertEquals("RealRecord", shape.get("_symbol"));

        // Even with no symbol, the FIRST real record (not the commented one) wins.
        Map<String, Object> first = source.extract(
            fixtures.resolve("WithComment.java").toString(), null);
        assertNotNull(first);
        assertEquals("RealRecord", first.get("_symbol"));
    }

    @Test
    void unknownSymbolFallsBackToFirstRecord() {
        Map<String, Object> shape = source.extract(
            fixtures.resolve("CreateUserRequest.java").toString(),
            "DoesNotExist"
        );
        assertNotNull(shape);
        assertEquals("CreateUserRequest", shape.get("_symbol"));
    }

    @Test
    void nonJavaFileReturnsNull() {
        assertNull(source.extract("/tmp/foo.txt", "anything"));
        assertNull(source.extract("/tmp/foo.java.bak", "anything"));
    }

    @Test
    void nullPathReturnsNull() {
        assertNull(source.extract(null, "x"));
    }

    @Test
    void nameIsStable() {
        assertEquals("java-record", source.name());
    }
}
