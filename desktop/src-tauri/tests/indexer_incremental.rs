//! Incremental re-index: changing one symbol's body in a fixture file
//! should only refresh that symbol's row (ast_hash diff). Symbols
//! whose source is byte-identical keep their hash.
//!
//! Doesn't load fastembed — exercises the parse + AST-hash + upsert
//! path through `queries`. Embedding behavior is covered by the
//! ignored `indexer_embed_dim` test.

use inariwatch_desktop_lib::indexer::{compute_ast_hash, parse_file, Lang};
use inariwatch_desktop_lib::store::queries::{
    find_symbol_hash, upsert_repo, upsert_symbol, ExistingSymbol, SymbolRow,
};
use inariwatch_desktop_lib::store::Store;

fn open_store() -> Store {
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("incremental.db");
    let store = Store::open_at(&path).expect("open store");
    // Leak the tempdir so the file outlives the store handle for the
    // duration of the test.
    std::mem::forget(tmp);
    store
}

#[test]
fn ast_hash_changes_only_for_modified_symbols() {
    let store = open_store();
    let _ = upsert_repo(&store, "repoA", "/tmp/repoA", "repoA", 0).unwrap();

    // Round 1 — initial parse.
    let v1 = r#"
function login(u: string) { return u.length > 0; }
function logout() { return true; }
"#;
    let symbols_v1 = parse_file(Lang::TypeScript, v1).expect("parse");
    assert!(symbols_v1.len() >= 2, "expected at least 2 symbols, got {}", symbols_v1.len());

    let mut ids_v1: Vec<(String, i64, String)> = Vec::new();
    for sym in &symbols_v1 {
        let row = SymbolRow {
            repo_id: "repoA",
            file_path: "src/auth.ts",
            symbol_name: &sym.name,
            kind: sym.kind.as_str(),
            line_start: sym.line_start,
            line_end: sym.line_end,
            ast_hash: &sym.ast_hash,
        };
        let id = upsert_symbol(&store, &row).expect("upsert");
        ids_v1.push((sym.name.clone(), id, sym.ast_hash.clone()));
    }
    assert!(!ids_v1.is_empty());

    // Round 2 — modify `login` only. `logout` keeps the same source
    // so its ast_hash should stay identical.
    let v2 = r#"
function login(u: string) { return u.length > 3 && !!u; }
function logout() { return true; }
"#;
    let symbols_v2 = parse_file(Lang::TypeScript, v2).expect("parse v2");

    let login_v2 = symbols_v2.iter().find(|s| s.name == "login").unwrap();
    let logout_v2 = symbols_v2.iter().find(|s| s.name == "logout").unwrap();

    // login's hash MUST differ; logout's MUST match.
    let login_v1_hash = ids_v1.iter().find(|(n, _, _)| n == "login").unwrap().2.clone();
    let logout_v1_hash = ids_v1.iter().find(|(n, _, _)| n == "logout").unwrap().2.clone();

    assert_ne!(login_v2.ast_hash, login_v1_hash, "login body changed → hash should differ");
    assert_eq!(logout_v2.ast_hash, logout_v1_hash, "logout body unchanged → hash must match");

    // Persist v2 and verify the existing-symbol lookup.
    for sym in &symbols_v2 {
        let row = SymbolRow {
            repo_id: "repoA",
            file_path: "src/auth.ts",
            symbol_name: &sym.name,
            kind: sym.kind.as_str(),
            line_start: sym.line_start,
            line_end: sym.line_end,
            ast_hash: &sym.ast_hash,
        };
        upsert_symbol(&store, &row).unwrap();
    }
    let after_login: Option<ExistingSymbol> = find_symbol_hash(
        &store, "repoA", "src/auth.ts", "login", login_v2.line_start,
    ).unwrap();
    let after_logout: Option<ExistingSymbol> = find_symbol_hash(
        &store, "repoA", "src/auth.ts", "logout", logout_v2.line_start,
    ).unwrap();
    assert_eq!(after_login.unwrap().ast_hash, login_v2.ast_hash);
    assert_eq!(after_logout.unwrap().ast_hash, logout_v1_hash);
}

#[test]
fn ast_hash_unchanged_for_pure_whitespace_diff() {
    // Reuses the canonicalization rule the indexer relies on for the
    // skip-re-embed shortcut. If this assertion ever flips, the
    // incremental path will start re-embedding after every save —
    // a perf regression we MUST catch in CI.
    let a = "function x() { return 1; }";
    let b = "function x() { return 1; }   ";
    assert_eq!(compute_ast_hash(a), compute_ast_hash(b));
}
