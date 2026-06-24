//! Indexer worker — bootstrap + incremental indexing pipeline.
//!
//! Reads a file, parses it, decides which symbols are new / changed,
//! embeds them in batches, and persists to the store. Called from
//! [`super::spawn_indexer`] for both `RepoIndexed` (bootstrap) and
//! `FsChange::Modified|Created` (incremental).
//!
//! The bootstrap path walks the repo with the same `ignore` config
//! the FS sensor used. Re-walking pays IO twice, but this is the only
//! sensor → sensor coupling we avoid; see `INARI_LIVE_DECISIONS.md`
//! "Sesión 6 — re-walk vs path cache".
//!
//! All code that touches the embedder runs synchronously here — the
//! caller is responsible for `spawn_blocking` so the async runtime
//! isn't starved.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::sensors::fs::watcher::walk_for_indexer;
use crate::sensors::fs::WalkResult;
use crate::store::{queries, Store};
use crate::store::queries::SymbolRow;

use super::embeddings::{embed_batch, EMBEDDING_DIM};
use super::error::Result;
use super::lang::detect_from_path;
use super::parser::{parse_file, Symbol};

/// Hard cap on the file size we attempt to parse, bytes. Larger files
/// are silently skipped — they're almost always vendored bundles or
/// minified output. 1MB matches GitHub's "file too large to display"
/// threshold.
pub const MAX_FILE_BYTES: u64 = 1_024 * 1_024;

/// Soft cap on a single embed batch. Matches
/// `embeddings::MAX_BATCH_SIZE` — kept here so we can flush early on
/// time-pressure in the incremental path without loading the
/// embedder constant.
pub const BATCH_FLUSH_SIZE: usize = 64;

/// Maximum wall-clock to accumulate symbols before flushing the batch
/// (regardless of batch size). Keeps incremental updates snappy on
/// rapid saves.
pub const BATCH_FLUSH_WINDOW: Duration = Duration::from_millis(100);

/// Outcome of a bootstrap. Surfaced via the `SymbolsIndexed` event.
pub struct BootstrapResult {
    pub symbol_count: u64,
    pub duration_ms:  u64,
}

