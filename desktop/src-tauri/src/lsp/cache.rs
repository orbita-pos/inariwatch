//! LRU completion cache — Sesión 24.
//!
//! Keyed on `(blake3(buffer), byte_offset)`. A hit returns the cached
//! `CompletionItem` JSON in <5 ms (no LocalAI call, no tree-sitter
//! parse, no ranking). A miss falls through to the full pipeline; the
//! handler stores the final result before returning.
//!
//! Sized for typing-on-keystroke workloads:
//! * **Capacity 200.** Each entry is ~200 bytes JSON + 32-byte hash —
//!   ~50 KB resident is fine. After 200 distinct (buffer, position)
//!   tuples the oldest gets evicted; that's roughly the last 30
//!   keystrokes worth of completions on a typical edit session.
//! * **TTL 30 s.** Long pauses (window switch, lunch, hibernation)
//!   invalidate stale entries — the user's mental context likely
//!   shifted and the cached completion would feel "off". Re-firing the
//!   model after 30 s costs one round trip; the cache value beyond 30 s
//!   doesn't justify the staleness risk.
//!
//! The cache is `Send + Sync`; one instance lives on `LspState` and is
//! shared across connections.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Default capacity. Pinned in code (not a const usize on `LspState`)
/// so unit tests in this module can override via `with_capacity`.
pub const DEFAULT_CAPACITY: usize = 200;

/// Default time-to-live for a cached completion. After this, a hit is
/// treated as a miss (and the stale entry evicted).
pub const DEFAULT_TTL: Duration = Duration::from_secs(30);

/// Key derived from the full document text + cursor byte offset.
///
/// We hash with BLAKE3 (already a dep — added in S21 for GGUF
/// integrity). Hashing the full text on every keystroke is acceptable:
/// BLAKE3 measures ~4 GB/s on x86_64-v3 + the typical document is
/// under 100 KB → <30 µs per hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub buffer_hash: [u8; 32],
    pub byte_offset: usize,
}

impl CacheKey {
    pub fn from_text(text: &str, byte_offset: usize) -> Self {
        let h = blake3::hash(text.as_bytes());
        Self { buffer_hash: *h.as_bytes(), byte_offset }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    value:       Value,
    inserted_at: Instant,
}

struct Inner {
    /// Map of key → entry.
    map:      HashMap<CacheKey, Entry>,
    /// Insertion-order queue. Most recent at the back, oldest at the
    /// front. We do NOT promote on hit (this is "FIFO" rather than a
    /// strict LRU); the TTL handles staleness, the FIFO handles
    /// capacity. Same complexity payoff as a hand-rolled doubly-linked
    /// list at this scale (200 entries) without the unsafe code.
    order:    VecDeque<CacheKey>,
    capacity: usize,
    ttl:      Duration,
}

/// Thread-safe completion cache.
///
/// Cloning is cheap — it's a single `Arc<Mutex<...>>` underneath.
#[derive(Clone)]
pub struct CompletionCache {
    inner: std::sync::Arc<Mutex<Inner>>,
}

impl CompletionCache {
    pub fn new() -> Self {
        Self::with_config(DEFAULT_CAPACITY, DEFAULT_TTL)
    }

