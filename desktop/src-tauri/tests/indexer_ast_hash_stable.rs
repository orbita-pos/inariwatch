//! AST-hash stability: same source → same hash; whitespace-only diffs
//! collapse to the same hash (the canonicalization trims trailing
//! whitespace per line and joins with `\n`).

use inariwatch_desktop_lib::indexer::compute_ast_hash;

#[test]
fn deterministic_for_same_input() {
    let a = "fn hello() { println!(\"hi\"); }";
    let h1 = compute_ast_hash(a);
    let h2 = compute_ast_hash(a);
    assert_eq!(h1, h2, "hash must be deterministic");
    assert_eq!(h1.len(), 64, "sha256 hex should be 64 chars");
}

#[test]
fn trailing_whitespace_does_not_change_hash() {
    let a = "fn x() { 1 }";
    let b = "fn x() { 1 }   ";
    assert_eq!(
        compute_ast_hash(a),
        compute_ast_hash(b),
        "trailing whitespace should canonicalize away"
    );
}

#[test]
fn line_ending_differences_do_not_change_hash() {
    let a = "fn a() {\n    1\n}\n";
    let b = "fn a() {\r\n    1\r\n}\r\n";
    assert_eq!(
        compute_ast_hash(a),
        compute_ast_hash(b),
        "CRLF vs LF should canonicalize to the same hash"
    );
}

#[test]
fn different_content_produces_different_hash() {
    let h1 = compute_ast_hash("fn a() { 1 }");
    let h2 = compute_ast_hash("fn a() { 2 }");
    assert_ne!(h1, h2, "different bodies → different hashes");
}
