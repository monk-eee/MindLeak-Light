use anyhow::{ensure, Context, Result};
use reqwest::Response;
use serde::de::DeserializeOwned;

pub const MAX_PROVIDER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub async fn read_json_response<T: DeserializeOwned>(mut response: Response) -> Result<T> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= MAX_PROVIDER_RESPONSE_BYTES as u64),
        "provider response exceeds the 4 MiB limit"
    );
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)
        .context("read provider response body")?
    {
        ensure!(
            chunk.len() <= MAX_PROVIDER_RESPONSE_BYTES - body.len(),
            "provider response exceeds the 4 MiB limit"
        );
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| anyhow::anyhow!("provider returned invalid JSON"))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use futures_util::stream;
    use reqwest::Body;
    use serde_json::{json, Value};

    use super::*;

    #[tokio::test]
    async fn valid_json_at_the_exact_response_limit_is_accepted() {
        let mut body = br#"{"ok":true}"#.to_vec();
        body.resize(MAX_PROVIDER_RESPONSE_BYTES, b' ');
        let response = http::Response::new(body);
        assert_eq!(
            read_json_response::<Value>(response.into()).await.unwrap(),
            json!({"ok": true})
        );
    }

    #[tokio::test]
    async fn oversized_known_lengths_are_rejected_before_json_parsing() {
        let response: Response = http::Response::builder()
            .header(
                http::header::CONTENT_LENGTH,
                MAX_PROVIDER_RESPONSE_BYTES + 1,
            )
            .body(vec![b' '; MAX_PROVIDER_RESPONSE_BYTES + 1])
            .unwrap()
            .into();
        assert_eq!(
            response.content_length(),
            Some((MAX_PROVIDER_RESPONSE_BYTES + 1) as u64)
        );
        let error = read_json_response::<Value>(response).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "provider response exceeds the 4 MiB limit"
        );
    }

    #[tokio::test]
    async fn streamed_bodies_are_bounded_even_with_misleading_lengths() {
        for declared_length in [None, Some(1)] {
            let reads = Arc::new(AtomicUsize::new(0));
            let observed = reads.clone();
            let chunks = stream::iter((0..10).map(move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok::<_, std::io::Error>(vec![b' '; 1024 * 1024])
            }));
            let mut response = http::Response::builder();
            if let Some(length) = declared_length {
                response = response.header(http::header::CONTENT_LENGTH, length);
            }
            let response = response.body(Body::wrap_stream(chunks)).unwrap().into();
            let error = read_json_response::<Value>(response).await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "provider response exceeds the 4 MiB limit"
            );
            assert_eq!(
                reads.load(Ordering::SeqCst),
                5,
                "stop consuming the stream at the first oversized chunk"
            );
        }
    }

    #[tokio::test]
    async fn broken_streams_and_invalid_json_fail_without_echoing_the_body() {
        let chunks = stream::iter([
            Ok(b"{\"private-test-value\":\"".to_vec()),
            Err(std::io::Error::other("connection interrupted")),
        ]);
        let response = http::Response::new(Body::wrap_stream(chunks));
        let error = read_json_response::<Value>(response.into())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "read provider response body");
        assert!(!format!("{error:#}").contains("private-test-value"));

        let response = http::Response::new("invalid-json-private-test-value");
        let error = read_json_response::<Value>(response.into())
            .await
            .unwrap_err();
        assert_eq!(format!("{error:#}"), "provider returned invalid JSON");
    }
}
