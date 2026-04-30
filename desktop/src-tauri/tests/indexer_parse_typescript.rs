//! Tree-sitter parse a TS fixture: 3 functions + 1 class with one
//! method should produce 5 symbols (3 functions + 1 class +
//! 1 method).

use inariwatch_desktop_lib::indexer::{parse_file, Lang, SymbolKind};

const FIXTURE: &str = r#"
export function login(username: string): boolean {
    return username.length > 0;
}

function helper(x: number) { return x * 2; }

const register_user = async (email: string): Promise<void> => {
    return;
};

export class AuthService {
    async authenticate(token: string): Promise<boolean> {
        return token === "valid";
    }
}
"#;

#[test]
fn parses_typescript_top_level_symbols() {
    let symbols = parse_file(Lang::TypeScript, FIXTURE).expect("parse");
    let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

    // We expect at least the 3 functions + 1 class + 1 method.
    // Some grammars surface extra `function_signature` nodes for
    // exported/declare keywords; we assert "must contain" rather
    // than exact length to keep the test robust across grammar
    // versions.
    assert!(names.contains(&"login"),         "missing `login`: {names:?}");
    assert!(names.contains(&"helper"),        "missing `helper`: {names:?}");
    assert!(names.contains(&"register_user"), "missing `register_user`: {names:?}");
    assert!(names.contains(&"AuthService"),   "missing `AuthService`: {names:?}");
    assert!(names.contains(&"authenticate"),  "missing `authenticate`: {names:?}");

    let auth_class = symbols
        .iter()
        .find(|s| s.name == "AuthService")
        .expect("AuthService symbol");
    assert_eq!(auth_class.kind, SymbolKind::Class);

    let auth_method = symbols
        .iter()
        .find(|s| s.name == "authenticate")
        .expect("authenticate symbol");
    assert_eq!(auth_method.kind, SymbolKind::Method);

    // line ranges are 1-indexed and `login` lives on line 2 of the
    // fixture (line 1 is empty).
    let login = symbols.iter().find(|s| s.name == "login").unwrap();
    assert!(
        login.line_start >= 2 && login.line_start <= 4,
        "login should be near line 2-4, got {}", login.line_start
    );
    // every symbol has a non-empty source_text + ast_hash.
    for s in &symbols {
        assert!(!s.source_text.is_empty(), "symbol {} has empty source_text", s.name);
        assert_eq!(s.ast_hash.len(), 64, "ast_hash for {} should be sha256 hex", s.name);
    }
}
