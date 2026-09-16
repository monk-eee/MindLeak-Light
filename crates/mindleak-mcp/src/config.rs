use std::path::PathBuf;

use anyhow::{ensure, Context, Result};
use reqwest::Url;

pub struct Config {
    pub database_url: String,
    pub database_ca: Option<PathBuf>,
    pub pool_size: usize,
    pub decomposition: Option<ModelConfig>,
    pub embeddings: Option<EmbeddingConfig>,
    pub model_timeout_secs: u64,
    pub http_token: String,
}

pub struct ModelConfig {
    pub endpoint: Url,
    pub model: String,
    pub api_key: String,
}

pub struct EmbeddingConfig {
    pub provider: ModelConfig,
    pub dimensions: usize,
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
        let model_config = |url_name: &str,
                            model_name: &str,
                            key_name: &str,
                            route: &str|
         -> Result<ModelConfig> {
            let model = read(model_name).with_context(|| {
                format!("{model_name} is required when its model mode is enabled")
            })?;
            ensure!(!model.trim().is_empty(), "{model_name} must not be blank");
            let base = read(url_name).with_context(|| {
                format!("{url_name} is required when its model mode is enabled")
            })?;
            Ok(ModelConfig {
                endpoint: endpoint(&base, route)?,
                model,
                api_key: setting(key_name, ""),
            })
        };
        let decomposition = match setting("MINDLEAK_DECOMPOSITION", "sentences").as_str() {
            "sentences" => None,
            "openai" => Some(model_config(
                "MINDLEAK_LLM_URL",
                "MINDLEAK_MODEL",
                "MINDLEAK_LLM_API_KEY",
                "chat/completions",
            )?),
            _ => anyhow::bail!("MINDLEAK_DECOMPOSITION must be sentences or openai"),
        };
        let embeddings = match setting("MINDLEAK_RETRIEVAL", "keyword").as_str() {
            "keyword" => None,
            "vector" => Some(EmbeddingConfig {
                provider: model_config(
                    "MINDLEAK_EMBED_URL",
                    "MINDLEAK_EMBED_MODEL",
                    "MINDLEAK_EMBED_API_KEY",
                    "embeddings",
                )?,
                dimensions: positive(
                    &read("MINDLEAK_EMBED_DIMENSIONS")
                        .context("MINDLEAK_EMBED_DIMENSIONS is required for vector retrieval")?,
                    "MINDLEAK_EMBED_DIMENSIONS",
                    2000,
                )?,
            }),
            _ => anyhow::bail!("MINDLEAK_RETRIEVAL must be keyword or vector"),
        };
        let model_timeout_secs = if decomposition.is_some() || embeddings.is_some() {
            positive(
                &setting("MINDLEAK_MODEL_TIMEOUT_SECS", "60"),
                "MINDLEAK_MODEL_TIMEOUT_SECS",
                300,
            )? as u64
        } else {
            60
        };
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
            decomposition,
            embeddings,
            model_timeout_secs,
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
    fn defaults_need_only_postgres_and_no_model_settings() {
        let config = Config::load(|name| {
            (name == "MINDLEAK_DATABASE_URL").then(|| "postgresql://localhost/memory".into())
        })
        .unwrap();
        assert!(config.decomposition.is_none());
        assert!(config.embeddings.is_none());
    }

    #[test]
    fn malformed_settings_never_silently_use_defaults() {
        assert!(Config::load(|_| None).is_err());
        for (name, value) in [
            ("MINDLEAK_DATABASE_URL", " "),
            ("MINDLEAK_DB_POOL_SIZE", "0"),
            ("MINDLEAK_DECOMPOSITION", "auto"),
            ("MINDLEAK_RETRIEVAL", ""),
            ("MINDLEAK_DECOMPOSITION", "openai"),
            ("MINDLEAK_RETRIEVAL", "vector"),
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
    fn disabled_model_settings_are_not_parsed_or_required() {
        let config = Config::load(|name| {
            Some(if name == "MINDLEAK_DATABASE_URL" {
                "postgresql://localhost/memory".into()
            } else if name == "MINDLEAK_DECOMPOSITION" {
                "sentences".into()
            } else if name == "MINDLEAK_RETRIEVAL" {
                "keyword".into()
            } else if name == "MINDLEAK_DB_POOL_SIZE" {
                "8".into()
            } else {
                "unused invalid model setting".into()
            })
        })
        .unwrap();
        assert!(config.decomposition.is_none() && config.embeddings.is_none());
    }

    #[test]
    fn lm_studio_chat_and_embeddings_are_independently_optional() {
        for (chat, vector) in [(true, false), (false, true), (true, true)] {
            let config = Config::load(|name| match name {
                "MINDLEAK_DATABASE_URL" => Some("postgresql://localhost/memory".into()),
                "MINDLEAK_DECOMPOSITION" if chat => Some("openai".into()),
                "MINDLEAK_RETRIEVAL" if vector => Some("vector".into()),
                "MINDLEAK_LLM_URL" | "MINDLEAK_EMBED_URL" => {
                    Some("http://localhost:1234/v1".into())
                }
                "MINDLEAK_MODEL" => Some("my-chat-model".into()),
                "MINDLEAK_EMBED_MODEL" => Some("my-embedding-model".into()),
                "MINDLEAK_EMBED_DIMENSIONS" => Some("768".into()),
                _ => None,
            })
            .unwrap();
            assert_eq!(config.decomposition.is_some(), chat);
            assert_eq!(config.embeddings.is_some(), vector);
            if let Some(model) = config.decomposition {
                assert_eq!(
                    model.endpoint.as_str(),
                    "http://localhost:1234/v1/chat/completions"
                );
            }
            if let Some(embedding) = config.embeddings {
                assert_eq!(
                    embedding.provider.endpoint.as_str(),
                    "http://localhost:1234/v1/embeddings"
                );
                assert_eq!(embedding.dimensions, 768);
            }
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
