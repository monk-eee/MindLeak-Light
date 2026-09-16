mod relevance;

pub use relevance::OpenAiRelevanceRetriever;

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use mindleak_memory::{validate_embeddings, TextEmbedder, MAX_FRAGMENTS};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::json;

#[derive(Clone)]
pub struct OpenAiEmbedder {
    client: Client,
    endpoint: Url,
    model: String,
    api_key: String,
    dimensions: usize,
}

impl OpenAiEmbedder {
    pub fn new(
        client: Client,
        endpoint: Url,
        model: String,
        api_key: String,
        dimensions: usize,
    ) -> Result<Self> {
        validate_embeddings(&[], 0, dimensions)?;
        Ok(Self {
            client,
            endpoint,
            model,
            api_key,
            dimensions,
        })
    }
}

#[async_trait]
impl TextEmbedder for OpenAiEmbedder {
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        ensure!(texts.len() <= MAX_FRAGMENTS, "embedding batch is too large");
        let mut request = self.client.post(self.endpoint.clone()).json(&json!({
            "model": self.model,
            "input": texts,
            "encoding_format": "float"
        }));
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response: EmbeddingResponse = request
            .send()
            .await
            .map_err(reqwest::Error::without_url)
            .context("embedding model request failed")?
            .error_for_status()
            .map_err(reqwest::Error::without_url)
            .context("embedding model returned an HTTP error")?
            .json()
            .await
            .context("embedding model returned invalid JSON")?;
        ordered_embeddings(response, texts.len(), self.dimensions)
    }
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    index: usize,
    embedding: Vec<f32>,
}

fn ordered_embeddings(
    mut response: EmbeddingResponse,
    expected_count: usize,
    dimensions: usize,
) -> Result<Vec<Vec<f32>>> {
    response.data.sort_by_key(|item| item.index);
    for (index, item) in response.data.iter().enumerate() {
        ensure!(
            item.index == index,
            "embedding response has duplicate or missing indices"
        );
    }
    let embeddings: Vec<_> = response
        .data
        .into_iter()
        .map(|item| item.embedding)
        .collect();
    validate_embeddings(&embeddings, expected_count, dimensions)?;
    Ok(embeddings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{body_json, header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn batches_inputs_and_restores_provider_index_order() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/embeddings"))
            .and(header("authorization", "Bearer test-key"))
            .and(body_json(json!({
                "model": "test-model", "input": ["first", "second"], "encoding_format": "float"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [
                {"index": 1, "embedding": [0.0, 1.0]},
                {"index": 0, "embedding": [1.0, 0.0]}
            ]})))
            .expect(1)
            .mount(&server)
            .await;
        let embedder = OpenAiEmbedder::new(
            Client::new(),
            Url::parse(&format!("{}/v1/embeddings", server.uri())).unwrap(),
            "test-model".into(),
            "test-key".into(),
            2,
        )
        .unwrap();
        assert_eq!(
            embedder
                .embed_batch(&["first".into(), "second".into()])
                .await
                .unwrap(),
            [vec![1.0, 0.0], vec![0.0, 1.0]]
        );
    }

    #[tokio::test]
    async fn an_unavailable_model_returns_an_error_not_a_fake_vector() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let embedder = OpenAiEmbedder::new(
            Client::new(),
            Url::parse(&server.uri()).unwrap(),
            "test".into(),
            String::new(),
            2,
        )
        .unwrap();
        assert!(embedder.embed_batch(&["fact".into()]).await.is_err());
        assert!(embedder.embed_batch(&[]).await.unwrap().is_empty());
    }

    #[test]
    fn rejects_missing_duplicate_or_out_of_range_indices_and_invalid_vectors() {
        for data in [
            json!([]),
            json!([{"index": 0, "embedding": [1, 0]}]),
            json!([{"index": 0, "embedding": [1, 0]}, {"index": 0, "embedding": [0, 1]}]),
            json!([{"index": 0, "embedding": [1, 0]}, {"index": 2, "embedding": [0, 1]}]),
            json!([{"index": 0, "embedding": [1]}, {"index": 1, "embedding": [0, 1]}]),
            json!([{"index": 0, "embedding": [0, 0]}, {"index": 1, "embedding": [0, 1]}]),
        ] {
            let response = serde_json::from_value(json!({"data": data})).unwrap();
            assert!(ordered_embeddings(response, 2, 2).is_err());
        }
        for content in [
            r#"{"data":[{"index":0,"embedding":["1",0]}]}"#,
            r#"{"data":[{"embedding":[1,0]}]}"#,
            r#"{"data":[{"index":-1,"embedding":[1,0]}]}"#,
        ] {
            assert!(serde_json::from_str::<EmbeddingResponse>(content).is_err());
        }
        let response =
            serde_json::from_str(r#"{"data":[{"index":0,"embedding":[1e100,1]}]}"#).unwrap();
        assert!(ordered_embeddings(response, 1, 2).is_err());
    }
}
