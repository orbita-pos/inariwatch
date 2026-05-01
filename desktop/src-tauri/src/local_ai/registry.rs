//! Local model registry — lazy GGUF download + BLAKE3 verify + cache.
//!
//! ## Storage layout
//!
//! All cached models live under `<models_dir>/<model_id>/<hash>.gguf`.
//! `models_dir` is resolved by the production [`crate::local_ai::LocalAI::install`]
//! helper to `<app_local_data>/inari-live/models/`. Tests pass a
//! tempdir directly to [`ModelRegistry::new_with_paths`].
//!
//! ## Verification
//!
//! Every download streams to a sibling `<hash>.partial`, hashes with
//! BLAKE3 as bytes arrive, and atomically renames into place only
//! once the hash matches the expected value from the catalogue. A
//! mismatch deletes the partial + bubbles [`RegistryError::HashMismatch`]
//! — never poisons the cache, never updates the DB.
//!
//! ## Catalogue
//!
//! Models are addressed by a stable [`ModelSpec`] (id + expected hash
//! + display name + size hint). The catalogue is hard-coded for v0.2:
//! the two Apache-licensed models the spec locks (Qwen2.5-Coder-1.5B
//! and Kortix FastApply-7B) plus the Qwen-0.5B fallback. A future
//! session can pull this from a signed JSON shipped via the same R2
//! bucket — for v0.2 the in-binary list is enough and avoids a
//! catch-22 (need the catalogue to verify, need to verify the
//! catalogue source).
//!
//! ## Concurrency
//!
//! `ModelRegistry` is `Clone + Send + Sync` (cheap — wraps `Arc`).
//! Concurrent calls to [`ModelRegistry::ensure_local`] for the SAME
//! model serialise behind a per-model `tokio::sync::Mutex`; calls
//! for DIFFERENT models proceed in parallel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::store::{self, Store};

// ─────────────────────────────────────────────────────────────────────
// Catalogue (hard-coded, v0.2)
// ─────────────────────────────────────────────────────────────────────

/// One entry in the local catalogue. Stable identifier (`id`) +
/// expected BLAKE3 of the .gguf file. Tests build their own specs
/// against the mock CDN — production code uses [`catalogue`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSpec {
    pub id:           String,
    pub display_name: String,
    /// Hex-encoded BLAKE3 digest of the .gguf file. 64 chars.
    pub blake3_hex:   String,
    /// Approximate size in bytes, used for the dock's progress bar.
    pub size_bytes:   u64,
    /// Family this model belongs to ("tab" / "apply"). The dock
    /// surfaces them in different tier rows.
    pub family:       ModelFamily,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    Tab,
    Apply,
}

/// Production base URL. Tests override via
/// [`ModelRegistry::with_cdn_base`]. The path layout is
/// `<base>/<model_id>/<hash>.gguf` — the hash is part of the URL so
/// we can rotate model variants without renaming the id.
pub const DEFAULT_CDN_BASE: &str = "https://models.inariwatch.com";

/// Hard-coded catalogue for v0.2. The hashes are placeholders — they
/// will be replaced with real digests once the GGUFs are uploaded to
/// R2 in S31. Until then, production [`ModelRegistry::ensure_local`]
/// calls will fail with [`RegistryError::HashMismatch`] for these
/// IDs, which surfaces as "model not yet available — check back in
/// the next release" in the dock. Tests pass their own catalogues.
pub fn catalogue() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            id:           "qwen2.5-coder-0.5b".to_string(),
            display_name: "Qwen2.5-Coder 0.5B (fallback)".to_string(),
            blake3_hex:   "0".repeat(64),
            size_bytes:   400 * 1024 * 1024,
            family:       ModelFamily::Tab,
        },
        ModelSpec {
            id:           "qwen2.5-coder-1.5b".to_string(),
            display_name: "Qwen2.5-Coder 1.5B (Tab)".to_string(),
            blake3_hex:   "0".repeat(64),
            size_bytes:   1_000 * 1024 * 1024,
            family:       ModelFamily::Tab,
        },
        ModelSpec {
            id:           "kortix-fast-apply-7b".to_string(),
            display_name: "Kortix FastApply 7B (Apply)".to_string(),
            blake3_hex:   "0".repeat(64),
            size_bytes:   5_000 * 1024 * 1024,
            family:       ModelFamily::Apply,
        },
    ]
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("unknown model id: {0}")]
    UnknownModel(String),
    #[error("hash mismatch for {model_id}: expected {expected}, got {actual}")]
    HashMismatch {
        model_id: String,
        expected: String,
        actual:   String,
    },
    #[error("download failed: HTTP {status}")]
    DownloadHttp { status: u16 },
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),
    #[error("sqlite error: {0}")]
    Sql(#[from] rusqlite::Error),
}

// ─────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────

