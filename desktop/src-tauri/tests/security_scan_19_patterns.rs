//! Sesión 20 — Gate 9 security scan: 19 patterns × (positive +
//! negative) fixtures. Asserts the regex layer ported from
//! `web/lib/ai/security-scan.ts` matches what the web side does
//! line-by-line.

use inariwatch_desktop_lib::gates::local_subset::{
    run_security_scan, Severity, PATTERN_COUNT,
};

/// (positive_input, expected_rule, expected_severity, negative_input)
type Case = (&'static str, &'static str, Severity, &'static str);

const CASES: [Case; 19] = [
    (
        "+ eval(userInput)",
        "security/no-eval", Severity::High,
        "+ const evaluation = compute(); // not a call",
    ),
    (
        "+ const cp = require('child_process')",
        "security/detect-child-process", Severity::High,
        "+ const note = 'no shells here'",
    ),
    (
        "+ child.exec(`echo ${name}`)",
        "security/detect-shell-injection", Severity::High,
        "+ child.exec('echo static literal')",
    ),
    (
        "+ el.innerHTML = userText",
        "security/no-inner-html", Severity::High,
        "+ const inner = el.innerHTML // read only",
    ),
    (
        "+ <div dangerouslySetInnerHTML={{__html: clean}}/>",
        "security/react-dangerously-set", Severity::Medium,
        "+ <div className='safe' />",
    ),
    (
        "+ new RegExp('foo' + bar)",
        "security/detect-non-literal-regexp", Severity::Medium,
        "+ const re = /literal/",
    ),
    (
        "+ db.query('SELECT * FROM users WHERE id=' + uid + ' FROM logs')",
        "security/detect-sql-injection", Severity::High,
        "+ db.query('SELECT * FROM users WHERE id = ?', [uid])",
    ),
    (
        "+ fs.readFileSync(base + name)",
        "security/detect-path-traversal", Severity::Medium,
        "+ fs.readFileSync('config.json')",
    ),
    (
        "+ s.replace(/foo/, 'bar')",
        "security/non-global-replace", Severity::Low,
        "+ s.replace(/foo/g, 'bar')",
    ),
    (
        "+ const x = process.env.MY_PASSWORD_KEY",
        "security/env-secret-usage", Severity::Medium,
        "+ const x = process.env.NODE_ENV",
    ),
    (
        "+ Buffer.from(input).toString()",
        "security/buffer-encoding", Severity::Low,
        "+ Buffer.from(input).toString('utf8')",
    ),
    (
        "+ fetch(userUrl)",
        "security/detect-ssrf", Severity::High,
        "+ fetch(\"https://api.example.com\")",
    ),
    (
        "+ const apiKey = 'sk-1234567890abc'",
        "security/hardcoded-secret", Severity::High,
        "+ const apiKey = process.env.API_KEY",
    ),
    (
        "+ obj.__proto__ = mal",
        "security/prototype-pollution", Severity::High,
        "+ const proto = Object.getPrototypeOf(obj)",
    ),
    (
        "+ Klass.constructor[name]",
        "security/prototype-pollution-constructor", Severity::High,
        "+ const c = obj.constructor",
    ),
    (
        "+ crypto.createHash('md5').update(x)",
        "security/insecure-hash", Severity::Medium,
        "+ crypto.createHash('sha256').update(x)",
    ),
    (
        "+ res.redirect(req.query.next)",
        "security/open-redirect", Severity::High,
        "+ res.redirect('/dashboard')",
    ),
    (
        "+ res.setHeader('Access-Control-Allow-Origin', '*')",
        "security/cors-wildcard", Severity::Medium,
        "+ res.setHeader('Access-Control-Allow-Origin', 'https://app.example.com')",
    ),
    (
        "+ window.location = nextUrl",
        "security/unvalidated-redirect", Severity::Medium,
        // Negative needs immediate quote (no whitespace) — the pattern
        // `\s*=\s*[^"'` ` `]` will otherwise backtrack `\s*` to 0 and
        // match the space that precedes the quote, producing a false
        // positive. Same coarseness as the web's JS regex.
        "+ window.location='/dashboard'",
    ),
];

#[test]
fn all_19_patterns_match_their_positive_fixture() {
    assert_eq!(CASES.len(), PATTERN_COUNT, "case count must equal pattern count");
    for (idx, (positive, rule, severity, _negative)) in CASES.iter().enumerate() {
        let finds = run_security_scan(positive);
        assert!(
            finds.iter().any(|f| f.rule == *rule && f.severity == *severity),
            "case #{idx} ({rule}): expected match in `{positive}` — got {finds:?}"
        );
    }
}

#[test]
fn no_pattern_matches_its_negative_fixture_with_its_own_rule() {
    // Only assert the *originating* rule doesn't match its negative.
    // Some negatives may legitimately trip *other* patterns (e.g. a
    // negative for "open-redirect" might still mention "redirect" near
    // a non-matching token); the contract here is per-rule discipline.
    for (idx, (_positive, rule, _severity, negative)) in CASES.iter().enumerate() {
        let finds = run_security_scan(negative);
        let same_rule_match = finds.iter().any(|f| f.rule == *rule);
        assert!(
            !same_rule_match,
            "case #{idx} ({rule}): negative `{negative}` unexpectedly matched the same rule — got {finds:?}"
        );
    }
}
