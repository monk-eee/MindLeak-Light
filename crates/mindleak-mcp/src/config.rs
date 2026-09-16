use std::path::PathBuf;

use anyhow::{ensure, Context, Result};
use reqwest::Url;

pub struct Config {
    pub database_url: String,
    pub database_ca: Option<PathBuf>,
    pub pool_size: usize,
    pub decomposition: Option<ModelConfig>,
    pub embeddings: Option<EmbeddingConfig>,
    pub relevance: Option<ModelConfig>,
    pub relevance_candidates: usize,
    pub decomposition_reasoning_effort: Option<String>,
    pub relevance_reasoning_effort: Option<String>,
    pub retrieval: RetrievalMode,
    pub min_similarity: Option<f64>,
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RetrievalMode {
    Keyword,
    Vector,
    Hybrid,
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
        let retrieval = match setting("MINDLEAK_RETRIEVAL", "keyword").as_str() {
            "keyword" => RetrievalMode::Keyword,
            "vector" => RetrievalMode::Vector,
            "hybrid" => RetrievalMode::Hybrid,
            _ => anyhow::bail!("MINDLEAK_RETRIEVAL must be keyword, vector, or hybrid"),
        };
        let embeddings = match retrieval {
            RetrievalMode::Keyword => None,
            RetrievalMode::Vector | RetrievalMode::Hybrid => Some(EmbeddingConfig {
                provider: model_config(
                    "MINDLEAK_EMBED_URL",
                    "MINDLEAK_EMBED_MODEL",
                    "MINDLEAK_EMBED_API_KEY",
                    "embeddings",
                )?,
                dimensions: positive(
                    &read("MINDLEAK_EMBED_DIMENSIONS").context(
                        "MINDLEAK_EMBED_DIMENSIONS is required for model-backed retrieval",
                    )?,
                    "MINDLEAK_EMBED_DIMENSIONS",
                    2000,
                )?,
            }),
        };
        let min_similarity = if embeddings.is_some() {
            read("MINDLEAK_RECALL_MIN_SIMILARITY")
                .map(|value| -> Result<f64> {
                    let number: f64 = value
                        .parse()
                        .context("MINDLEAK_RECALL_MIN_SIMILARITY must be a number in -1..=1")?;
                    ensure!(
                        number.is_finite() && (-1.0..=1.0).contains(&number),
                        "MINDLEAK_RECALL_MIN_SIMILARITY must be finite and in -1..=1"
                    );
                    Ok(number)
                })
                .transpose()?
        } else {
            None
        };
        let relevance = match setting("MINDLEAK_RELEVANCE", "off").as_str() {
            "off" => None,
            "openai" => Some(model_config(
                "MINDLEAK_RELEVANCE_URL",
                "MINDLEAK_RELEVANCE_MODEL",
                "MINDLEAK_RELEVANCE_API_KEY",
                "chat/completions",
            )?),
            _ => anyhow::bail!("MINDLEAK_RELEVANCE must be off or openai"),
        };
        let relevance_candidates = if relevance.is_some() {
            positive(
                &setting("MINDLEAK_RELEVANCE_CANDIDATES", "20"),
                "MINDLEAK_RELEVANCE_CANDIDATES",
                50,
            )?
        } else {
            20
        };
        let model_timeout_secs =
            if decomposition.is_some() || embeddings.is_some() || relevance.is_some() {
                positive(
                    &setting("MINDLEAK_MODEL_TIMEOUT_SECS", "60"),
                    "MINDLEAK_MODEL_TIMEOUT_SECS",
                    300,
                )? as u64
            } else {
                60
            };
        let reasoning_effort = |name: &str, enabled: bool| -> Result<Option<String>> {
            let value = enabled
                .then(|| read(name))
                .flatten()
                .filter(|value| !value.is_empty());
            ensure!(
                value
                    .as_deref()
                    .is_none_or(|value| ["none", "low", "medium", "high", "max"].contains(&value)),
                "{name} must be none, low, medium, high, or max"
            );
            Ok(value)
        };
        let decomposition_reasoning_effort =
            reasoning_effort("MINDLEAK_LLM_REASONING_EFFORT", decomposition.is_some())?;
        let relevance_reasoning_effort =
            reasoning_effort("MINDLEAK_RELEVANCE_REASONING_EFFORT", relevance.is_some())?;
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
            relevance,
            relevance_candidates,
            decomposition_reasoning_effort,
            relevance_reasoning_effort,
            retrieval,
            min_similarity,
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
            } else if name == "MINDLEAK_RELEVANCE" {
                "off".into()
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

    #[test]
    fn relevance_requires_explicit_model_configuration_and_a_bounded_candidate_pool() {
        let load = |limit: &str| {
            Config::load(|name| match name {
                "MINDLEAK_DATABASE_URL" => Some("postgresql://localhost/memory".into()),
                "MINDLEAK_RELEVANCE" => Some("openai".into()),
                "MINDLEAK_RELEVANCE_URL" => Some("http://localhost:1234/v1".into()),
                "MINDLEAK_RELEVANCE_MODEL" => Some("small-relevance-model".into()),
                "MINDLEAK_RELEVANCE_CANDIDATES" => Some(limit.into()),
                _ => None,
            })
        };
        let config = load("12").unwrap();
        assert!(config.decomposition.is_none() && config.embeddings.is_none());
        assert_eq!(config.relevance_candidates, 12);
        assert_eq!(config.relevance.unwrap().model, "small-relevance-model");
        for invalid in ["0", "51", "NaN", "", "1.5"] {
            assert!(load(invalid).is_err());
        }
        assert!(Config::load(|name| match name {
            "MINDLEAK_DATABASE_URL" => Some("postgresql://localhost/memory".into()),
            "MINDLEAK_RELEVANCE" => Some("openai".into()),
            _ => None,
        })
        .is_err());
    }

    #[test]
    fn reasoning_effort_requires_an_explicit_enabled_chat_provider() {
        for (value, expected) in [(None, None), (Some(""), None), (Some("none"), Some("none"))] {
            let config = Config::load(|name| match name {
                "MINDLEAK_DATABASE_URL" => Some("postgresql://localhost/memory".into()),
                "MINDLEAK_RELEVANCE" => Some("openai".into()),
                "MINDLEAK_RELEVANCE_URL" => Some("http://localhost:1234/v1".into()),
                "MINDLEAK_RELEVANCE_MODEL" => Some("test-model".into()),
                "MINDLEAK_RELEVANCE_REASONING_EFFORT" => value.map(str::to_owned),
                "MINDLEAK_LLM_REASONING_EFFORT" => Some("disabled-invalid".into()),
                _ => None,
            })
            .unwrap();
            assert_eq!(config.relevance_reasoning_effort.as_deref(), expected);
            assert_eq!(config.decomposition_reasoning_effort, None);
        }
    }

    #[test]
    fn hybrid_configuration_validates_explicit_similarity_floors() {
        let load = |minimum: Option<&str>| {
            Config::load(|name| match name {
                "MINDLEAK_DATABASE_URL" => Some("postgresql://localhost/memory".into()),
                "MINDLEAK_RETRIEVAL" => Some("hybrid".into()),
                "MINDLEAK_EMBED_URL" => Some("http://localhost:1234/v1".into()),
                "MINDLEAK_EMBED_MODEL" => Some("embedding-model".into()),
                "MINDLEAK_EMBED_DIMENSIONS" => Some("768".into()),
                "MINDLEAK_RECALL_MIN_SIMILARITY" => minimum.map(str::to_owned),
                _ => None,
            })
        };
        let config = load(None).unwrap();
        assert_eq!(config.retrieval, RetrievalMode::Hybrid);
        assert!(config.embeddings.is_some());
        assert_eq!(config.min_similarity, None);
        for minimum in ["-1", "0", "0.8", "1"] {
            assert_eq!(
                load(Some(minimum)).unwrap().min_similarity,
                minimum.parse().ok()
            );
        }
        for minimum in ["", "NaN", "inf", "-1.01", "1.01"] {
            assert!(load(Some(minimum)).is_err());
        }
    }
}