    pub fn with_config(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(Inner {
                map:      HashMap::with_capacity(capacity.max(1)),
                order:    VecDeque::with_capacity(capacity.max(1)),
                capacity: capacity.max(1),
                ttl,
            })),
        }
    }

    /// Look up a cached completion. Returns `None` on miss OR on a
    /// stale (TTL-expired) entry — stale entries are evicted as a
    /// side effect.
    pub fn get(&self, key: &CacheKey) -> Option<Value> {
        let mut inner = self.inner.lock().expect("CompletionCache mutex poisoned");
        let now = Instant::now();
        let entry = inner.map.get(key)?.clone();
        if now.duration_since(entry.inserted_at) > inner.ttl {
            inner.map.remove(key);
            inner.order.retain(|k| k != key);
            return None;
        }
        Some(entry.value)
    }

    /// Insert a completion. Replaces any existing entry for the same
    /// key, evicts the oldest if at capacity.
    pub fn insert(&self, key: CacheKey, value: Value) {
        let mut inner = self.inner.lock().expect("CompletionCache mutex poisoned");
        if inner.map.contains_key(&key) {
            // Refresh — drop old, re-add at the back of the queue.
            inner.order.retain(|k| k != &key);
        }
        inner.map.insert(key, Entry { value, inserted_at: Instant::now() });
        inner.order.push_back(key);
        while inner.order.len() > inner.capacity {
            if let Some(oldest) = inner.order.pop_front() {
                inner.map.remove(&oldest);
            }
        }
    }

    pub fn len(&self) -> usize {
        let inner = self.inner.lock().expect("CompletionCache mutex poisoned");
        inner.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop all entries. Used by tests; production never calls this.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("CompletionCache mutex poisoned");
        inner.map.clear();
        inner.order.clear();
    }
}

impl Default for CompletionCache {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key_for(text: &str, offset: usize) -> CacheKey {
        CacheKey::from_text(text, offset)
    }

    #[test]
    fn key_derives_from_text_and_offset() {
        let a = key_for("hello", 1);
        let b = key_for("hello", 1);
        let c = key_for("hello", 2);
        let d = key_for("hellp", 1);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }

    #[test]
    fn insert_then_get_returns_value() {
        let cache = CompletionCache::new();
        let k = key_for("fn x() {}", 5);
        cache.insert(k, json!({"items": [{"insertText": "fn add"}]}));
        let got = cache.get(&k).expect("hit");
        assert_eq!(got["items"][0]["insertText"], "fn add");
    }

    #[test]
    fn get_on_miss_is_none() {
        let cache = CompletionCache::new();
        let k = key_for("nothing", 0);
        assert!(cache.get(&k).is_none());
    }

    #[test]
    fn capacity_eviction_drops_oldest() {
        let cache = CompletionCache::with_config(3, Duration::from_secs(60));
        let k1 = key_for("a", 0);
        let k2 = key_for("b", 0);
        let k3 = key_for("c", 0);
        let k4 = key_for("d", 0);
        cache.insert(k1, json!(1));
        cache.insert(k2, json!(2));
        cache.insert(k3, json!(3));
        cache.insert(k4, json!(4));
        assert_eq!(cache.len(), 3);
        // k1 was the oldest → evicted.
        assert!(cache.get(&k1).is_none());
        assert_eq!(cache.get(&k4).unwrap(), json!(4));
    }

    #[test]
    fn ttl_expiry_evicts_stale() {
        let cache = CompletionCache::with_config(8, Duration::from_millis(20));
        let k = key_for("x", 0);
        cache.insert(k, json!("v"));
        std::thread::sleep(Duration::from_millis(40));
        assert!(cache.get(&k).is_none(), "stale entry should be evicted");
        assert_eq!(cache.len(), 0, "stale entry should be removed from map");
    }

    #[test]
    fn re_insert_same_key_refreshes() {
        let cache = CompletionCache::with_config(3, Duration::from_secs(60));
        let k1 = key_for("a", 0);
        let k2 = key_for("b", 0);
        let k3 = key_for("c", 0);
        cache.insert(k1, json!(1));
        cache.insert(k2, json!(2));
        cache.insert(k3, json!(3));
        // Re-insert k1 — should now be the freshest, NOT evicted on
        // the next overflow.
        cache.insert(k1, json!(11));
        let k4 = key_for("d", 0);
        cache.insert(k4, json!(4));
        // k2 should now be the oldest (k1 was refreshed).
        assert!(cache.get(&k2).is_none(), "k2 should be evicted, not k1");
        assert_eq!(cache.get(&k1).unwrap(), json!(11));
        assert_eq!(cache.get(&k4).unwrap(), json!(4));
    }
}
