//! Hardware tier detection for the local AI stack.
//!
//! The dock surfaces a recommended tier on first launch (and again
//! whenever the user opens Settings → AI). Tiers map roughly to
//! "what local models can this box run without thrashing":
//!
//! - [`HardwareTier::None`]  — < 8 GB RAM or < 4 logical CPUs. The
//!                             user is steered toward cloud-only
//!                             until they upgrade hardware.
//! - [`HardwareTier::Tier1`] — ≥ 8 GB RAM, ≥ 4 logical CPUs. Can
//!                             host Qwen2.5-Coder-1.5B Q4_K_M
//!                             (~1.0 GB resident) for Tab completions.
//! - [`HardwareTier::Tier2`] — ≥ 16 GB RAM, ≥ 8 logical CPUs. Can
//!                             also host Kortix FastApply-7B Q4_K_M
//!                             (~5.0 GB resident) alongside the
//!                             1.5B for Apply.
//!
//! GPU presence is logged for diagnostics but does NOT alter the
//! recommended tier — llama.cpp accelerates whatever GPU is present
//! when the build embeds the right backend (Metal on macOS, CUDA on
//! Linux, Vulkan on Windows). The tier reflects *worst-case CPU*
//! behaviour so users with old laptops don't get a false "you can
//! run the 7B" recommendation.

use serde::{Deserialize, Serialize};

/// Hardware capability tier. Persisted to `settings.local_ai_tier` as
/// a lowercase string (`"none"` / `"tier1"` / `"tier2"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareTier {
    None,
    Tier1,
    Tier2,
}

impl HardwareTier {
    /// String representation used in the `settings` table. Stable
    /// across versions — never rename.
    pub fn as_str(self) -> &'static str {
        match self {
            HardwareTier::None  => "none",
            HardwareTier::Tier1 => "tier1",
            HardwareTier::Tier2 => "tier2",
        }
    }

    /// Round-trip the lowercase form persisted in `settings`. Unknown
    /// values fall back to [`HardwareTier::None`] — fail-safe.
    pub fn parse(s: &str) -> Self {
        match s {
            "tier1" => HardwareTier::Tier1,
            "tier2" => HardwareTier::Tier2,
            _       => HardwareTier::None,
        }
    }
}

/// Snapshot of the host's relevant resources at probe time. Held by
/// the runtime so callers can log "why was Tier2 not recommended"
/// without re-probing.
#[derive(Debug, Clone, Copy)]
pub struct HardwareSnapshot {
    pub total_ram_bytes: u64,
    pub logical_cpus:    usize,
    pub tier:            HardwareTier,
}

const GIB: u64 = 1024 * 1024 * 1024;

/// Probe the host. Cheap (~1 ms on Linux, ~5 ms on Windows). Safe to
/// call from any thread.
pub fn detect() -> HardwareSnapshot {
    use sysinfo::{System, RefreshKind, MemoryRefreshKind, CpuRefreshKind};

    let refresh = RefreshKind::new()
        .with_memory(MemoryRefreshKind::everything())
        .with_cpu(CpuRefreshKind::everything());
    let mut sys = System::new_with_specifics(refresh);
    // sysinfo 0.30 needs an explicit second refresh of CPU after a
    // tiny pause to populate per-core stats; we only care about the
    // *count* though, which is available immediately. Skip the pause.
    sys.refresh_specifics(refresh);

    let total_ram_bytes = sys.total_memory();
    let logical_cpus    = sys.cpus().len();

    let tier = classify(total_ram_bytes, logical_cpus);
    HardwareSnapshot { total_ram_bytes, logical_cpus, tier }
}

/// Pure classifier — exposed for unit tests so we don't need to fake
/// `sysinfo`. Same thresholds documented at the top of the module.
pub fn classify(total_ram_bytes: u64, logical_cpus: usize) -> HardwareTier {
    if total_ram_bytes >= 16 * GIB && logical_cpus >= 8 {
        HardwareTier::Tier2
    } else if total_ram_bytes >= 8 * GIB && logical_cpus >= 4 {
        HardwareTier::Tier1
    } else {
        HardwareTier::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_tier_thresholds() {
        // Boundaries.
        assert_eq!(classify(7 * GIB, 16),         HardwareTier::None);
        assert_eq!(classify(8 * GIB, 3),          HardwareTier::None);
        assert_eq!(classify(8 * GIB, 4),          HardwareTier::Tier1);
        assert_eq!(classify(15 * GIB, 16),        HardwareTier::Tier1);
        assert_eq!(classify(16 * GIB, 7),         HardwareTier::Tier1);
        assert_eq!(classify(16 * GIB, 8),         HardwareTier::Tier2);
        assert_eq!(classify(64 * GIB, 32),        HardwareTier::Tier2);
    }

    #[test]
    fn tier_strings_round_trip() {
        for t in [HardwareTier::None, HardwareTier::Tier1, HardwareTier::Tier2] {
            assert_eq!(HardwareTier::parse(t.as_str()), t);
        }
        assert_eq!(HardwareTier::parse("garbage"), HardwareTier::None);
        assert_eq!(HardwareTier::parse(""),        HardwareTier::None);
    }

    #[test]
    fn detect_returns_plausible_snapshot() {
        let snap = detect();
        // The CI/dev box has at least one CPU and some RAM — these
        // are sanity checks, not behavioural assertions.
        assert!(snap.logical_cpus >= 1);
        assert!(snap.total_ram_bytes > 0);
    }
}
