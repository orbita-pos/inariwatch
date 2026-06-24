//! Filesystem-backed skill discovery for the Inari Live agent.
//!
//! Layout under `~/.inari/workspace/skills/`:
//!
//! ```text
//!   ~/.inari/workspace/skills/
//!     ├── triage/
//!     │   ├── SKILL.md       # required: skill body, first non-empty line = description
//!     │   ├── manifest.json  # required: { version, default_permission, required_tools? }
//!     │   ├── AGENTS.md      # optional: system prompt for the skill
//!     │   └── TOOLS.md       # optional: documentation of expected tools
//!     └── postmortem/
//!         └── …
//! ```
//!
//! The directory name is the skill's stable id (validated `[a-z0-9_-]+`).
//! The loader emits a [`SkillEvent`] for every directory it inspects —
//! `Loaded` on success, `Rejected` with a human-readable reason on
//! failure. Surface those to the desktop UI (Settings → Skills) so users
//! debug their own skills without digging in logs.
//!
//! The OpenClaw skill loader is the explicit anti-pattern here: it
//! silently drops malformed skills with no audit trail, leaving the
//! user to wonder why their skill isn't being offered. We do better.

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use super::PermissionLevel;

/// Debounce window for the watcher. 250ms collapses save-storms (an
/// editor's "save → format → save" round-trip typically lands within
/// 100ms) into one reload pass.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// One discovered skill. The `Sha256` digest of (manifest.json +
/// SKILL.md + AGENTS.md + TOOLS.md) lives in `content_hash` so the
/// hot-reload diff can distinguish "user saved with no real change"
/// from "user actually edited something".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub manifest: SkillManifest,
    pub root: PathBuf,
    pub agents_md: Option<String>,
    pub tools_md: Option<String>,
    /// Hex sha256 of the concatenated skill files. Used by the hot-
    /// reload diff to suppress no-op reloads.
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillManifest {
    pub version: String,
    pub default_permission: PermissionLevel,
    /// Optional list of `ChatTool.name`s this skill expects to be
    /// available in the registry. Loader does not error if missing —
    /// the chat surface (S6) may resolve them lazily.
    #[serde(default)]
    pub required_tools: Vec<String>,
}

/// Diagnostic events emitted during skill loading. Surface these in
/// the desktop UI so users debug their own skills without having to
/// dig in logs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkillEvent {
    Loaded { name: String, root: PathBuf },
    Rejected { root: PathBuf, reason: String },
    Reloaded { name: String, root: PathBuf },
    Removed { name: String, root: PathBuf },
}

#[derive(Debug, thiserror::Error)]
pub enum SkillLoaderError {
    #[error("io: {0}")]
    Io(String),
    #[error("watcher: {0}")]
    Watcher(String),
}

/// Discovers skills under `<workspace_root>/skills/<name>/`. Holds the
/// last successful load in memory so [`Self::reload`] can diff and emit
/// `Loaded` / `Reloaded` / `Removed` events.
pub struct SkillLoader {
    workspace_root: PathBuf,
    events_tx: mpsc::Sender<SkillEvent>,
    loaded: Mutex<HashMap<String, Skill>>,
}

impl SkillLoader {
    pub fn new(workspace_root: PathBuf, events_tx: mpsc::Sender<SkillEvent>) -> Self {
        Self {
            workspace_root,
            events_tx,
            loaded: Mutex::new(HashMap::new()),
        }
    }

    /// Convenience: workspace_root = `<home>/.inari/workspace/`.
    pub fn default_workspace(events_tx: mpsc::Sender<SkillEvent>) -> Option<Self> {
        let home = dirs::home_dir()?;
        Some(Self::new(home.join(".inari").join("workspace"), events_tx))
    }

    /// `<workspace_root>/skills/`. Used by the watcher and by tests.
    pub fn skills_dir(&self) -> PathBuf {
        self.workspace_root.join("skills")
    }

