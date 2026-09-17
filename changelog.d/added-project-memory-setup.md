- Add workspace-local `agent setup` and `agent check` commands that install the
  canonical memory skill and managed activation policy for VS Code, Claude Code,
  and Codex without rewriting their existing MCP configuration or global profiles.
- Support explicit `--general` shared memory without scope or `--scope` project
  filtering. General recall searches across scopes; existing scoped installations
  never broaden implicitly. Update the canonical skill and recipes to v1.1.0.
- Preserve project rules, record the chosen mode and optional scope, detect conflicting edits,
  and support dry runs and repeatable updates of owned instruction resources.
- Add explicit HTTP/stdio SDK connection checks with environment-backed token
  support and separate installed, connected, and unmeasured-agent states; no
  memory writes or model requests are made by the checks.
- Include a compact memory-use reminder in existing MCP initialization
  instructions while retaining the same three-tool contract and approval boundaries.
