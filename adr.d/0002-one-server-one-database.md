# ADR-0002: One Server, One Database

- Status: Accepted
- Date: 2026-09-16

## Context

The requested product is shared agent memory, not MindLeak's full coordination
platform. Multiple agents need concurrent durable writes and remote deployment.

## Decision

Use a Rust workspace matching MindLeak, with memory, decomposition, embeddings,
Postgres storage, and MCP crates. Ship one `mindleak-light` executable with stdio
and Streamable HTTP transports. Use PostgreSQL and pgvector with exactly three
application tables: memories, fragments, relationships.

## Consequences

Postgres is required even locally. Library crates are not microservices. Models
are supplied by an existing OpenAI-compatible endpoint, not another service in
the Compose topology. No SQLite, event bus, graph engine, projections, or CQRS.

## Verification

The Postgres integration suite checks the exact application table set. MCP
contract tests check the three advertised tools and both transports.
