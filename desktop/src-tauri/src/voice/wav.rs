//! v0.3 S5 — synthetic WAV generation.
//!
//! Used when Piper isn't available on disk yet (model not downloaded,
//! Piper binary not installed, dev/test runs without TTS infra). The
//! synth produces a real, playable WAV — frontend audio decoding logic
//! never has to special-case "no real TTS available" — and the voice
//! pipeline is exercised end-to-end from the dispatcher down to the
//! WAV bytes.
//!
//! Two modes:
//!   - [`silent_wav`] — single, configurable duration of silence.
//!     Used when there's literally nothing to say (degraded fallback).
//!   - [`synthetic_speech_wav`] — short tone with a duration roughly
//!     proportional to text length, so the dispatcher can verify that
//!     "longer text → longer audio" without committing to real TTS.
//!     This is the path that runs in v0.3 S5 until the user installs
//!     Piper. NEVER ship as the production-default path.
//!
//! The WAV format we emit is the simplest valid one: PCM_INT16 mono,
//! 22050 Hz (matches Piper's default output sample rate, so callers
//! that play these bytes plus real-Piper bytes never need to switch
//! audio contexts).

use std::f32::consts::PI;

/// Sample rate Piper's medium-quality models emit at. We mirror it
/// here so synthetic audio plays at the same speed as real audio
/// without resampling.
pub const SAMPLE_RATE_HZ: u32 = 22_050;

/// Mono channel count.
const CHANNELS: u16 = 1;

/// 16-bit signed PCM.
const BITS_PER_SAMPLE: u16 = 16;

/// Build the 44-byte RIFF/WAVE header for a PCM_INT16 mono stream.
/// `samples_count` is the number of samples (NOT bytes).
fn build_wav_header(samples_count: u32) -> Vec<u8> {
    let byte_rate = SAMPLE_RATE_HZ * CHANNELS as u32 * BITS_PER_SAMPLE as u32 / 8;
    let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
    let data_size = samples_count * BITS_PER_SAMPLE as u32 / 8;
    let chunk_size = 36 + data_size;

    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&chunk_size.to_le_bytes());
    header.extend_from_slice(b"WAVE");
    // fmt subchunk
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    header.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    header.extend_from_slice(&CHANNELS.to_le_bytes());
    header.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    // data subchunk
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_size.to_le_bytes());
    header
}

/// Generate `n` zero samples — silent PCM.
fn silent_samples(n: u32) -> Vec<u8> {
    vec![0u8; (n * 2) as usize] // 2 bytes per int16 sample
}

/// Generate `n` samples of a low-amplitude sine wave at `freq_hz`.
fn tone_samples(n: u32, freq_hz: f32, amplitude: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity((n * 2) as usize);
    let max = amplitude.clamp(0.0, 1.0) * (i16::MAX as f32);
    for i in 0..n {
        let t = i as f32 / SAMPLE_RATE_HZ as f32;
        let s = (2.0 * PI * freq_hz * t).sin() * max;
        let q = s.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        out.extend_from_slice(&q.to_le_bytes());
    }
    out
}

/// Silent WAV of the requested duration. Always returns a valid WAV.
pub fn silent_wav(duration_ms: u32) -> Vec<u8> {
    let samples = (SAMPLE_RATE_HZ * duration_ms.max(1)) / 1000;
    let mut out = build_wav_header(samples);
    out.extend(silent_samples(samples));
    out
}