    /// Walk `<workspace>/skills/*/SKILL.md`, parse, validate, return
    /// the loaded skills. Each rejected directory emits one
    /// [`SkillEvent::Rejected`] with a human-readable reason.
    pub fn load_all(&self) -> Vec<Skill> {
        let dir = self.skills_dir();
        if !dir.exists() {
            return Vec::new();
        }

        let mut skills = Vec::new();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                self.send(SkillEvent::Rejected {
                    root: dir,
                    reason: format!("read skills dir: {e}"),
                });
                return Vec::new();
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(skill) = self.load_one(path) {
                skills.push(skill);
            }
        }
        // Cache the load so future `reload()` calls can diff. Replace —
        // this is the new SSOT.
        if let Ok(mut cache) = self.loaded.lock() {
            *cache = skills.iter().map(|s| (s.name.clone(), s.clone())).collect();
        }
        skills
    }

    /// Load one skill from a known directory. Returns `None` on
    /// rejection and emits one [`SkillEvent::Rejected`] / [`SkillEvent::Loaded`].
    pub fn load_one(&self, dir: PathBuf) -> Option<Skill> {
        match self.try_parse_skill(&dir) {
            Ok(skill) => {
                self.send(SkillEvent::Loaded {
                    name: skill.name.clone(),
                    root: skill.root.clone(),
                });
                Some(skill)
            }
            Err(reason) => {
                self.send(SkillEvent::Rejected {
                    root: dir,
                    reason,
                });
                None
            }
        }
    }

    /// Re-run [`Self::load_all`] and emit the diff against the prior
    /// successful load — `Reloaded` for skills that survived,
    /// `Loaded` for new arrivals, `Removed` for departures. Called by
    /// the watcher thread; useful in tests too.
    pub fn reload(&self) -> Vec<Skill> {
        let prior = self
            .loaded
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default();

        // Walk the dir but DO NOT emit Loaded/Rejected through `load_all`
        // — we want to dedupe events when the content didn't change.
        // Re-implement the walk here so we keep full control of event
        // emission.
        let dir = self.skills_dir();
        let mut now: HashMap<String, Skill> = HashMap::new();
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    match self.try_parse_skill(&path) {
                        Ok(skill) => {
                            now.insert(skill.name.clone(), skill);
                        }
                        Err(reason) => {
                            // Reject events still fire on every reload —
                            // the user wants feedback when their broken
                            // skill stays broken.
                            self.send(SkillEvent::Rejected {
                                root: path,
                                reason,
                            });
                        }
                    }
                }
            }
        }

        // Diff prior vs now.
        for (name, skill) in &now {
            match prior.get(name) {
                None => self.send(SkillEvent::Loaded {
                    name: name.clone(),
                    root: skill.root.clone(),
                }),
                Some(old) if old.content_hash != skill.content_hash => {
                    self.send(SkillEvent::Reloaded {
                        name: name.clone(),
                        root: skill.root.clone(),
                    });
                }
                Some(_) => { /* no-op: identical content */ }
            }
        }
        for (name, skill) in &prior {
            if !now.contains_key(name) {
                self.send(SkillEvent::Removed {
                    name: name.clone(),
                    root: skill.root.clone(),
                });
            }
        }

        if let Ok(mut cache) = self.loaded.lock() {
            *cache = now.clone();
        }
        now.into_values().collect()
    }

    /// Hot reload via filesystem watcher. Spawns a background thread
    /// that owns the [`Debouncer`] and re-runs [`Self::reload`] on
    /// every debounced delivery. Drop the returned [`WatcherHandle`]
    /// to stop watching.
    pub fn watch(self: Arc<Self>) -> Result<WatcherHandle, SkillLoaderError> {
        let dir = self.skills_dir();
        std::fs::create_dir_all(&dir).map_err(|e| SkillLoaderError::Io(e.to_string()))?;

        let (tx, rx) = mpsc::channel::<DebounceEventResult>();
        let mut debouncer = new_debouncer(WATCH_DEBOUNCE, tx)
            .map_err(|e| SkillLoaderError::Watcher(e.to_string()))?;
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| SkillLoaderError::Watcher(e.to_string()))?;

        let loader = self.clone();
        let join = std::thread::Builder::new()
            .name("inari-skill-watch".into())
            .spawn(move || {
                while let Ok(result) = rx.recv() {
                    if result.is_err() {
                        // Notify backend hiccups (e.g. inotify limit) —
                        // log + keep listening.
                        continue;
                    }
                    let _ = loader.reload();
                }
            })
            .map_err(|e| SkillLoaderError::Io(e.to_string()))?;

        Ok(WatcherHandle {
            _debouncer: debouncer,
            _join: Some(join),
        })
    }

    fn try_parse_skill(&self, dir: &Path) -> Result<Skill, String> {
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "skill directory has no UTF-8 name".to_string())?
            .to_string();
        if !is_valid_skill_name(&name) {
            return Err(format!(
                "invalid skill name `{name}` (must match [a-z0-9_-]+)"
            ));
        }

        let skill_md_path = dir.join("SKILL.md");
        let manifest_path = dir.join("manifest.json");

        if !skill_md_path.exists() {
            return Err("missing SKILL.md".into());
        }
        if !manifest_path.exists() {
            return Err("missing manifest.json".into());
        }

        let skill_md =
            std::fs::read_to_string(&skill_md_path).map_err(|e| format!("read SKILL.md: {e}"))?;
        let manifest_str = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("read manifest.json: {e}"))?;
        let manifest: SkillManifest = serde_json::from_str(&manifest_str)
            .map_err(|e| format!("parse manifest.json: {e}"))?;

        let agents_md = read_optional(&dir.join("AGENTS.md"))?;
        let tools_md = read_optional(&dir.join("TOOLS.md"))?;

        let description = first_meaningful_line(&skill_md);
        let content_hash = hash_skill_files(&manifest_str, &skill_md, &agents_md, &tools_md);

        Ok(Skill {
            name,
            description,
            manifest,
            root: dir.to_path_buf(),
            agents_md,
            tools_md,
            content_hash,
        })
    }

    fn send(&self, event: SkillEvent) {
        let _ = self.events_tx.send(event);
    }
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("read {}: {e}", path.display()))
}

