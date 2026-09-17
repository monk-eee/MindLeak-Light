# ADR-0018: Project Memory Instruction Installation

- Status: Accepted
- Date: 2026-09-17

## Context

Connecting an MCP server makes tools available but does not establish when an
agent should recall or retain evidence. The companion skill provides that
workflow, but manually copying its resources and activation policy into each
client's instruction files is error-prone. Installation must preserve existing
project rules, credentials, the intended database, and normal client approvals.

## Decision

Add client-side `agent setup` and `agent check` commands to the existing binary.
Run them before server environment loading. Require an explicit supported
client, an existing named project MCP connection, and exactly one memory mode:
`--general` or `--scope` with a stable project scope. General writes omit
`context.scope`; general recall omits the scope filter and searches across all
scopes, not just unscoped facts. Project mode uses its exact scope for both.
Do not create a replacement connection, start a database, modify global client
profiles, or grant tool permissions. Deployment setup remains a separate concern.

Embed the canonical skill, activation policy, and recipes in the binary. Install
the complete bundle in the selected client's project skill directory and place
the activation policy, selected server name, and mode/scope in one marked instruction
block. Preserve text outside that block and do not rewrite MCP configuration.
Keep one chosen mode and optional scope across installed clients. General mode
does not change the installation location, relabel existing facts, or create a
store. Choosing the same mode/scope does not prove that clients reach the same
database or authorization boundary. Corrective links retain the backend's
existing same-scope rule, including links between two unscoped facts.

Record format version, explicit general-mode flag, optional scope, selected connection fingerprints, and managed
content hashes in `.mindleak/agent-setup.json`. Never store raw credentials in
that state or in instructions. Require unchanged owned content or exact current
bundle contents before updating it. Read older scoped state as scoped; a missing
scope must never implicitly enable general mode. Refuse implicit mode/scope/store changes,
conflicting customizations, malformed markers, and symlinked destinations.
Retain the inputs used to prepare a plan and recheck them before installation
and after connection verification, including unchanged resources.

Provide a side-effect-free `--dry-run`. Serialize cooperating installers using
a project lock directory. Replace each file atomically and write state last;
do not describe the complete operation as a filesystem transaction. Report an
interrupted or conflicting installation as incomplete rather than overwriting
concurrent edits or claiming readiness. A crash can require explicit lock and
partial-installation review before retrying.

Default checks inspect project files only. An explicit `--connect` contacts the
selected HTTP endpoint or launches the configured stdio command using the
official MCP SDK. Check application identity and required tool-schema fields
without calling memory tools. Bound handshake/discovery and connection closure.
Close and reap the direct stdio child. A user-selected command can perform its
own startup work; this is not a sandbox or a guarantee about arbitrary descendants.

Require HTTPS away from loopback and refuse redirects or credentials embedded
in URLs. Support configured headers and explicit environment-backed HTTP tokens;
never guess a token or read client secret stores. Unsupported client variables,
environment files, or OAuth sessions require checking through the actual client.
Do not log credentials, provider bodies, or memory text.

Keep file installation, server configuration, SDK connection compatibility,
client permissions, and observed agent behaviour as separate report fields.
The installer cannot establish native client discovery or automatic memory use;
those remain unmeasured until independently exercised. Existing MCP initialization
instructions also carry a compact, permission-neutral activation reminder, not
a new tool or an enforcement mechanism.

## Consequences

One command replaces manual skill and instruction copying for supported project
configurations, with repeatable updates and explicit conflict handling. The
installer adds JSONC/TOML parsing and SDK client support to the binary, and build
contexts must contain the embedded skill resources. Published older binaries do
not gain these commands from updated documentation.

Custom or global configuration, arbitrary client variable resolution, silent
store changes, and automatic acceptance of modified managed files remain outside
this first version. Connecting successfully does not prove storage health,
permissions in the real client, semantic memory quality, or agent compliance.
No application table, MCP tool, lifecycle policy, or authentication boundary is
added or changed by installation.

## Verification

CLI and filesystem tests cover dry runs, exclusive mode selection, repeat installation, cross-client mode/scope
reuse, preservation of existing text and configuration, CRLF handling, symlinks,
managed-content conflicts, legacy scoped state, and changes after planning. Real SDK fixtures reject
other products, missing/extra tools, and older schemas. The PostgreSQL/MCP suite
checks the actual installer executable over stdio and authenticated HTTP, with
unresolved/wrong tokens, private-value canaries, and no memory/provider calls by
the probe. A normal production build and container build verify that embedded
resources and process features do not depend on test-only configuration. Actual
client activation and model behaviour require separate acceptance evidence.
General-mode recipes are exercised through fresh clients: unscoped storage,
cross-scope recall, project-filtered exclusion, unscoped correction, and atomic
rejection of a general write linked to a scoped target.
