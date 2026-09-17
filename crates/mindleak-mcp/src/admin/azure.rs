use std::path::PathBuf;

use chrono::Utc;
use reqwest::{Client, StatusCode, Url};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    failure, security,
    settings::{BackupConfig, Repository},
    AdminResult,
};

pub(super) async fn destination(
    repository: &Repository,
    cancel: &CancellationToken,
) -> AdminResult<Option<Url>> {
    let Repository::Azure {
        container,
        account_env,
        sas_env,
        account_file,
        sas_file,
        ..
    } = repository
    else {
        return Ok(None);
    };
    let account =
        security::reference(account_env.as_deref(), account_file.as_deref(), cancel).await?;
    let sas = security::reference(sas_env.as_deref(), sas_file.as_deref(), cancel).await?;
    if !(3..=24).contains(&account.len())
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || sas.len() > 65536
        || sas.is_empty()
        || sas.contains(['\r', '\n', '\0', '#'])
    {
        return Err(failure("secret", "invalid_azure_credentials", 2));
    }
    let mut url = Url::parse(&format!(
        "https://{account}.blob.core.windows.net/{container}"
    ))
    .map_err(|_| failure("configuration", "invalid_azure_destination", 2))?;
    url.set_query(Some(sas.trim_start_matches('?')));
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.iter().filter(|(name, _)| name == "sig").count() != 1
        || pairs
            .iter()
            .any(|(name, value)| value.is_empty() || ["comp", "restype"].contains(&name.as_ref()))
    {
        return Err(failure("secret", "invalid_azure_sas", 2));
    }
    url.query_pairs_mut().append_pair("restype", "container");
    Ok(Some(url))
}

fn client() -> AdminResult<Client> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| failure("repository", "azure_client_failed", 2))
}

pub(super) async fn access(
    config: &BackupConfig,
    require_empty: bool,
    cancel: &CancellationToken,
) -> AdminResult<()> {
    let Some(mut url) = destination(&config.repository, cancel).await? else {
        return Ok(());
    };
    let client = client()?;
    let response = tokio::select! { _ = cancel.cancelled() => return Err(failure("repository", "cancelled", 130)),
    response = client.head(url.clone()).send() => response.map_err(|_| failure("repository", "azure_access_failed", 3))? };
    if !response.status().is_success() {
        return Err(failure(
            "repository",
            "azure_container_must_already_exist",
            2,
        ));
    }
    if !require_empty {
        return Ok(());
    }
    let Repository::Azure { prefix, .. } = &config.repository else {
        unreachable!()
    };
    url.query_pairs_mut()
        .append_pair("comp", "list")
        .append_pair("prefix", &format!("{prefix}/"))
        .append_pair("maxresults", "1");
    let mut response = tokio::select! { _ = cancel.cancelled() => return Err(failure("init", "cancelled", 130)),
    response = client.get(url).send() => response.map_err(|_| failure("init", "azure_inventory_failed", 3))? };
    if !response.status().is_success() {
        return Err(failure("init", "azure_inventory_failed", 3));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 65536)
    {
        return Err(failure("init", "azure_inventory_too_large", 3));
    }
    let mut body = Vec::new();
    loop {
        let chunk = tokio::select! { _ = cancel.cancelled() => return Err(failure("init", "cancelled", 130)),
        chunk = response.chunk() => chunk.map_err(|_| failure("init", "azure_inventory_failed", 3))? };
        let Some(chunk) = chunk else {
            break;
        };
        if body.len() + chunk.len() > 65536 {
            return Err(failure("init", "azure_inventory_too_large", 3));
        }
        body.extend_from_slice(&chunk);
    }
    let mut reader = quick_xml::Reader::from_reader(body.as_slice());
    let mut root = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(element))
            | Ok(quick_xml::events::Event::Empty(element)) => match element.name().as_ref() {
                b"EnumerationResults" => root = true,
                b"Blob" => return Err(failure("init", "repository_not_empty", 2)),
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => return Err(failure("init", "invalid_azure_inventory", 3)),
            _ => {}
        }
    }
    if !root {
        return Err(failure("init", "invalid_azure_inventory", 3));
    }
    Ok(())
}

pub(super) struct Lease {
    url: Url,
    id: Uuid,
    path: PathBuf,
}

