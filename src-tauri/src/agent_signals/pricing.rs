//! Static model price table, USD per million tokens.
//!
//! As of 2026-11-09. Rows marked "verified" were checked against the
//! `costUSD` Claude Code itself recorded (transcript `cost-state` lines) on
//! the development machine; the rest are list prices. A model that isn't
//! here prices as `None` — the UI hides cost rather than guess, and a
//! finished Claude session's own `cost-state` total is used when present
//! (see `transcripts::claude`), which covers new models automatically.
//!
//! Matching is exact after normalizing (`-YYYYMMDD` date suffix and a
//! `[1m]`-style context tag removed), never by prefix: `claude-opus-5` must
//! not price `claude-opus-5-5`.

use super::transcripts::TokenCounts;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// 5-minute cache writes (1.25× input).
    pub cache_write_5m: f64,
    /// 1-hour cache writes (2× input).
    pub cache_write_1h: f64,
}

const fn anthropic(input: f64, output: f64) -> Price {
    Price {
        input,
        output,
        cache_read: input * 0.1,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
    }
}

/// OpenAI: cached input is billed at the cache-read rate; no write charge.
const fn openai(input: f64, output: f64, cached: f64) -> Price {
    Price {
        input,
        output,
        cache_read: cached,
        cache_write_5m: 0.0,
        cache_write_1h: 0.0,
    }
}

const TABLE: &[(&str, Price)] = &[
    // Anthropic
    ("claude-opus-5", anthropic(5.0, 25.0)),        // verified
    ("claude-sonnet-5", anthropic(2.0, 10.0)),      // verified
    ("claude-haiku-5-5", anthropic(0.1, 0.5)),      // verified (in/out)
    ("claude-haiku-4-5", anthropic(1.0, 5.0)),      // verified
    ("claude-opus-4-5", anthropic(5.0, 25.0)),
    ("claude-opus-4-1", anthropic(15.0, 75.0)),
    ("claude-opus-4", anthropic(15.0, 75.0)),
    ("claude-sonnet-4-5", anthropic(3.0, 15.0)),
    ("claude-sonnet-4", anthropic(3.0, 15.0)),
    ("claude-3-7-sonnet", anthropic(3.0, 15.0)),
    ("claude-3-5-haiku", anthropic(0.8, 4.0)),
    // OpenAI (Codex)
    ("gpt-5", openai(1.25, 10.0, 0.125)),
    ("gpt-5-codex", openai(1.25, 10.0, 0.125)),
    ("gpt-5.1", openai(1.25, 10.0, 0.125)),
    ("gpt-5.1-codex", openai(1.25, 10.0, 0.125)),
    ("gpt-5-mini", openai(0.25, 2.0, 0.025)),
    ("gpt-5.1-codex-mini", openai(0.25, 2.0, 0.025)),
];

fn normalize(model: &str) -> &str {
    let model = model.split('[').next().unwrap_or(model).trim();
    // Drop a trailing `-YYYYMMDD` snapshot date.
    if let Some((base, date)) = model.rsplit_once('-') {
        if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) {
            return base;
        }
    }
    model
}

pub fn price_for(model: &str) -> Option<Price> {
    let key = normalize(model);
    TABLE
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, price)| *price)
}

/// Cost of `tokens` on `model` in micro-dollars; `None` for an unknown model.
pub fn cost_micros(model: &str, tokens: &TokenCounts) -> Option<i64> {
    let p = price_for(model)?;
    // $/MTok × tokens / 1e6 = $; × 1e6 = µ$ — the factors cancel.
    let micros = p.input * tokens.input as f64
        + p.output * tokens.output as f64
        + p.cache_read * tokens.cache_read as f64
        + p.cache_write_5m * tokens.cache_write_5m as f64
        + p.cache_write_1h * tokens.cache_write_1h as f64;
    Some(micros.round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_models_have_no_price() {
        assert!(price_for("claude-opus-5-5").is_none());
        assert!(price_for("gpt-6-astra").is_none());
        assert!(cost_micros("totally-new", &TokenCounts::default()).is_none());
    }

    #[test]
    fn exact_match_after_normalizing() {
        assert!(price_for("claude-haiku-4-5-20251001").is_some());
        assert!(price_for("claude-opus-5[1m]").is_some());
        // No prefix matching.
        assert!(price_for("claude-opus-5-9").is_none());
    }

    #[test]
    fn matches_a_cost_claude_code_recorded() {
        // A claude-haiku-5-5 `cost-state` row from a real transcript:
        // 1215 in, 205 out, costUSD 0.000224.
        let t = TokenCounts {
            input: 1215,
            output: 205,
            ..Default::default()
        };
        assert_eq!(cost_micros("claude-haiku-5-5", &t), Some(224));
        // Cache tiers.
        let t = TokenCounts {
            cache_read: 1_000_000,
            cache_write_5m: 1_000_000,
            cache_write_1h: 1_000_000,
            ..Default::default()
        };
        assert_eq!(cost_micros("claude-sonnet-5", &t), Some(200_000 + 2_500_000 + 4_000_000));
    }
}
