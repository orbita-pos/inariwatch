//! Crockford-base32 8-character pairing code.
//!
//! Used by [`super::PairingService::generate`] to issue short, hand-typeable
//! identifiers that flow through SMS / WhatsApp / mobile UIs without
//! collision-prone characters. The alphabet drops the visually-ambiguous
//! `0/O/1/I/L/U` (30 chars total: 8 digits 2-9 + 22 letters A-Z minus
//! I/L/O/U) so a paired user retyping `LO0I`-shaped mistakes is
//! impossible by construction. Total code space at 8 chars is
//! `30^8 ≈ 6.56 × 10^11` — far above the 3-pending-per-workspace
//! ceiling we actually enforce.
//!
//! Codes are case-insensitive on input and uppercase on display. Whitespace
//! and dashes are ignored on parse — `"ABCD-EFGH"`, `"abcdefgh"`,
//! `"  AB CD EF GH  "` all decode identically.
//!
//! ## Why not the official Crockford alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`)?
//!
//! Crockford's spec keeps `0/1` because they're the digits everyone
//! types fastest. Inari Live's pairing flow is verbal/visual (the desktop
//! shows it, the user types it on their phone) — `0` vs `O` and `1` vs
//! `I/L` are misread far more often than they're saved. Dropping all six
//! ambiguous chars (`0`, `O`, `1`, `I`, `L`, `U`) costs us ~10 bits of
//! entropy on an 8-char code, which is fine: the TTL gate (1h) and the
//! 3-pending-max gate are the actual brute-force defenses, not the code
//! length.
//!
//! `U` is dropped on top of Crockford's `IL0O` to discourage the
//! all-too-easy spelled-out "you" misreading on phones.

use std::fmt;

use rand::{rngs::OsRng, Rng};

/// 30 chars: `[2-9] + [A-Z] - {I, L, O, U}`. Lookup-friendly (1 alloc + a
/// `find`) while keeping a tight ASCII range for the printable form.
pub const ALPHABET: &[u8; 30] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Length in characters. Frozen — changing this invalidates every
/// pending row in the DB plus every UI mock-up. If we ever need more
/// entropy we add a v2 table, not a longer column.
pub const CODE_LEN: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodeError {
    #[error("pairing code must be {CODE_LEN} chars after normalisation, got {0}")]
    WrongLength(usize),
    #[error("pairing code contains illegal char {0:?} (Crockford ambiguous chars 0/O/1/I/L/U are not accepted)")]
    BadChar(char),
}

/// New-typed wrapper so we never accidentally pass a raw `String` where a
/// validated code is expected. The internal repr is always normalised
/// (uppercase, no whitespace/dashes); we revalidate on `parse` so a
/// hand-constructed `PairingCode("foo bar")` is impossible.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PairingCode(String);

impl PairingCode {
    /// Generate a fresh random code from a CSPRNG. Each char is sampled
    /// uniformly from [`ALPHABET`]; collisions across two simultaneous
    /// `generate` calls are statistically nil but the `pending_pairings`
    /// UNIQUE-on-`code` constraint is the canonical guard.
    pub fn random() -> Self {
        let mut rng = OsRng;
        let mut buf = String::with_capacity(CODE_LEN);
        for _ in 0..CODE_LEN {
            let idx: usize = rng.gen_range(0..ALPHABET.len());
            buf.push(ALPHABET[idx] as char);
        }
        // We just constructed it — no validation round-trip needed.
        PairingCode(buf)
    }

    /// Parse a user-typed code. Strips ASCII whitespace and `-` so
    /// chunked display formats (`ABCD-EFGH`) round-trip. Case-insensitive.
    pub fn parse(input: &str) -> Result<Self, CodeError> {
        let normalised: String = input
            .chars()
            .filter(|c| !c.is_ascii_whitespace() && *c != '-')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if normalised.len() != CODE_LEN {
            return Err(CodeError::WrongLength(normalised.len()));
        }
        for c in normalised.chars() {
            if !ALPHABET.contains(&(c as u8)) {
                return Err(CodeError::BadChar(c));
            }
        }
        Ok(PairingCode(normalised))
    }

    /// Display in canonical chunked form (`ABCD-EFGH`). The desktop UI
    /// uses this for the pairing modal; the wire/DB format stays
    /// unchunked via [`Self::as_str`].
    pub fn chunked(&self) -> String {
        format!("{}-{}", &self.0[..4], &self.0[4..])
    }

