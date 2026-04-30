//! Sesión 9 — `installer::scrub_secrets` is the canonical Rust port
//! of the regex the shell hook scripts implement. The scripts each
//! translate the same regex into their host language (sed for
//! zsh/bash, fish's `sed` pipeline). Asserting on the Rust port keeps
//! the spec testable without running an actual shell.

use inariwatch_desktop_lib::sensors::shell::scrub_secrets;

#[test]
fn redacts_classic_env_var_secrets() {
    assert_eq!(
        scrub_secrets("OPENAI_API_KEY=sk-abc123 some-cmd"),
        "OPENAI_API_KEY=*** some-cmd",
    );
    assert_eq!(scrub_secrets("GITHUB_TOKEN=ghp_xyz"), "GITHUB_TOKEN=***");
    assert_eq!(scrub_secrets("AWS_SECRET_ACCESS_KEY=zzz"), "AWS_SECRET_ACCESS_KEY=***");
    assert_eq!(scrub_secrets("DB_PASSWORD=hunter2"), "DB_PASSWORD=***");
    assert_eq!(scrub_secrets("MYSQL_PASSWD=root"), "MYSQL_PASSWD=***");
}

#[test]
fn redacts_bare_keyword_assignment() {
    assert_eq!(scrub_secrets("KEY=raw"),    "KEY=***");
    assert_eq!(scrub_secrets("TOKEN=tok"),  "TOKEN=***");
    assert_eq!(scrub_secrets("SECRET=ssh"), "SECRET=***");
}

#[test]
fn redacts_multiple_secrets_in_one_command() {
    assert_eq!(
        scrub_secrets("FOO=bar OPENAI_API_KEY=sk1 GITHUB_TOKEN=tok1 baz"),
        "FOO=bar OPENAI_API_KEY=*** GITHUB_TOKEN=*** baz",
    );
}

#[test]
fn leaves_innocuous_commands_untouched() {
    assert_eq!(scrub_secrets("ls -la"),       "ls -la");
    assert_eq!(scrub_secrets("npm install"),  "npm install");
    assert_eq!(scrub_secrets("git status"),   "git status");
    assert_eq!(scrub_secrets("FOO=bar baz"),  "FOO=bar baz");
}

#[test]
fn lower_case_substring_is_documented_miss() {
    // Documented limitation in resources/shell/README.md — the regex
    // intentionally only matches uppercase-substring keywords.
    // Convention is upper-snake env var names; lowercase slips
    // through. This test pins the documented behavior so a future
    // change to the regex surfaces in code review.
    assert_eq!(scrub_secrets("my_token=foo"), "my_token=foo");
    assert_eq!(scrub_secrets("api_key=foo"),  "api_key=foo");
}
