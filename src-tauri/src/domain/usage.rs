use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Which agent transcript format a usage snapshot was read from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UsageSource {
    Claude,
    Codex,
}

impl UsageSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            _ => return None,
        })
    }
}

/// Token/cost totals for one task, summed over every agent session it ran.
///
/// `input_tokens` is *uncached* input for both agents: Claude reports it that
/// way, and Codex's `input_tokens` (which includes the cached part) is
/// normalized to match by the reader. Cache-write is always 0 for Codex.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub source: UsageSource,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Integer micro-dollars so totals don't drift; serialized as a plain
    /// USD number (`costUsd`). `None` only when no model used has a known
    /// price; see `cost_partial` for "some did".
    #[serde(rename = "costUsd", serialize_with = "micros_as_usd")]
    pub cost_usd_micros: Option<i64>,
    /// Some model used has no known price, so `costUsd` covers only the
    /// priced part: a lower bound, not the total.
    pub cost_partial: bool,
    pub updated_at: DateTime<Utc>,
    /// Newest transcript the snapshot read; local bookkeeping only.
    #[serde(skip)]
    pub transcript_path: Option<String>,
}

impl TaskUsage {
    /// Same totals, ignoring the timestamp — "did anything change?".
    pub fn same_totals(&self, other: &TaskUsage) -> bool {
        self.source == other.source
            && self.model == other.model
            && self.input_tokens == other.input_tokens
            && self.output_tokens == other.output_tokens
            && self.cache_read_tokens == other.cache_read_tokens
            && self.cache_write_tokens == other.cache_write_tokens
            && self.cost_usd_micros == other.cost_usd_micros
            && self.cost_partial == other.cost_partial
    }
}

fn micros_as_usd<S: serde::Serializer>(micros: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
    match micros {
        Some(m) => s.serialize_f64(*m as f64 / 1_000_000.0),
        None => s.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_with_cost_in_dollars() {
        let usage = TaskUsage {
            source: UsageSource::Claude,
            model: Some("claude-sonnet-5".into()),
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            cost_usd_micros: Some(1_234_500),
            cost_partial: false,
            updated_at: Utc::now(),
            transcript_path: Some("/secret".into()),
        };
        let v = serde_json::to_value(&usage).unwrap();
        assert_eq!(v["source"], "claude");
        assert_eq!(v["inputTokens"], 1);
        assert_eq!(v["cacheWriteTokens"], 4);
        assert_eq!(v["costUsd"], 1.2345);
        assert_eq!(v["costPartial"], false);
        assert!(v.get("transcriptPath").is_none());

        let unknown = TaskUsage {
            cost_usd_micros: None,
            ..usage
        };
        assert!(serde_json::to_value(&unknown).unwrap()["costUsd"].is_null());
    }
}