    /// Raw 8-char string for storage / hashing. Stable across encoder
    /// versions because the alphabet is frozen.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Construct from a string already known to be canonical (DB row
    /// load, NDJSON replay). Skips validation. Caller must guarantee the
    /// invariant — if you can't, use [`Self::parse`].
    pub(crate) fn from_canonical(s: String) -> Self {
        debug_assert_eq!(s.len(), CODE_LEN);
        debug_assert!(s.chars().all(|c| ALPHABET.contains(&(c as u8))));
        PairingCode(s)
    }
}

impl fmt::Display for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alphabet_drops_ambiguous_chars() {
        let s = std::str::from_utf8(ALPHABET).unwrap();
        for c in ['0', 'O', '1', 'I', 'L', 'U'] {
            assert!(
                !s.contains(c),
                "ambiguous char {c:?} must not be in alphabet"
            );
        }
        // 8 digits (2-9) + 22 letters (A-Z minus I/L/O/U) = 30
        assert_eq!(ALPHABET.len(), 30);
    }

    #[test]
    fn random_code_has_correct_length_and_alphabet() {
        for _ in 0..32 {
            let c = PairingCode::random();
            assert_eq!(c.as_str().len(), CODE_LEN);
            for ch in c.as_str().chars() {
                assert!(
                    ALPHABET.contains(&(ch as u8)),
                    "{ch} is not in the Crockford alphabet"
                );
            }
        }
    }

    #[test]
    fn parse_accepts_dashes_whitespace_and_lowercase() {
        let raw = PairingCode::random();
        let chunked = raw.chunked();
        assert_eq!(chunked.len(), CODE_LEN + 1);

        // Round-trip via the chunked form.
        let parsed = PairingCode::parse(&chunked).expect("chunked parses");
        assert_eq!(parsed, raw);

        // Lowercase + extra spaces.
        let messy = format!("  {}   ", chunked.to_lowercase());
        let parsed = PairingCode::parse(&messy).expect("messy parses");
        assert_eq!(parsed, raw);
    }

    #[test]
    fn parse_rejects_each_ambiguous_char() {
        // Build a code using a real char and substitute one position
        // with each forbidden char. We pick position 0 for simplicity —
        // every position validates the same.
        for ambiguous in ['0', 'O', '1', 'I', 'L', 'U'] {
            let mut probe = String::from("ABCDEFGH");
            probe.replace_range(..1, &ambiguous.to_string());
            let err = PairingCode::parse(&probe).expect_err("must reject");
            assert!(
                matches!(err, CodeError::BadChar(c) if c == ambiguous),
                "expected BadChar({ambiguous:?}), got {err:?}"
            );
        }
    }

    #[test]
    fn parse_rejects_wrong_length_after_normalisation() {
        let too_short = PairingCode::parse("ABCDEFG").expect_err("short");
        assert!(matches!(too_short, CodeError::WrongLength(7)));
        let too_long = PairingCode::parse("ABCDEFGHJ").expect_err("long");
        assert!(matches!(too_long, CodeError::WrongLength(9)));
        // After stripping whitespace + dashes, the validator counts
        // canonical chars; a long messy input may collapse to a valid
        // length OR not — we test the boundary with no strippable chars.
        let only_strip = PairingCode::parse("---ABCDEFGH").expect("strip ok");
        assert_eq!(only_strip.as_str(), "ABCDEFGH");
    }

    #[test]
    fn chunked_format_inserts_one_dash() {
        let c = PairingCode::from_canonical("ABCDEFGH".to_string());
        assert_eq!(c.chunked(), "ABCD-EFGH");
    }

    #[test]
    fn display_returns_canonical_unchunked_form() {
        let c = PairingCode::from_canonical("ABCDEFGH".to_string());
        assert_eq!(format!("{c}"), "ABCDEFGH");
    }

    #[test]
    fn random_codes_collide_rarely_in_a_small_batch() {
        // Sanity check: 256 random codes produce at most a handful of
        // collisions (basically never). 28^8 ≈ 3.78e11; birthday-paradox
        // expectation at n=256 is ~9e-8. We only assert "no collisions"
        // because seeing one in this test would be a CSPRNG smell.
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        for _ in 0..256 {
            let c = PairingCode::random();
            assert!(seen.insert(c.0), "unexpected collision in 256 samples");
        }
    }
}
