package com.example.api;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import jakarta.validation.constraints.NotNull;

/**
 * A handler DTO — the kind of thing a Spring controller would bind via
 * {@code @RequestBody}. Used by the records intent source test fixtures.
 */
public record CreateUserRequest(
    @NotNull String email,
    int age,
    Optional<String> nickname,
    List<String> tags,
    Role role,
    Instant createdAt,
    Address address,
    String[] aliases
) {
    public enum Role { ADMIN, MEMBER }
    public record Address(String street, String city, Optional<String> zip) {}

    // A non-record method — should be ignored by the parser.
    public static CreateUserRequest empty() {
        return new CreateUserRequest("", 0, Optional.empty(), List.of(), Role.MEMBER, Instant.EPOCH, null, new String[0]);
    }
}
