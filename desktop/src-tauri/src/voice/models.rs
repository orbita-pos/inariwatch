//! v0.3 S5 — voice model registry.
//!
//! Catalogues the voices Inari Live ships with. Per the v0.3 S5 brief
//! ("voice models grandes — usar tauri resources externos OR
//! download-on-first-use"), models are NOT bundled in git. They live
//! at `<voice_models_dir>/<voice_id>.onnx` + `.json` after the user
//! downloads them on first use (via `voice_download_model` Tauri
//! command, future session).
//!
//! Each registry entry pins:
//!   - `voice_id` — stable identifier the frontend passes back through
//!     `voice_synthesize`.
//!   - `display_name` — what the Settings UI shows.
//!   - `language` — BCP-47 (es-MX, en-US, …) for fallback selection.
//!   - `quality` — Piper's quality tier (low / medium / high). v0.3
//!     defaults to medium — reasonable balance for alert TTS.
//!   - `download_url` — Hugging Face mirror Piper publishes from. Pinned
//!     to `rhasspy/piper-voices` (canonical source, see
//!     <https://github.com/rhasspy/piper#voices>).
//!   - `size_mb` — informational; helps the UI render "X MB to
//!     download" before the user opts in.
//!
//! NOTE: this module describes voices but does NOT download them. The
//! download manager + actual Piper synth land here in S5; real-model
//! verification + the download UI come in a later session.

/// Registry entry for a single Piper voice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceModel {
    pub voice_id: &'static str,
    pub display_name: &'static str,
    pub language: &'static str,
    pub quality: VoiceQuality,
    pub download_url: &'static str,
    pub size_mb: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceQuality {
    Low,
    Medium,
    High,
}

impl VoiceQuality {
    pub fn as_str(&self) -> &'static str {
        match self {
            VoiceQuality::Low => "low",
            VoiceQuality::Medium => "medium",
            VoiceQuality::High => "high",
        }
    }
}

/// 4 default voices — 2 Spanish, 2 English. Picked to give Jesus's
/// likely user pool (LATAM Spanish + general English) coverage out of
/// the box. Additional voices can be added by extending this list +
/// shipping the `<voice_id>.onnx` + `<voice_id>.json` pair to the
/// download CDN. Model URLs follow Piper's canonical layout under
/// `rhasspy/piper-voices` on Hugging Face.
pub const VOICE_REGISTRY: &[VoiceModel] = &[
    VoiceModel {
        voice_id: "es_MX-claude-medium",
        display_name: "Claude (es-MX)",
        language: "es-MX",
        quality: VoiceQuality::Medium,
        download_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/claude/medium/es_MX-claude-14947-medium.onnx",
        size_mb: 63,
    },
    VoiceModel {
        voice_id: "es_ES-davefx-medium",
        display_name: "DaveFX (es-ES)",
        language: "es-ES",
        quality: VoiceQuality::Medium,
        download_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
        size_mb: 63,
    },
    VoiceModel {
        voice_id: "en_US-amy-medium",
        display_name: "Amy (en-US)",
        language: "en-US",
        quality: VoiceQuality::Medium,
        download_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
        size_mb: 63,
    },
    VoiceModel {
        voice_id: "en_GB-alan-medium",
        display_name: "Alan (en-GB)",
        language: "en-GB",
        quality: VoiceQuality::Medium,
        download_url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx",
        size_mb: 63,
    },
];

/// Approximate bytes-on-disk for the full bundle (4 voices × ~63MB).
/// Surfaced in the Settings UI so the user knows what they'll spend
/// before opting in.
pub fn full_bundle_size_mb() -> u32 {
    VOICE_REGISTRY.iter().map(|v| v.size_mb).sum()
}

/// Look up a voice by id. Returns None when the id isn't registered —
/// the synth falls back to en_US-amy-medium for unknown ids (and logs
/// a warning) so a misspelled config never silences voice entirely.
pub fn lookup(voice_id: &str) -> Option<&'static VoiceModel> {
    VOICE_REGISTRY.iter().find(|v| v.voice_id == voice_id)
}

/// Default voice when the caller doesn't specify or the id is unknown.
pub fn default_voice() -> &'static VoiceModel {
    // Index 2 = en_US-amy-medium. Picked over Spanish so English-only
    // users get clean output without configuring; Spanish users opt in
    // by passing `es_MX-claude-medium` from the dispatch payload.
    &VOICE_REGISTRY[2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_four_voices() {
        assert_eq!(VOICE_REGISTRY.len(), 4);
    }

    #[test]
    fn registry_has_two_spanish_two_english() {
        let es = VOICE_REGISTRY
            .iter()
            .filter(|v| v.language.starts_with("es"))
            .count();
        let en = VOICE_REGISTRY
            .iter()
            .filter(|v| v.language.starts_with("en"))
            .count();
        assert_eq!(es, 2);
        assert_eq!(en, 2);
    }

    #[test]
    fn lookup_finds_by_id() {
        let v = lookup("es_MX-claude-medium").expect("voice present");
        assert_eq!(v.language, "es-MX");
        assert_eq!(v.quality, VoiceQuality::Medium);
    }

    #[test]
    fn lookup_missing_id_returns_none() {
        assert!(lookup("xx_YY-fake-medium").is_none());
    }

    #[test]
    fn default_voice_is_english() {
        assert!(default_voice().language.starts_with("en"));
    }

    #[test]
    fn full_bundle_size_under_300mb() {
        // Sanity — keep total bundle under what a user would tolerate
        // downloading on first use. Doubling this triggers a UX review.
        let total = full_bundle_size_mb();
        assert!(total > 0);
        assert!(
            total < 300,
            "voice bundle grew to {total} MB — review whether download-on-demand still fits"
        );
    }

    #[test]
    fn download_urls_are_https() {
        for v in VOICE_REGISTRY {
            assert!(
                v.download_url.starts_with("https://"),
                "voice {} has non-https URL",
                v.voice_id,
            );
        }
    }
}
