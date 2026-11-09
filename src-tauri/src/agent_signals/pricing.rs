//! Static model price table, USD per million tokens.
//!
//! Anthropic rows are the list prices on
//! <https://platform.claude.com/docs/en/about-claude/pricing> as read on
//! 2026-11-10; the four marked "verified" also matched the `costUSD` Claude
//! Code itself recorded (transcript `cost-state` lines). A model that isn't
//! here prices as `None`, and a task that used one gets a *partial* total
//! (see `CostSum`) rather than none at all. A finished Claude session's own
//! `cost-state` total is used when present (see `transcripts::claude`),
//! which covers new models automatically.
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
    /// 5-minute cache writes.
    pub cache_write_5m: f64,
    /// 1-hour cache writes.
    pub cache_write_1h: f64,
}

/// Anthropic's classic multipliers: hits 0.1×, 5m writes 1.25×, 1h writes 2×.
const fn anthropic(input: f64, output: f64) -> Price {
    Price {
        input,
        output,
        cache_read: input * 0.1,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
    }
}

/// Every rate spelled out. Newer models don't follow `anthropic`'s
/// multipliers (Opus 5.5 reads cache at 0.05× input), so deriving them
/// would misprice the cache, which is most of an agent's tokens.
const fn explicit(
    input: f64,
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
) -> Price {
    Price {
        input,
        output,
        cache_read,
        cache_write_5m,
        cache_write_1h,
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
    // Anthropic. `explicit` = (input, output, 5m write, 1h write, cache hit).
    ("claude-fable-5-2", explicit(8.0, 40.0, 10.0, 16.0, 0.20)),
    ("claude-fable-5-1", explicit(10.0, 50.0, 12.5, 20.0, 0.25)),
    ("claude-fable-5", explicit(10.0, 50.0, 12.5, 20.0, 1.0)),
    ("claude-opus-5-5", explicit(4.0, 20.0, 5.0, 8.0, 0.20)),
    ("claude-sonnet-5-5", explicit(2.0, 10.0, 2.5, 4.0, 0.10)),
    // Haiku 5.5's list price is higher past 100k-token prompts; a transcript
    // total doesn't keep per-request prompt sizes, so the base tier is used.
    ("claude-haiku-5-5", anthropic(0.1, 0.5)), // verified (in/out)
    ("claude-opus-5", anthropic(5.0, 25.0)),   // verified
    ("claude-sonnet-5", anthropic(2.0, 10.0)), // verified
    ("claude-opus-4-8", anthropic(5.0, 25.0)),
    ("claude-opus-4-7", anthropic(5.0, 25.0)),
    ("claude-opus-4-6", anthropic(5.0, 25.0)),
    ("claude-sonnet-4-6", anthropic(3.0, 15.0)),
    ("claude-haiku-4-5", anthropic(1.0, 5.0)), // verified
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

/// A task's cost summed over its (model, tokens) parts. One unpriced model
/// must not blank the whole figure: the priced parts still add up and the
/// total is flagged partial (a lower bound). Only when *every* non-empty
/// part is unpriced is there no figure at all.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CostSum {
    micros: i64,
    priced: bool,
    unpriced: bool,
}

impl CostSum {
    /// A part whose cost is already known (a session's recorded total).
    pub fn add_micros(&mut self, micros: i64) {
        self.micros += micros;
        self.priced = true;
    }

    /// `tokens` on `model`. No model, or one the table doesn't know, is an
    /// unpriced part. Empty parts count neither way.
    pub fn add(&mut self, model: Option<&str>, tokens: &TokenCounts) {
        if tokens.is_zero() {
            return;
        }
        match model.and_then(|m| cost_micros(m, tokens)) {
            Some(micros) => self.add_micros(micros),
            None => self.unpriced = true,
        }
    }

    /// `(cost, partial)`. The cost is `None` only when nothing could be priced.
    pub fn total(&self) -> (Option<i64>, bool) {
        if self.unpriced && !self.priced {
            (None, false)
        } else {
            (Some(self.micros), self.unpriced)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_models_have_no_price() {
        assert!(price_for("claude-opus-9").is_none());
        assert!(price_for("gpt-6-astra").is_none());
        assert!(cost_micros("totally-new", &TokenCounts::default()).is_none());
    }

    #[test]
    fn exact_match_after_normalizing() {
        assert!(price_for("claude-haiku-4-5-20251001").is_some());
        assert!(price_for("claude-opus-5[1m]").is_some());
        assert!(price_for("claude-opus-5-5[1m]").is_some());
        // No prefix matching.
        assert!(price_for("claude-opus-5-9").is_none());
        assert_ne!(price_for("claude-opus-5"), price_for("claude-opus-5-5"));
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

    /// Every rate of the rows added from the 2026-11-10 price page.
    #[test]
    fn current_models_are_priced_with_their_own_cache_rates() {
        let one_mtok = |set: fn(&mut TokenCounts)| {
            let mut t = TokenCounts::default();
            set(&mut t);
            t
        };
        let input = one_mtok(|t| t.input = 1_000_000);
        let output = one_mtok(|t| t.output = 1_000_000);
        let w5 = one_mtok(|t| t.cache_write_5m = 1_000_000);
        let w1 = one_mtok(|t| t.cache_write_1h = 1_000_000);
        let hit = one_mtok(|t| t.cache_read = 1_000_000);
        // (model, input, output, 5m write, 1h write, cache hit) in µ$/MTok.
        let rows = [
            ("claude-opus-5-5", 4_000_000, 20_000_000, 5_000_000, 8_000_000, 200_000),
            ("claude-sonnet-5-5", 2_000_000, 10_000_000, 2_500_000, 4_000_000, 100_000),
            ("claude-haiku-5-5", 100_000, 500_000, 125_000, 200_000, 10_000),
            ("claude-fable-5-2", 8_000_000, 40_000_000, 10_000_000, 16_000_000, 200_000),
            ("claude-fable-5-1", 10_000_000, 50_000_000, 12_500_000, 20_000_000, 250_000),
            ("claude-fable-5", 10_000_000, 50_000_000, 12_500_000, 20_000_000, 1_000_000),
            ("claude-opus-4-8", 5_000_000, 25_000_000, 6_250_000, 10_000_000, 500_000),
            ("claude-opus-4-7", 5_000_000, 25_000_000, 6_250_000, 10_000_000, 500_000),
            ("claude-opus-4-6", 5_000_000, 25_000_000, 6_250_000, 10_000_000, 500_000),
            ("claude-sonnet-4-6", 3_000_000, 15_000_000, 3_750_000, 6_000_000, 300_000),
        ];
        for (model, i, o, c5, c1, h) in rows {
            assert_eq!(cost_micros(model, &input), Some(i), "{model} input");
            assert_eq!(cost_micros(model, &output), Some(o), "{model} output");
            assert_eq!(cost_micros(model, &w5), Some(c5), "{model} 5m write");
            assert_eq!(cost_micros(model, &w1), Some(c1), "{model} 1h write");
            assert_eq!(cost_micros(model, &hit), Some(h), "{model} cache hit");
        }
    }

    #[test]
    fn an_unpriced_part_makes_the_total_partial_not_null() {
        let t = TokenCounts {
            input: 1_000_000,
            ..Default::default()
        };
        let mut sum = CostSum::default();
        assert_eq!(sum.total(), (Some(0), false), "nothing used costs nothing");
        sum.add(Some("claude-sonnet-5"), &t);
        assert_eq!(sum.total(), (Some(2_000_000), false));
        sum.add(Some("claude-opus-9"), &t);
        sum.add(None, &t);
        assert_eq!(sum.total(), (Some(2_000_000), true), "priced part kept, flagged partial");
        sum.add_micros(500);
        assert_eq!(sum.total(), (Some(2_000_500), true));

        let mut all_unpriced = CostSum::default();
        all_unpriced.add(Some("claude-opus-9"), &t);
        assert_eq!(all_unpriced.total(), (None, false), "nothing priced: no figure");
        // An empty part on an unknown model doesn't make anything partial.
        let mut empty = CostSum::default();
        empty.add(Some("claude-opus-9"), &TokenCounts::default());
        assert_eq!(empty.total(), (Some(0), false));
    }
}
