//! Pure audio and text helpers for dictation: what Whisper is fed (16 kHz
//! mono f32), the level meter the composer draws, and the clean-up applied
//! to what comes back.

/// Whisper's input rate.
pub const WHISPER_RATE: u32 = 16_000;

/// One meter reading per this many milliseconds of audio.
pub const METER_MS: u32 = 50;

/// Average interleaved frames down to one channel.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    out.extend(
        interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32),
    );
}

/// Resample mono audio to 16 kHz. A box filter one output period wide
/// (anti-aliasing for speech is all Whisper needs) followed by linear
/// interpolation, so any device rate works — 48k, 44.1k, 24k, 16k.
pub fn to_whisper_rate(input: &[f32], rate: u32) -> Vec<f32> {
    if rate == WHISPER_RATE || input.is_empty() {
        return input.to_vec();
    }
    let ratio = rate as f64 / WHISPER_RATE as f64;
    let smoothed: Vec<f32> = if ratio > 1.0 {
        let width = ratio.ceil() as usize;
        let mut acc = 0.0f64;
        let mut out = Vec::with_capacity(input.len());
        for i in 0..input.len() {
            acc += input[i] as f64;
            if i >= width {
                acc -= input[i - width] as f64;
            }
            out.push((acc / (i + 1).min(width) as f64) as f32);
        }
        out
    } else {
        input.to_vec()
    };
    let n_out = ((input.len() as f64) / ratio).floor() as usize;
    let last = smoothed.len() - 1;
    (0..n_out)
        .map(|i| {
            let pos = i as f64 * ratio;
            let j = (pos.floor() as usize).min(last);
            let k = (j + 1).min(last);
            let t = (pos - j as f64) as f32;
            smoothed[j] * (1.0 - t) + smoothed[k] * t
        })
        .collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// RMS to a 0–1 meter: -55 dBFS (room tone) is 0, -12 dBFS (raised voice)
/// is 1, linear in dB between.
pub fn meter_level(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 55.0) / 43.0).clamp(0.0, 1.0)
}

/// Below this the loudest 50ms window is just the room: nothing was said,
/// and Whisper would invent words ("Thank you.") rather than return none.
const SPEECH_RMS: f32 = 0.004;

pub fn has_speech(samples: &[f32], rate: u32) -> bool {
    let window = (rate as usize * METER_MS as usize / 1000).max(1);
    samples.chunks(window).any(|w| rms(w) >= SPEECH_RMS)
}

/// Whisper wants at least a second; shorter clips are padded with silence.
pub fn pad_to_one_second(mut samples: Vec<f32>) -> Vec<f32> {
    let min = WHISPER_RATE as usize + WHISPER_RATE as usize / 10;
    if samples.len() < min {
        samples.resize(min, 0.0);
    }
    samples
}

/// Two transcript pieces as one line.
pub fn join_text(a: &str, b: &str) -> String {
    match (a.trim(), b.trim()) {
        ("", b) => b.to_string(),
        (a, "") => a.to_string(),
        (a, b) => format!("{a} {b}"),
    }
}

/// Where to split `samples` so no word is cut: the start of the quietest
/// 50ms window in the last `search_secs` (but not the final half second).
pub fn quietest_cut(samples: &[f32], rate: u32, search_secs: f32) -> usize {
    let w = (rate as usize * METER_MS as usize / 1000).max(1);
    let end = samples.len().saturating_sub(rate as usize / 2);
    let start = end.saturating_sub((search_secs * rate as f32) as usize);
    let mut best = (f32::MAX, end);
    let mut i = start;
    while i + w <= end {
        let r = rms(&samples[i..i + w]);
        if r < best.0 {
            best = (r, i);
        }
        i += w;
    }
    best.1.max(1)
}