impl Lease {
    pub async fn acquire(
        config: &BackupConfig,
        cancel: &CancellationToken,
    ) -> AdminResult<Option<Self>> {
        let Some(url) = destination(&config.repository, cancel).await? else {
            return Ok(None);
        };
        Self::acquire_at(url, config.work_dir.join("azure-lease.json"), cancel)
            .await
            .map(Some)
    }

    async fn acquire_at(
        mut url: Url,
        path: PathBuf,
        cancel: &CancellationToken,
    ) -> AdminResult<Self> {
        if path.exists() {
            return Err(failure(
                "lock",
                "unresolved_azure_lease_requires_operator_review",
                6,
            ));
        }
        let id = Uuid::new_v4();
        let lease = Self {
            url: {
                url.query_pairs_mut().append_pair("comp", "lease");
                url
            },
            id,
            path,
        };
        let mut record = security::create_file(&lease.path)?;
        serde_json::to_writer(&mut record, &json!({"leaseId":id,"startedAt":Utc::now(),"processId":std::process::id(),"state":"acquiring"})).map_err(|_| failure("lock", "lease_record_failed", 6))?;
        record
            .sync_all()
            .map_err(|_| failure("lock", "lease_record_failed", 6))?;
        let requested = lease.request("acquire");
        let response = tokio::select! { _ = cancel.cancelled() => return Err(failure("lock", "cancelled", 130).detail("leaseId", json!(id)).detail("operationState", json!("outcomeUnknown"))), response = requested => response? };
        if response.status() == StatusCode::CONFLICT
            || response.status() == StatusCode::PRECONDITION_FAILED
        {
            std::fs::remove_file(&lease.path)
                .map_err(|_| failure("lock", "lease_record_cleanup_failed", 6))?;
            return Err(failure("lock", "remote_repository_in_use", 6));
        }
        if response.status() != StatusCode::CREATED
            || response
                .headers()
                .get("x-ms-lease-id")
                .and_then(|id| id.to_str().ok())
                .and_then(|id| Uuid::parse_str(id).ok())
                != Some(id)
        {
            return Err(
                failure("lock", "azure_lease_not_acknowledged", 6).detail("leaseId", json!(id))
            );
        }
        security::atomic_json(
            &lease.path,
            &json!({"leaseId":id,"startedAt":Utc::now(),"processId":std::process::id(),"state":"held"}),
        )?;
        Ok(lease)
    }

    async fn request(&self, action: &str) -> AdminResult<reqwest::Response> {
        let mut request = client()?
            .put(self.url.clone())
            .header("x-ms-version", "2023-11-03")
            .header(
                "x-ms-date",
                Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
            )
            .header("x-ms-lease-action", action)
            .header("Content-Length", "0");
        request = if action == "acquire" {
            request
                .header("x-ms-lease-duration", "-1")
                .header("x-ms-proposed-lease-id", self.id.to_string())
        } else {
            request.header("x-ms-lease-id", self.id.to_string())
        };
        request.send().await.map_err(|_| {
            failure("lock", "azure_lease_outcome_unknown", 6).detail("leaseId", json!(self.id))
        })
    }

    pub async fn release(self, result: AdminResult<Value>) -> AdminResult<Value> {
        let released = self.request("release").await;
        if released.is_ok_and(|response| response.status() == StatusCode::OK)
            && std::fs::remove_file(&self.path).is_ok()
        {
            return result;
        }
        let error =
            failure("lock", "azure_lease_release_failed", 6).detail("leaseId", json!(self.id));
        match result {
            Ok(value) => Err(error.detail("operationResult", value)),
            Err(primary) => Err(primary.detail("leaseReleaseError", json!(error))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{header, method},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn lease_uses_acknowledged_owner_and_releases_after_failure() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(header("x-ms-lease-action", "acquire"))
            .respond_with(|request: &wiremock::Request| {
                ResponseTemplate::new(201).insert_header(
                    "x-ms-lease-id",
                    request
                        .headers
                        .get("x-ms-proposed-lease-id")
                        .unwrap()
                        .to_str()
                        .unwrap(),
                )
            })
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(header("x-ms-lease-action", "release"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("lease.json");
        let lease = Lease::acquire_at(
            server.uri().parse().unwrap(),
            path.clone(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let id = lease.id;
        let result = lease
            .release(Err(failure("fixture", "original_error", 3)))
            .await;
        assert_eq!(result.err().unwrap().code, "original_error");
        assert!(!path.exists());
        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests[1]
                .headers
                .get("x-ms-lease-id")
                .unwrap()
                .to_str()
                .unwrap(),
            id.to_string()
        );
    }
}