/// Full repo bootstrap. Walks the repo, parses every supported file,
/// upserts symbols, embeds new/changed ones, and writes the
/// embeddings. Errors per file are logged and skipped — a single
/// malformed file never aborts the bootstrap.
pub fn bootstrap_repo(
    store:    &Arc<Store>,
    repo_id:  &str,
    repo_root: &Path,
) -> Result<BootstrapResult> {
    let start = Instant::now();

    let WalkResult { paths, .. } = walk_for_indexer(repo_root);
    tracing::info!(
        repo_id = %repo_id,
        candidates = paths.len(),
        "indexer: bootstrap walk"
    );

    let mut pending: PendingBatch = PendingBatch::new();
    for abs_path in paths {
        // detect_from_path returns None for unsupported extensions —
        // walker doesn't pre-filter so the indexer is the gate.
        let lang = match detect_from_path(&abs_path) {
            Some(l) => l,
            None    => continue,
        };

        let rel = relative_to(repo_root, &abs_path);
        match index_one_file(store, repo_id, &abs_path, &rel, lang, &mut pending) {
            Ok(_)  => {}
            Err(e) => tracing::warn!(
                repo_id = %repo_id,
                file    = %rel,
                error   = %e,
                "indexer: file skipped"
            ),
        }

        if pending.len() >= BATCH_FLUSH_SIZE {
            if let Err(e) = pending.flush(store) {
                tracing::warn!(repo_id = %repo_id, error = %e, "indexer: batch flush failed");
            }
        }
    }
    if let Err(e) = pending.flush(store) {
        tracing::warn!(repo_id = %repo_id, error = %e, "indexer: final batch flush failed");
    }

    let symbol_count = queries::count_symbols_for_repo(store, repo_id)?;
    Ok(BootstrapResult {
        symbol_count,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// Incremental update for a single file (FsChange::Modified or
/// Created). Re-parses the file, diffs symbols against the DB, and
/// embeds only the symbols whose AST hash actually changed. Returns
/// the number of embeddings written this call (0 = no-op,
/// useful for tests).
pub fn reindex_file(
    store:     &Arc<Store>,
    repo_id:   &str,
    repo_root: &Path,
    abs_path:  &Path,
) -> Result<u64> {
    let lang = match detect_from_path(abs_path) {
        Some(l) => l,
        None    => return Ok(0),
    };
    let rel = relative_to(repo_root, abs_path);
    let mut pending = PendingBatch::new();
    index_one_file(store, repo_id, abs_path, &rel, lang, &mut pending)?;
    let written = pending.symbols.len() as u64;
    pending.flush(store)?;
    Ok(written)
}

/// Delete every symbol + embedding for `(repo_id, rel_path)`. Used
/// for `FsChange::Deleted`.
pub fn delete_file(
    store:     &Arc<Store>,
    repo_id:   &str,
    repo_root: &Path,
    abs_path:  &Path,
) -> Result<u64> {
    let rel = relative_to(repo_root, abs_path);
    Ok(queries::delete_symbols_for_file(store, repo_id, &rel)?)
}

// ── Internals ────────────────────────────────────────────────────────────────

struct PendingBatch {
    symbol_ids: Vec<i64>,
    symbols:    Vec<String>, // source_text per pending symbol
}

impl PendingBatch {
    fn new() -> Self {
        Self {
            symbol_ids: Vec::with_capacity(BATCH_FLUSH_SIZE),
            symbols:    Vec::with_capacity(BATCH_FLUSH_SIZE),
        }
    }

    fn len(&self) -> usize {
        self.symbol_ids.len()
    }

    fn push(&mut self, id: i64, source_text: String) {
        self.symbol_ids.push(id);
        self.symbols.push(source_text);
    }

    fn flush(&mut self, store: &Arc<Store>) -> Result<()> {
        if self.symbols.is_empty() {
            return Ok(());
        }
        let vectors = match embed_batch(&self.symbols) {
            Ok(v)  => v,
            Err(e) => {
                // ModelLoad / Embedding errors collapse the batch;
                // don't poison subsequent calls.
                self.symbol_ids.clear();
                self.symbols.clear();
                return Err(e);
            }
        };
        debug_assert_eq!(vectors.len(), self.symbol_ids.len());

        for (id, vec) in self.symbol_ids.iter().zip(vectors.iter()) {
            // `vec` is `&[f32; 384]`; queries expects `&[f32]`.
            let _: usize = EMBEDDING_DIM; // compile-time cross-check
            queries::upsert_embedding(store, *id, vec.as_slice())?;
        }
        self.symbol_ids.clear();
        self.symbols.clear();
        Ok(())
    }
}

fn index_one_file(
    store:    &Arc<Store>,
    repo_id:  &str,
    abs_path: &Path,
    rel_path: &str,
    lang:     super::lang::Lang,
    pending:  &mut PendingBatch,
) -> Result<()> {
    let meta = std::fs::metadata(abs_path)?;
    if meta.len() > MAX_FILE_BYTES {
        tracing::debug!(file = %rel_path, size = meta.len(), "indexer: skipping large file");
        return Ok(());
    }
    let source = std::fs::read_to_string(abs_path)?;
    let symbols: Vec<Symbol> = parse_file(lang, &source)?;

    for sym in symbols {
        let row = SymbolRow {
            repo_id,
            file_path:   rel_path,
            symbol_name: &sym.name,
            kind:        sym.kind.as_str(),
            line_start:  sym.line_start,
            line_end:    sym.line_end,
            ast_hash:    &sym.ast_hash,
        };
        // Skip re-embedding if hash is unchanged — the upsert still
        // refreshes line_end / kind so the table stays consistent.
        let prior = queries::find_symbol_hash(
            store, repo_id, rel_path, &sym.name, sym.line_start,
        )?;
        let id = queries::upsert_symbol(store, &row)?;
        let unchanged = prior
            .as_ref()
            .map(|p| p.ast_hash == sym.ast_hash)
            .unwrap_or(false);
        if !unchanged {
            pending.push(id, sym.source_text);
        }
    }
    Ok(())
}

/// Compute `code_symbols.file_path` form: forward slashes, relative
/// to the repo root. If the file is somehow OUTSIDE the repo root
/// (shouldn't happen — the walker only emits children) we fall back
/// to the absolute path so we never crash.
fn relative_to(repo_root: &Path, abs_path: &Path) -> String {
    let rel: PathBuf = abs_path
        .strip_prefix(repo_root)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|_| abs_path.to_path_buf());
    let mut s = String::with_capacity(rel.as_os_str().len());
    for (i, comp) in rel.components().enumerate() {
        if i > 0 { s.push('/'); }
        if let Some(c) = comp.as_os_str().to_str() {
            s.push_str(c);
        }
    }
    s
}