/// Join Whisper's segments into one line: drop the ones that are only a
/// sound annotation (`[BLANK_AUDIO]`, `(keyboard clicking)`, `[Music]`),
/// trim, and collapse whitespace.
pub fn clean_transcript<'a>(segments: impl IntoIterator<Item = &'a str>) -> String {
    let mut out = String::new();
    for seg in segments {
        let s = seg.trim();
        if s.is_empty() || is_annotation(s) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(s);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_annotation(s: &str) -> bool {
    let wrapped = |open: char, close: char| s.starts_with(open) && s.ends_with(close) && s[1..].find(close) == Some(s.len() - 2);
    wrapped('[', ']') || wrapped('(', ')') || s.chars().all(|c| c == '♪' || c.is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_frames() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
        downmix(&[0.25], 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.25]);
    }

    #[test]
    fn resampling_keeps_duration_and_level() {
        for rate in [48_000u32, 44_100, 24_000, 16_000, 8_000] {
            let input = vec![0.5f32; rate as usize]; // 1s of DC
            let out = to_whisper_rate(&input, rate);
            assert!((out.len() as i64 - 16_000).abs() <= 1, "{rate}: {}", out.len());
            assert!(out[100..].iter().all(|s| (s - 0.5).abs() < 1e-4), "{rate}");
        }
    }

    #[test]
    fn resampling_keeps_a_speech_band_tone() {
        // A 440 Hz tone keeps its loudness through 48k → 16k.
        let input: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5)
            .collect();
        let out = to_whisper_rate(&input, 48_000);
        let r = rms(&out[1000..]);
        assert!((r - 0.5 / 2f32.sqrt()).abs() < 0.02, "{r}");
    }

    #[test]
    fn meter_maps_db_range() {
        assert_eq!(meter_level(0.0), 0.0);
        assert_eq!(meter_level(10f32.powf(-60.0 / 20.0)), 0.0);
        assert!((meter_level(10f32.powf(-33.5 / 20.0)) - 0.5).abs() < 0.01);
        assert_eq!(meter_level(1.0), 1.0);
    }

    #[test]
    fn silence_is_not_speech() {
        assert!(!has_speech(&vec![0.0005; 48_000], 48_000));
        let mut clip = vec![0.0; 48_000];
        for s in &mut clip[24_000..26_400] {
            *s = 0.05;
        }
        assert!(has_speech(&clip, 48_000));
    }

    #[test]
    fn short_clips_are_padded() {
        assert_eq!(pad_to_one_second(vec![0.1; 100]).len(), 17_600);
        assert_eq!(pad_to_one_second(vec![0.1; 40_000]).len(), 40_000);
    }

    #[test]
    fn cuts_at_the_pause() {
        // 10s at 1 kHz: loud, except a pause at 7.0–7.2s.
        let rate = 1000;
        let mut s = vec![0.3f32; 10_000];
        for x in &mut s[7_000..7_200] {
            *x = 0.0;
        }
        let cut = quietest_cut(&s, rate, 4.0);
        assert!((7_000..7_200).contains(&cut), "{cut}");
        // Never inside the last half second.
        assert!(quietest_cut(&vec![0.3; 10_000], rate, 4.0) <= 9_500);
        assert_eq!(join_text(" a ", ""), "a");
        assert_eq!(join_text("", "b"), "b");
        assert_eq!(join_text("a.", " b"), "a. b");
    }

    #[test]
    fn transcript_drops_annotations_and_joins() {
        assert_eq!(
            clean_transcript([" Add a test", "[BLANK_AUDIO]", " for the  parser. ", "(keyboard clicking)", "♪ ♪"]),
            "Add a test for the parser."
        );
        // Brackets inside speech stay.
        assert_eq!(clean_transcript(["Call foo(bar) then [x] it"]), "Call foo(bar) then [x] it");
        assert_eq!(clean_transcript(["[a] and [b]"]), "[a] and [b]");
        assert_eq!(clean_transcript(["[BLANK_AUDIO]"]), "");
    }
}
