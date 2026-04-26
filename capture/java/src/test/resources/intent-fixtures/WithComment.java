package com.example.api;

/*
 * This block comment mentions `record Foo(int x) {}` but the parser MUST
 * NOT match it — comment stripping is the test invariant here.
 */
// public record CommentedOut(String ignored) {}

public record RealRecord(String name, int count) {}