/// Synthetic-speech-shaped WAV — duration scales with input text length
/// so callers see "more text → longer audio" from the synth even
/// without a real TTS engine. The waveform is a low-amplitude 220 Hz
/// tone with a 5 ms gap every 80 ms (vague speech-cadence shape).
///
/// Cap: duration clamps to 30 seconds so a runaway prompt can't
/// generate an absurd buffer.
pub fn synthetic_speech_wav(text: &str) -> Vec<u8> {
    let chars = text.trim().chars().count() as u32;
    if chars == 0 {
        return silent_wav(200);
    }
    // ~80 ms per character, capped at 30s. 80 ms is roughly the cadence
    // of natural speech for short phrases — plenty for a smoke test.
    let raw_ms = chars.saturating_mul(80);
    let duration_ms = raw_ms.min(30_000);
    let total_samples = (SAMPLE_RATE_HZ * duration_ms) / 1000;

    let mut out = build_wav_header(total_samples);

    // Build the body in 80 ms slices (75 ms tone + 5 ms gap), repeat
    // until we hit the duration. 80 ms fits cleanly into the 22050 Hz
    // sample rate (1764 samples/slice).
    let slice_samples = (SAMPLE_RATE_HZ * 80) / 1000; // 1764
    let gap_samples = (SAMPLE_RATE_HZ * 5) / 1000; // 110
    let tone_samples_per_slice = slice_samples - gap_samples;

    let mut emitted: u32 = 0;
    while emitted + slice_samples <= total_samples {
        out.extend(tone_samples(tone_samples_per_slice, 220.0, 0.10));
        out.extend(silent_samples(gap_samples));
        emitted += slice_samples;
    }
    // Tail — any remaining samples are silence so the data chunk size
    // still matches the header. Off-by-one safety.
    if emitted < total_samples {
        out.extend(silent_samples(total_samples - emitted));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_riff_header(buf: &[u8]) -> (u32, u16, u32, u16, u16, u32) {
        // Returns (chunk_size, channels, sample_rate, bits, audio_fmt, data_size).
        assert_eq!(&buf[0..4], b"RIFF");
        assert_eq!(&buf[8..12], b"WAVE");
        assert_eq!(&buf[12..16], b"fmt ");
        let chunk_size = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let audio_fmt = u16::from_le_bytes([buf[20], buf[21]]);
        let channels = u16::from_le_bytes([buf[22], buf[23]]);
        let rate = u32::from_le_bytes([buf[24], buf[25], buf[26], buf[27]]);
        let bits = u16::from_le_bytes([buf[34], buf[35]]);
        assert_eq!(&buf[36..40], b"data");
        let data_size = u32::from_le_bytes([buf[40], buf[41], buf[42], buf[43]]);
        (chunk_size, channels, rate, bits, audio_fmt, data_size)
    }

    #[test]
    fn silent_wav_has_valid_header_and_correct_data_size() {
        let buf = silent_wav(500);
        assert!(buf.len() >= 44);
        let (_chunk, channels, rate, bits, fmt, data_size) = parse_riff_header(&buf);
        assert_eq!(fmt, 1); // PCM
        assert_eq!(channels, 1);
        assert_eq!(rate, SAMPLE_RATE_HZ);
        assert_eq!(bits, 16);
        // 500 ms × 22050 Hz × 2 bytes = 22050 bytes
        assert_eq!(data_size, 22050);
        assert_eq!(buf.len() as u32, 44 + data_size);
    }

    #[test]
    fn synthetic_speech_scales_with_text_length() {
        let short = synthetic_speech_wav("Hi");
        let long = synthetic_speech_wav(
            "This is a much longer string that should produce more audio",
        );
        assert!(long.len() > short.len());
    }

    #[test]
    fn synthetic_speech_clamps_at_30_seconds() {
        let huge = "a".repeat(10_000);
        let buf = synthetic_speech_wav(&huge);
        let (_chunk, _ch, rate, bits, _fmt, data_size) = parse_riff_header(&buf);
        let max_data = rate * (bits as u32 / 8) * 30;
        // Exact cap is 30s; allow ±1 sample for slice rounding.
        assert!(data_size <= max_data + 1);
    }

    #[test]
    fn empty_text_yields_short_silent_clip() {
        let buf = synthetic_speech_wav("");
        let (_c, _ch, rate, _b, _f, data_size) = parse_riff_header(&buf);
        // 200 ms silent clip — 200 ms × 22050 × 2 = 8820 bytes.
        assert_eq!(data_size, rate * 2 / 5);
    }
}
