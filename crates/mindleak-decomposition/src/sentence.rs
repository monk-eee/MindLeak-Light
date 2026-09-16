use anyhow::Result;
use async_trait::async_trait;
use mindleak_memory::{normalize_fragments, validate_text, MemoryDecomposer, MAX_MEMORY_BYTES};
use unicode_segmentation::UnicodeSegmentation;

pub struct SentenceDecomposer;

#[async_trait]
impl MemoryDecomposer for SentenceDecomposer {
    async fn decompose(&self, text: &str) -> Result<Vec<String>> {
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        let fragments = text
            .lines()
            .flat_map(|line| {
                let line = line.trim();
                let line = ["- ", "* ", "+ ", "\u{2022} "]
                    .iter()
                    .find_map(|marker| line.strip_prefix(marker))
                    .unwrap_or(line);
                let line = line
                    .split_once(". ")
                    .filter(|(prefix, _)| {
                        !prefix.is_empty()
                            && prefix.chars().all(|character| character.is_ascii_digit())
                    })
                    .map_or(line, |(_, content)| content);
                line.unicode_sentences().map(str::to_owned)
            })
            .collect();
        normalize_fragments(fragments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mindleak_memory::{MAX_FRAGMENTS, MAX_FRAGMENT_BYTES};

    #[tokio::test]
    async fn extracts_the_pr_example_without_any_model_or_rewriting() {
        let fragments = SentenceDecomposer.decompose(
            "The user dislikes huge PRs. The team requires reviews. PRs under 500 LOC get merged faster."
        ).await.unwrap();
        assert_eq!(
            fragments,
            [
                "The user dislikes huge PRs.",
                "The team requires reviews.",
                "PRs under 500 LOC get merged faster."
            ]
        );
    }

    #[tokio::test]
    async fn respects_lists_negation_and_duplicate_lines() {
        let fragments = SentenceDecomposer.decompose(
            "- Never rebase shared branches\n\n* Reviews are required\n1. Keep PRs small\n2. Keep PRs small"
        ).await.unwrap();
        assert_eq!(
            fragments,
            [
                "Never rebase shared branches",
                "Reviews are required",
                "Keep PRs small"
            ]
        );
    }

    #[tokio::test]
    async fn preserves_versions_and_decimal_numbers() {
        assert_eq!(
            SentenceDecomposer
                .decompose("Use Rust 1.88.0. Allow 1.5 seconds.")
                .await
                .unwrap(),
            ["Use Rust 1.88.0.", "Allow 1.5 seconds."]
        );
    }

    #[tokio::test]
    async fn preserves_causal_conditional_and_attributed_clauses_without_guessing() {
        for source in [
            "John approved the PR because Sarah requested it.",
            "Eira will reopen the issue if Oren confirms the rollback.",
            "Tess reported that Ula rejected the patch because the tests failed.",
            "Rhea restored the service because the lock expired, not because storage was exhausted.",
        ] {
            assert_eq!(SentenceDecomposer.decompose(source).await.unwrap(), [source]);
        }
    }

    #[tokio::test]
    async fn refuses_empty_or_unbounded_fragments() {
        for text in [
            String::new(),
            " \n\t ".into(),
            "x".repeat(MAX_FRAGMENT_BYTES + 1),
            "A fact. ".repeat(MAX_FRAGMENTS + 1),
        ] {
            assert!(SentenceDecomposer.decompose(&text).await.is_err());
        }
    }
}