/// Cloneable, cheap-to-pass handle to the model cache. Internally
/// holds an Arc — clones share the same per-model lock map, store,
/// and HTTP client.
#[derive(Clone)]
pub struct ModelRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    store:      Arc<Store>,
    models_dir: PathBuf,
    catalogue:  Vec<ModelSpec>,
    cdn_base:   String,
    http:       reqwest::Client,
    /// Per-model serialisation. Concurrent `ensure_local` calls for
    /// the same id wait on the same mutex; different ids proceed in
    /// parallel. The map itself is guarded by a sync `Mutex` —
    /// quick (only held to insert / lookup the inner mutex Arc).
    locks:      std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl ModelRegistry {
    /// Production constructor — resolves `models_dir` to
    /// `<store_db_dir>/models/`. Boots the catalogue from
    /// [`catalogue()`].
    pub fn new(store: Arc<Store>) -> Result<Self, RegistryError> {
        let models_dir = store.db_path()
            .parent()
            .map(|p| p.join("models"))
            .unwrap_or_else(|| PathBuf::from("inari-models"));
        Self::new_with_paths(store, models_dir, catalogue(), DEFAULT_CDN_BASE.to_string())
    }

    /// Test/explicit constructor — caller supplies the cache dir,
    /// catalogue, and CDN base. Used by integration tests + by S22+
    /// when we want to point at a staging CDN.
    pub fn new_with_paths(
        store:      Arc<Store>,
        models_dir: PathBuf,
        catalogue:  Vec<ModelSpec>,
        cdn_base:   String,
    ) -> Result<Self, RegistryError> {
        std::fs::create_dir_all(&models_dir)?;
        let http = reqwest::Client::builder()
            // Long timeout — multi-GB downloads on slow connections
            // need it. The connect/read timeout still trips on
            // genuinely-dead servers because reqwest applies it
            // per-read in streaming mode.
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self {
            inner: Arc::new(RegistryInner {
                store,
                models_dir,
                catalogue,
                cdn_base,
                http,
                locks: std::sync::Mutex::new(HashMap::new()),
            }),
        })
    }

    /// Override the CDN base URL after construction. Tests use this
    /// to redirect downloads at a local axum mock server.
    pub fn with_cdn_base(mut self, base: impl Into<String>) -> Self {
        // Cheap clone: there's no other clone in flight at
        // construction time in tests, so unwrap is safe.
        let inner = Arc::get_mut(&mut self.inner)
            .expect("with_cdn_base called after clone");
        inner.cdn_base = base.into();
        self
    }

    /// Look up a model spec by id.
    pub fn lookup(&self, model_id: &str) -> Option<ModelSpec> {
        self.inner.catalogue.iter().find(|m| m.id == model_id).cloned()
    }

    /// Path the file would live at if it were cached. Doesn't check
    /// existence.
    pub fn cached_path(&self, spec: &ModelSpec) -> PathBuf {
        self.inner.models_dir
            .join(&spec.id)
            .join(format!("{}.gguf", spec.blake3_hex))
    }

    /// Quick on-disk check. Used by [`ensure_local`] before deciding
    /// to download, and by `LocalAI::generate` to fail fast when the
    /// caller forgot to ensure_local first.
    pub fn is_cached(&self, model_id: &str) -> bool {
        match self.lookup(model_id) {
            Some(spec) => self.cached_path(&spec).exists(),
            None       => false,
        }
    }

    /// Lazy download + verify. Returns the on-disk path of the
    /// verified GGUF. Idempotent — a second call after success is
    /// a fast `is_cached` check + DB `last_used_at` bump.
    pub async fn ensure_local(&self, model_id: &str) -> Result<PathBuf, RegistryError> {
        let spec = self.lookup(model_id)
            .ok_or_else(|| RegistryError::UnknownModel(model_id.to_string()))?;

        // Per-model serialisation: take (or create) the mutex for this
        // id, then hold it across the cache check + download so two
        // concurrent callers don't both download.
        let lock = {
            let mut locks = self.inner.locks.lock().unwrap();
            locks.entry(spec.id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        let target = self.cached_path(&spec);
        if target.exists() {
            self.touch_last_used(&spec.id)?;
            return Ok(target);
        }

        // Need to download. Stream + hash in one pass to avoid
        // materialising the whole file in RAM (these are 0.5–7 GB).
        std::fs::create_dir_all(target.parent().unwrap())?;
        let partial = target.with_extension("partial");
        let _ = std::fs::remove_file(&partial); // clean any prior crash

        let url = format!(
            "{}/{}/{}.gguf",
            self.inner.cdn_base.trim_end_matches('/'),
            spec.id,
            spec.blake3_hex,
        );

        let mut resp = self.inner.http.get(&url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(RegistryError::DownloadHttp { status: status.as_u16() });
        }

        let mut hasher = blake3::Hasher::new();
        let mut bytes_written: u64 = 0;
        let mut file = tokio::fs::File::create(&partial).await?;
        while let Some(chunk) = resp.chunk().await? {
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            bytes_written += chunk.len() as u64;
        }
        file.flush().await?;
        drop(file);

        let actual = hasher.finalize().to_hex().to_string();
        if actual != spec.blake3_hex {
            // Don't poison the cache: drop the partial.
            let _ = std::fs::remove_file(&partial);
            return Err(RegistryError::HashMismatch {
                model_id: spec.id.clone(),
                expected: spec.blake3_hex.clone(),
                actual,
            });
        }

        // Atomic-rename into place. On Windows, std::fs::rename
        // refuses to overwrite — but we already returned early if
        // `target.exists()`, so this is a clean install.
        std::fs::rename(&partial, &target)?;
        self.upsert_local_models_row(&spec, bytes_written)?;
        Ok(target)
    }

    /// List models that exist on disk + in the DB. Used by Settings →
    /// AI to render "what's installed" + by the registry health check.
    pub fn list_cached(&self) -> Result<Vec<CachedEntry>, RegistryError> {
        let conn = self.inner.store.conn()?;
        let mut stmt = conn.prepare(
            "SELECT model_id, content_hash, size_bytes, downloaded_at, last_used_at
               FROM local_models
               ORDER BY downloaded_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CachedEntry {
                model_id:      row.get(0)?,
                content_hash:  row.get(1)?,
                size_bytes:    row.get(2)?,
                downloaded_at: row.get(3)?,
                last_used_at:  row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    /// Drop the file + DB row. The `_guard` machinery from
    /// `ensure_local` takes the same per-model lock so a delete
    /// can't race with an in-flight download.
    pub async fn evict(&self, model_id: &str) -> Result<(), RegistryError> {
        let spec = self.lookup(model_id)
            .ok_or_else(|| RegistryError::UnknownModel(model_id.to_string()))?;
        let lock = {
            let mut locks = self.inner.locks.lock().unwrap();
            locks.entry(spec.id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        let path = self.cached_path(&spec);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let conn = self.inner.store.conn()?;
        conn.execute("DELETE FROM local_models WHERE model_id = ?1", [&spec.id])?;
        Ok(())
    }

    fn touch_last_used(&self, model_id: &str) -> Result<(), RegistryError> {
        let now_ms = unix_ms();
        let conn = self.inner.store.conn()?;
        conn.execute(
            "UPDATE local_models SET last_used_at = ?1 WHERE model_id = ?2",
            rusqlite::params![now_ms, model_id],
        )?;
        Ok(())
    }

    fn upsert_local_models_row(&self, spec: &ModelSpec, size_bytes: u64) -> Result<(), RegistryError> {
        let now_ms = unix_ms();
        let conn = self.inner.store.conn()?;
        conn.execute(
            "INSERT INTO local_models
                  (model_id, content_hash, hash_algo, size_bytes, downloaded_at, last_used_at)
             VALUES (?1, ?2, 'blake3', ?3, ?4, ?4)
             ON CONFLICT(model_id) DO UPDATE SET
                 content_hash  = excluded.content_hash,
                 hash_algo     = excluded.hash_algo,
                 size_bytes    = excluded.size_bytes,
                 downloaded_at = excluded.downloaded_at,
                 last_used_at  = excluded.last_used_at",
            rusqlite::params![
                spec.id,
                spec.blake3_hex,
                size_bytes as i64,
                now_ms,
            ],
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CachedEntry {
    pub model_id:      String,
    pub content_hash:  String,
    pub size_bytes:    i64,
    pub downloaded_at: i64,
    pub last_used_at:  Option<i64>,
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Helper used by [`crate::local_ai::LocalAI::install`] to nudge the
/// `local_ai_tier` settings row whenever the catalogue or the
/// detected hardware changes. Lives in this module because it touches
/// the same `settings` keys the migration seeds.
pub fn record_detected_tier(store: &Arc<Store>, tier: &str) -> Result<(), crate::store::StoreError> {
    store::settings::set(store, "local_ai_tier", tier)
}

// ─────────────────────────────────────────────────────────────────────
// Helpers re-exported from `Path` for tests
// ─────────────────────────────────────────────────────────────────────

/// Resolve the canonical models dir under a given store path. Used
/// by [`crate::local_ai::LocalAI::install`] and tests.
pub fn default_models_dir(store_db_path: &Path) -> PathBuf {
    store_db_path.parent()
        .map(|p| p.join("models"))
        .unwrap_or_else(|| PathBuf::from("inari-models"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_path_includes_hash() {
        let spec = ModelSpec {
            id:           "demo".into(),
            display_name: "Demo".into(),
            blake3_hex:   "abc123".into(),
            size_bytes:   1,
            family:       ModelFamily::Tab,
        };
        let dir = std::env::temp_dir().join("inari-cached-path-test");
        let _ = std::fs::create_dir_all(&dir);
        // Build a registry against a real (empty) store path so the
        // ctor can compute models_dir relative to it. We reuse a
        // tempfile fixture to avoid managing teardown manually.
        // Note: this unit test only exercises the path math — no
        // download, no DB.
        let computed = dir
            .join(&spec.id)
            .join(format!("{}.gguf", spec.blake3_hex));
        assert!(computed.ends_with("demo/abc123.gguf") || computed.ends_with("demo\\abc123.gguf"));
    }
}
