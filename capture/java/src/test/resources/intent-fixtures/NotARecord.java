package com.example.api;

// File without records — exercises the cheap pre-filter path.
public final class NotARecord {
    private final String name;
    public NotARecord(String name) { this.name = name; }
    public String name() { return name; }
}
