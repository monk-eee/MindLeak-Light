use std::{
    future::Future,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

use crate::{InvalidInput, KeywordMatchMode, RecallDiagnostics};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
}

impl ProviderUsage {
    pub fn from_response(value: &Value) -> Self {
        Self {
            input_tokens: value
                .get("prompt_tokens")
                .or_else(|| value.get("input_tokens"))
                .and_then(Value::as_u64),
            output_tokens: value
                .get("completion_tokens")
                .or_else(|| value.get("output_tokens"))
                .and_then(Value::as_u64),
            total_tokens: value.get("total_tokens").and_then(Value::as_u64),
            cached_input_tokens: value
                .pointer("/prompt_tokens_details/cached_tokens")
                .or_else(|| value.pointer("/input_tokens_details/cached_tokens"))
                .and_then(Value::as_u64),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCall {
    pub operation: &'static str,
    pub model: String,
    pub elapsed_ms: f64,
    pub usage: ProviderUsage,
}

tokio::task_local! {
    static PROVIDER_CALLS: Arc<Mutex<Vec<ProviderCall>>>;
}

pub fn record_provider_call(call: ProviderCall) {
    let _ = PROVIDER_CALLS.try_with(|calls| {
        if let Ok(mut calls) = calls.lock() {
            calls.push(call);
        }
    });
}

pub(crate) async fn capture_usage<F: Future>(
    enabled: bool,
    operation: F,
) -> (F::Output, Option<Vec<ProviderCall>>) {
    if !enabled {
        return (operation.await, None);
    }
    let calls = Arc::new(Mutex::new(Vec::new()));
    let result = PROVIDER_CALLS.scope(calls.clone(), operation).await;
    let recorded = calls.lock().map(|calls| calls.clone()).ok();
    (result, recorded)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingCapabilities {
    pub mode: &'static str,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalCapabilities {
    pub strategy: &'static str,
    pub match_modes: Vec<KeywordMatchMode>,
    pub query_diagnostics: bool,
    pub embedding_model: Option<String>,
    pub embedding_dimensions: Option<usize>,
    pub minimum_similarity: Option<f64>,
    pub relevance_model: Option<String>,
    pub provider_calls_instrumented: bool,
}

impl Default for RetrievalCapabilities {
    fn default() -> Self {
        Self {
            strategy: "custom",
            match_modes: vec![],
            query_diagnostics: false,
            embedding_model: None,
            embedding_dimensions: None,
            minimum_similarity: None,
            relevance_model: None,
            provider_calls_instrumented: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningCapabilities {
    pub agent_authored_chains: bool,
    pub agent_authored_principles: bool,
    pub model_preview_required: bool,
    pub acceptance: &'static str,
    pub recall_changes_knowledge: bool,
    pub checkpoint_mode: &'static str,
    pub checkpoint_triggers: Vec<&'static str>,
    pub capture_format: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCapabilities {
    pub kind: &'static str,
    pub learning: LearningCapabilities,
    pub retrieval: RetrievalCapabilities,
    pub decomposition: ProcessingCapabilities,
    pub formation: ProcessingCapabilities,
    pub knowledge_views: Vec<&'static str>,
    pub compact_response_bytes: usize,
    pub guidance: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDiagnostics {
    pub retrieval_ms: f64,
    pub response_bytes: usize,
    pub provider_request_count: Option<usize>,
    pub provider_calls: Vec<ProviderCall>,
    pub measurement: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport<T: Serialize> {
    #[serde(flatten)]
    pub response: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<RecallDiagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_diagnostics: Option<CostDiagnostics>,
}

impl<T: Serialize> SearchReport<T> {
    pub(crate) fn finish(
        response: T,
        diagnostics: Option<RecallDiagnostics>,
        elapsed_ms: f64,
        usage: Option<Vec<ProviderCall>>,
        measured: bool,
        instrumented: bool,
        maximum: usize,
    ) -> Result<Self> {
        let mut result = Self { response, diagnostics, cost_diagnostics: measured.then(|| CostDiagnostics {
            retrieval_ms:elapsed_ms, response_bytes:0,
            provider_request_count:instrumented.then_some(usage.as_ref().map(Vec::len)).flatten(),
            provider_calls:usage.unwrap_or_default(),
            measurement:"responseBytes is this serialized structured payload, excluding MCP envelopes and duplicate text content; usage is provider-reported, not monetary cost; null means unknown",
        }) };
        for _ in 0..4 {
            let bytes = serde_json::to_vec(&result)?.len();
            if bytes > maximum {
                return Err(InvalidInput(format!("search response exceeds {maximum} bytes; lower limit or inspect an individual record")).into());
            }
            match result.cost_diagnostics.as_mut() {
                Some(cost) if cost.response_bytes != bytes => cost.response_bytes = bytes,
                _ => return Ok(result),
            }
        }
        Err(InvalidInput("cannot determine search response size".into()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider_call(model: &str) -> ProviderCall {
        ProviderCall {
            operation: "embedding",
            model: model.into(),
            elapsed_ms: 1.0,
            usage: ProviderUsage::default(),
        }
    }

    #[test]
    fn usage_preserves_reported_values_and_never_infers_missing_counts() {
        let reported = ProviderUsage::from_response(&json!({
            "input_tokens": 12,
            "output_tokens": 3,
            "input_tokens_details": {"cached_tokens": 7}
        }));
        assert_eq!(reported.input_tokens, Some(12));
        assert_eq!(reported.output_tokens, Some(3));
        assert_eq!(reported.cached_input_tokens, Some(7));
        assert_eq!(reported.total_tokens, None);
        for value in [
            json!(null),
            json!("unavailable"),
            json!({}),
            json!({
                "prompt_tokens": -1, "completion_tokens": "3", "total_tokens": 2.5,
                "prompt_tokens_details": {"cached_tokens": false}
            }),
        ] {
            let usage = ProviderUsage::from_response(&value);
            assert_eq!(
                serde_json::to_value(usage).unwrap(),
                json!({
                    "inputTokens": null, "outputTokens": null,
                    "totalTokens": null, "cachedInputTokens": null
                })
            );
        }
        let zero = ProviderUsage::from_response(&json!({"prompt_tokens": 0}));
        assert_eq!(zero.input_tokens, Some(0));
    }

    #[test]
    fn diagnostics_are_opt_in_and_unknown_calls_are_not_zero() {
        let legacy =
            json!({"kind": "knowledge", "principles": [], "chains": [], "observations": []});
        let unmeasured =
            SearchReport::finish(legacy.clone(), None, 1.0, None, false, false, 4096).unwrap();
        assert_eq!(serde_json::to_value(unmeasured).unwrap(), legacy);
        let unknown =
            SearchReport::finish(legacy.clone(), None, 1.0, Some(vec![]), true, false, 4096)
                .unwrap();
        assert_eq!(
            unknown.cost_diagnostics.unwrap().provider_request_count,
            None
        );
        let cache_hit =
            SearchReport::finish(legacy, None, 1.0, Some(vec![]), true, true, 4096).unwrap();
        assert_eq!(
            cache_hit.cost_diagnostics.unwrap().provider_request_count,
            Some(0)
        );
    }

    #[test]
    fn response_bytes_include_diagnostics_and_enforce_the_exact_json_budget() {
        let response = json!({"conclusion": "\"\n\\".repeat(128), "applicability": "Only under the recorded conditions."});
        let build = |maximum| {
            SearchReport::finish(
                response.clone(),
                None,
                1.25,
                Some(vec![provider_call("test-model")]),
                true,
                true,
                maximum,
            )
        };
        let report = build(4096).unwrap();
        let bytes = serde_json::to_vec(&report).unwrap().len();
        assert_eq!(
            report.cost_diagnostics.as_ref().unwrap().response_bytes,
            bytes
        );
        assert_eq!(
            report
                .cost_diagnostics
                .as_ref()
                .unwrap()
                .provider_request_count,
            Some(1)
        );
        assert_eq!(
            serde_json::to_value(&report).unwrap()["conclusion"],
            response["conclusion"]
        );
        assert!(build(bytes).is_ok());
        assert!(build(bytes - 1).is_err());
    }

    #[tokio::test]
    async fn usage_is_request_local_and_cancelled_collection_does_not_leak() {
        async fn request(model: &str) -> Vec<ProviderCall> {
            capture_usage(true, async {
                record_provider_call(provider_call(model));
                tokio::task::yield_now().await;
                record_provider_call(provider_call(model));
            })
            .await
            .1
            .unwrap()
        }
        let (first, second) = tokio::join!(request("first"), request("second"));
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert!(first.iter().all(|call| call.model == "first"));
        assert!(second.iter().all(|call| call.model == "second"));
        tokio::select! {
            biased;
            _ = capture_usage(true, async {
                record_provider_call(provider_call("cancelled"));
                std::future::pending::<()>().await;
            }) => unreachable!(),
            _ = async {} => {}
        }
        let (_, disabled) = capture_usage(false, async {
            record_provider_call(provider_call("disabled"));
        })
        .await;
        assert!(disabled.is_none());
        assert!(capture_usage(true, async {}).await.1.unwrap().is_empty());
    }
}