fn first_meaningful_line(content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Strip up to N leading `#` and one space — Markdown title.
        let no_hash = trimmed.trim_start_matches('#').trim_start();
        if no_hash.is_empty() {
            continue;
        }
        return no_hash.to_string();
    }
    String::new()
}

fn hash_skill_files(
    manifest: &str,
    skill_md: &str,
    agents_md: &Option<String>,
    tools_md: &Option<String>,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"manifest:");
    hasher.update(manifest.as_bytes());
    hasher.update(b"\nskill:");
    hasher.update(skill_md.as_bytes());
    hasher.update(b"\nagents:");
    if let Some(s) = agents_md {
        hasher.update(s.as_bytes());
    }
    hasher.update(b"\ntools:");
    if let Some(s) = tools_md {
        hasher.update(s.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn is_valid_skill_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Owns the debouncer + watcher thread. Drop to stop watching.
pub struct WatcherHandle {
    _debouncer: Debouncer<notify::RecommendedWatcher>,
    _join: Option<std::thread::JoinHandle<()>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use tempfile::TempDir;

    struct Harness {
        _dir: TempDir,
        loader: Arc<SkillLoader>,
        rx: Receiver<SkillEvent>,
    }

    impl Harness {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let (tx, rx) = mpsc::channel();
            let loader = Arc::new(SkillLoader::new(dir.path().to_path_buf(), tx));
            std::fs::create_dir_all(loader.skills_dir()).unwrap();
            Self {
                _dir: dir,
                loader,
                rx,
            }
        }

        fn write_skill(&self, name: &str, manifest: &str, body: &str) -> PathBuf {
            let dir = self.loader.skills_dir().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
            std::fs::write(dir.join("manifest.json"), manifest).unwrap();
            dir
        }

        fn drain(&self) -> Vec<SkillEvent> {
            let mut out = Vec::new();
            while let Ok(ev) = self.rx.try_recv() {
                out.push(ev);
            }
            out
        }
    }

    fn good_manifest() -> &'static str {
        r#"{ "version": "1", "default_permission": "auto", "required_tools": ["desktop.open_in_editor"] }"#
    }

    #[test]
    fn loads_a_well_formed_skill_and_emits_loaded_event() {
        let h = Harness::new();
        h.write_skill(
            "triage",
            good_manifest(),
            "# Triage incoming alerts\n\nBody…",
        );
        std::fs::write(
            h.loader.skills_dir().join("triage").join("AGENTS.md"),
            "you are an alert triage agent",
        )
        .unwrap();

        let skills = h.loader.load_all();
        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "triage");
        assert_eq!(s.description, "Triage incoming alerts");
        assert_eq!(s.manifest.version, "1");
        assert_eq!(s.manifest.default_permission, PermissionLevel::Auto);
        assert_eq!(
            s.manifest.required_tools,
            vec!["desktop.open_in_editor".to_string()]
        );
        assert_eq!(s.agents_md.as_deref(), Some("you are an alert triage agent"));
        assert!(s.tools_md.is_none());

        let events = h.drain();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], SkillEvent::Loaded { name, .. } if name == "triage"));
    }

    #[test]
    fn missing_skill_md_is_rejected_with_reason() {
        let h = Harness::new();
        let dir = h.loader.skills_dir().join("partial");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), good_manifest()).unwrap();

        let skills = h.loader.load_all();
        assert!(skills.is_empty());

        let events = h.drain();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SkillEvent::Rejected { reason, root } => {
                assert!(reason.contains("missing SKILL.md"), "got: {reason}");
                assert!(root.ends_with("partial"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn missing_manifest_is_rejected() {
        let h = Harness::new();
        let dir = h.loader.skills_dir().join("only-md");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "# nope").unwrap();

        h.loader.load_all();
        let events = h.drain();
        match events.last().unwrap() {
            SkillEvent::Rejected { reason, .. } => {
                assert!(reason.contains("missing manifest.json"), "got: {reason}");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn malformed_manifest_is_rejected_with_parse_message() {
        let h = Harness::new();
        h.write_skill("broken", "this is not json", "# body");
        h.loader.load_all();
        let events = h.drain();
        match events.last().unwrap() {
            SkillEvent::Rejected { reason, .. } => {
                assert!(reason.contains("parse manifest.json"), "got: {reason}");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn invalid_skill_name_is_rejected() {
        let h = Harness::new();
        h.write_skill("Has Spaces!", good_manifest(), "# x");
        h.loader.load_all();
        let events = h.drain();
        match events.last().unwrap() {
            SkillEvent::Rejected { reason, .. } => {
                assert!(reason.contains("invalid skill name"), "got: {reason}");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn load_all_skips_loose_files() {
        let h = Harness::new();
        std::fs::write(h.loader.skills_dir().join("README.md"), "ignore me").unwrap();
        h.write_skill("ok", good_manifest(), "# title");
        let skills = h.loader.load_all();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "ok");
    }

    #[test]
    fn reload_emits_loaded_then_reloaded_then_removed() {
        let h = Harness::new();
        h.write_skill("alpha", good_manifest(), "# v1");
        h.loader.load_all();
        // Drain initial Loaded.
        let initial = h.drain();
        assert!(matches!(initial[0], SkillEvent::Loaded { .. }));

        // Add a second skill — should emit Loaded.
        h.write_skill("beta", good_manifest(), "# beta v1");
        h.loader.reload();
        let evs = h.drain();
        assert!(
            evs.iter().any(|e| matches!(e, SkillEvent::Loaded { name, .. } if name == "beta")),
            "got: {evs:?}"
        );

        // Edit alpha — should emit Reloaded (different content_hash).
        h.write_skill("alpha", good_manifest(), "# v2");
        h.loader.reload();
        let evs = h.drain();
        assert!(
            evs.iter().any(|e| matches!(e, SkillEvent::Reloaded { name, .. } if name == "alpha")),
            "got: {evs:?}"
        );

        // Remove alpha — should emit Removed.
        std::fs::remove_dir_all(h.loader.skills_dir().join("alpha")).unwrap();
        h.loader.reload();
        let evs = h.drain();
        assert!(
            evs.iter().any(|e| matches!(e, SkillEvent::Removed { name, .. } if name == "alpha")),
            "got: {evs:?}"
        );
    }

    #[test]
    fn reload_suppresses_event_when_content_unchanged() {
        let h = Harness::new();
        h.write_skill("alpha", good_manifest(), "# v1");
        h.loader.load_all();
        let _ = h.drain();
        // Touch nothing — reload should produce no Loaded/Reloaded/Removed.
        h.loader.reload();
        let evs = h.drain();
        assert!(
            evs.is_empty(),
            "expected no events on no-op reload, got: {evs:?}"
        );
    }

    #[test]
    fn watcher_handle_drop_stops_thread() {
        let h = Harness::new();
        let handle = h.loader.clone().watch().expect("watch");
        // Drop immediately — debouncer + thread tear down. The test
        // passes as long as drop doesn't deadlock; we don't need to
        // assert the thread joined since we hold no JoinHandle.
        drop(handle);
    }

    #[test]
    fn first_meaningful_line_strips_markdown_heading() {
        assert_eq!(first_meaningful_line("# Hello"), "Hello");
        assert_eq!(first_meaningful_line("\n\n## Sub\nbody"), "Sub");
        assert_eq!(first_meaningful_line("plain text"), "plain text");
        assert_eq!(first_meaningful_line(""), "");
        assert_eq!(first_meaningful_line("\n\n#\n## real"), "real");
    }

    #[test]
    fn is_valid_skill_name_rules() {
        assert!(is_valid_skill_name("triage"));
        assert!(is_valid_skill_name("triage-v2"));
        assert!(is_valid_skill_name("alpha_beta_3"));
        assert!(!is_valid_skill_name(""));
        assert!(!is_valid_skill_name("Triage"));
        assert!(!is_valid_skill_name("has space"));
        assert!(!is_valid_skill_name("emoji-😀"));
    }
}
