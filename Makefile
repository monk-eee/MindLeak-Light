.PHONY: setup build test test-postgres script-test fmt fmt-check clippy adr-index changelog repo-check ci up down

COMPOSE ?= docker compose

setup:
	cargo fetch --locked
	pre-commit install --install-hooks

build:
	cargo build --workspace --locked

test:
	cargo test --workspace --locked

test-postgres:
	cargo test --workspace --all-features --locked

script-test:
	node --test scripts/repository.test.mjs examples/benchmark-recall.test.mjs examples/validation-harness.test.mjs

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

clippy:
	cargo clippy --workspace --all-targets --all-features --locked -- -D warnings

adr-index:
	node scripts/adr-index.mjs

changelog:
	node scripts/changelog.mjs --preview

repo-check:
	node scripts/check-repo.mjs

ci: fmt-check clippy repo-check test-postgres

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down
