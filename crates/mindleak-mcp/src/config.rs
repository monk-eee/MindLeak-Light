use std::path::PathBuf;

use anyhow::{ensure, Context, Result};
use reqwest::Url;

pub struct Config {
    pub database_url: String,
    pub database_ca: Option<PathBuf>,
    pub pool_size: usize,
    pub llm_endpoint: Url,
    pub llm_model: String,
    pub llm_api_key: String,
    pub embed_endpoint: Url,
    pub embed_model: String,
    pub embed_api_key: String,
    pub dimensions: usize,
    pub model_timeout_secs: u64,
    pub http_token: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::load(|name| std::env::var(name).ok())
    }

    fn load(read: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let setting = |name: &str, default: &str| read(name).unwrap_or_else(|| default.into());
        let database_url =
            read("MINDLEAK_DATABASE_URL").context("MINDLEAK_DATABASE_URL is required")?;
        ensure!(
            !database_url.trim().is_empty(),
            "MINDLEAK_DATABASE_URL must not be blank"
        );
        let llm_model = setting("MINDLEAK_MODEL", "glm4:9b");
        let embed_model = setting("MINDLEAK_EMBED_MODEL", "nomic-embed-text");
        ensure!(
            !llm_model.trim().is_empty() && !embed_model.trim().is_empty(),
            "model names must not be blank"
        );
        Ok(Self {
            database_url,
            database_ca: read("MINDLEAK_DATABASE_CA_FILE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            pool_size: positive(
                &setting("MINDLEAK_DB_POOL_SIZE", "8"),
                "MINDLEAK_DB_POOL_SIZE",
                64,
            )?,
            llm_endpoint: endpoint(
                &setting("MINDLEAK_LLM_URL", "http://localhost:11434/v1"),
                "chat/completions",
            )?,
            llm_model,
            llm_api_key: setting("MINDLEAK_LLM_API_KEY", ""),
            embed_endpoint: endpoint(
                &setting("MINDLEAK_EMBED_URL", "http://localhost:11434/v1"),
                "embeddings",
            )?,
            embed_model,
            embed_api_key: setting("MINDLEAK_EMBED_API_KEY", ""),
            dimensions: positive(
                &setting("MINDLEAK_EMBED_DIMENSIONS", "768"),
                "MINDLEAK_EMBED_DIMENSIONS",
                2000,
            )?,
            model_timeout_secs: positive(
                &setting("MINDLEAK_MODEL_TIMEOUT_SECS", "60"),
                "MINDLEAK_MODEL_TIMEOUT_SECS",
                300,
            )? as u64,
            http_token: setting("MINDLEAK_HTTP_TOKEN", ""),
        })
    }
}

fn positive(value: &str, name: &str, maximum: usize) -> Result<usize> {
    let number: usize = value
        .parse()
        .with_context(|| format!("{name} must be an integer"))?;
    ensure!(
        (1..=maximum).contains(&number),
        "{name} must be in 1..={maximum}"
    );
    Ok(number)
}

fn endpoint(base: &str, route: &str) -> Result<Url> {
    let mut base = Url::parse(base).context("model base URL must be an absolute HTTP(S) URL")?;
    ensure!(
        ["http", "https"].contains(&base.scheme())
            && base.host_str().is_some()
            && base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none(),
        "model base URL must be HTTP(S), without credentials, query, or fragment"
    );
    base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    Ok(base.join(route)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_mindleak_model_conventions() {
        let config = Config::load(|name| {
            (name == "MINDLEAK_DATABASE_URL").then(|| "postgresql://localhost/memory".into())
        })
        .unwrap();
        assert_eq!(config.embed_model, "nomic-embed-text");
        assert_eq!(config.llm_model, "glm4:9b");
        assert_eq!(config.dimensions, 768);
        assert_eq!(
            config.embed_endpoint.as_str(),
            "http://localhost:11434/v1/embeddings"
        );
    }

    #[test]
    fn malformed_settings_never_silently_use_defaults() {
        assert!(Config::load(|_| None).is_err());
        for (name, value) in [
            ("MINDLEAK_DATABASE_URL", " "),
            ("MINDLEAK_DB_POOL_SIZE", "0"),
            ("MINDLEAK_EMBED_DIMENSIONS", "abc"),
            ("MINDLEAK_EMBED_DIMENSIONS", "2001"),
            ("MINDLEAK_MODEL_TIMEOUT_SECS", "-1"),
            ("MINDLEAK_MODEL", " "),
        ] {
            assert!(Config::load(|key| {
                if key == name {
                    Some(value.into())
                } else if key == "MINDLEAK_DATABASE_URL" {
                    Some("postgresql://localhost/memory".into())
                } else {
                    None
                }
            })
            .is_err());
        }
    }

    #[test]
    fn endpoints_preserve_api_prefixes_and_refuse_embedded_credentials() {
        for base in ["http://localhost:11434/v1", "http://localhost:11434/v1/"] {
            assert_eq!(
                endpoint(base, "embeddings").unwrap().as_str(),
                "http://localhost:11434/v1/embeddings"
            );
        }
        for base in [
            "relative",
            "file:///tmp/model",
            "https://user:secret@example.com/v1",
            "https://example.com/v1?key=secret",
        ] {
            assert!(endpoint(base, "embeddings").is_err());
        }
    }
}
