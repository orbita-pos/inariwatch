//! Tree-sitter parse a Python fixture: `def`, `async def`, `class`
//! → at least 3 symbols (function, function, class) with the class
//! method picked up.

use inariwatch_desktop_lib::indexer::{parse_file, Lang, SymbolKind};

const FIXTURE: &str = r#"
def login(username):
    return len(username) > 0

async def fetch_user(id):
    return None

class AuthService:
    def authenticate(self, token):
        return token == "valid"
"#;

#[test]
fn parses_python_top_level_symbols() {
    let symbols = parse_file(Lang::Python, FIXTURE).expect("parse");
    let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

    assert!(names.contains(&"login"),        "missing `login`: {names:?}");
    assert!(names.contains(&"fetch_user"),   "missing `fetch_user`: {names:?}");
    assert!(names.contains(&"AuthService"),  "missing `AuthService`: {names:?}");
    assert!(names.contains(&"authenticate"), "missing `authenticate`: {names:?}");

    let cls = symbols.iter().find(|s| s.name == "AuthService").unwrap();
    assert_eq!(cls.kind, SymbolKind::Class);

    let method = symbols.iter().find(|s| s.name == "authenticate").unwrap();
    assert_eq!(method.kind, SymbolKind::Method);

    let login = symbols.iter().find(|s| s.name == "login").unwrap();
    assert_eq!(login.kind, SymbolKind::Function);
}
