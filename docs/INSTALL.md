# Install MindLeak Light

Choose the package that fits your agent stack. Neither requires a chat or
embedding model; [models are a recommended optional upgrade](MODELS.md).

| Package | Best For | You Supply |
|---|---|---|
| Native binary | Plugging into a desktop or coding agent over stdio | PostgreSQL with pgvector |
| All-in-one container | One container to run and back up | Docker/Podman, a persistent volume, and an HTTP token |
| Source Compose stack | Developing MindLeak itself | Git and Docker/Podman Compose |

This guide targets **v0.2.0**: model-free keyword recall, optional pgvector or
hybrid recall, configurable similarity thresholds, contextual fact lifecycle,
and bounded provider responses. Models remain optional. Download versioned
archives from [GitHub Releases](https://github.com/monk-eee/MindLeak-Light/releases)
or use `monkeemagic/mindleak-light:0.2.0` for the all-in-one image. The
[publishing workflow](https://github.com/monk-eee/MindLeak-Light/actions/workflows/docker-hub.yml)
records image verification. Older binaries do not gain features from new settings.

## Native Binary

Download your platform's archive and its `.sha256` file from
[GitHub Releases](https://github.com/monk-eee/MindLeak-Light/releases).

| Platform | Archive Target |
|---|---|
| Linux x86-64 | `x86_64-unknown-linux-gnu` (glibc 2.35 or newer) |
| Windows x86-64 | `x86_64-pc-windows-msvc` |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |

1. Verify the archive against its checksum. On Linux, use `sha256sum -c`; on
   macOS, use `shasum -a 256 -c`. On Windows, compare `Get-FileHash -Algorithm SHA256`
   with the downloaded checksum. Checksums detect corruption; they are not signatures.
2. Extract the archive and run `./mindleak-light --version`, or
   `.\mindleak-light.exe --version` in PowerShell. No Rust, Node, or Python runtime
   is needed to run the executable.
3. Have PostgreSQL with pgvector available. Set its connection string in the
   archive's `mcp.example.json`, and replace `command` with the absolute binary
   path unless it is already on your client's PATH.
4. Add that server entry to your MCP client's configuration. VS Code calls the
   top-level key `servers`; Claude Desktop-style clients use `mcpServers`.

The client starts the binary with `--transport stdio`. It initializes the three
tables and waits for MCP requests; silence in a terminal is normal. See
[agent integration](INTEGRATION.md) for calls, permissions, and the memory policy.

Remote PostgreSQL should use `sslmode=require`; a private CA can be supplied via
`MINDLEAK_DATABASE_CA_FILE`. Use `sslmode=disable` only for trusted local setups.
The database role needs schema initialization/migration permissions.

For shared HTTP instead, set `MINDLEAK_DATABASE_URL` and `MINDLEAK_HTTP_TOKEN`,
then run `mindleak-light --transport http --listen 127.0.0.1:8088`.
The binary uses your configured database; it does not bundle PostgreSQL.

## All-in-One Container

This variant bundles the MCP binary and PostgreSQL/pgvector in one container.
The database is reachable only through an internal Unix socket; only MCP's
HTTP port is exposed. A process supervisor manages startup and shutdown.

Pin the version tag so upgrades are deliberate:

```sh
docker run --detach --name mindleak-light --restart unless-stopped -p 127.0.0.1:8088:8088 -e MINDLEAK_HTTP_TOKEN=mindleak-light-development-token-not-for-production -v mindleak-light-data:/var/lib/postgresql/data monkeemagic/mindleak-light:0.2.0
```

That token is a public local-development example. For anything shared, use your
secret manager to inject a strong token and put the HTTP endpoint behind TLS.
Connect your MCP client to `http://127.0.0.1:8088/mcp` with the matching bearer
header. No separate database container or model server is needed.

To build the revision in your checkout locally:

```sh
docker build -f docker/Dockerfile --target all-in-one -t mindleak-light:all-in-one .
```

Use `mindleak-light:all-in-one` in the run command. With Podman, build with
`podman build --format docker` and the same remaining options; its default OCI
build format drops Docker health-check metadata. Podman accepts the run options.
The existing source Compose file explicitly builds the `app` target and still
runs the app and database separately for development.

For a Compose-managed single container, use
[docker/compose.all-in-one.yml](../docker/compose.all-in-one.yml). Set
`MINDLEAK_IMAGE` to your built or published image and `MINDLEAK_HTTP_TOKEN` to
your token, then run:

```sh
docker compose -f docker/compose.all-in-one.yml up --detach --wait
```

This starts one container, not the two-service development stack. The file
defaults to `monkeemagic/mindleak-light:0.2.0`. This release does not promote the
`latest` alias. Override `MINDLEAK_IMAGE` to pin a digest or another version.
Podman may not expose embedded health metadata from published OCI images. The
Compose template defines its own health check so `up --wait` still verifies
MCP and database readiness; use that template for health-managed Podman startup.

### Data and Operations

Keep the named volume. Recreating the container with the same volume preserves
memories. Deleting the volume deletes the database. Do not point the all-in-one
image at an unrelated existing PostgreSQL data directory.

Check health with `docker inspect --format '{{.State.Health.Status}}' mindleak-light`.
Health verifies both MCP and its database; `docker logs mindleak-light` reports
startup problems. A failed configuration can leave the container unhealthy until
you correct it; Docker's restart policy alone does not restart unhealthy containers.
The MCP worker runs as an unprivileged user. The supervisor starts as root to
initialize the volume and launch PostgreSQL under its own account. The image is
not intended for read-only-root-filesystem or arbitrary-UID execution.

Back up using PostgreSQL's tools before an image upgrade:

```sh
docker exec mindleak-light pg_dump -U mindleak_light -d mindleak_light -Fc > mindleak-light.dump
```

Test restores to a separate volume. Stop the old container before attaching its
volume to a replacement; never run two PostgreSQL processes on the same volume.
PostgreSQL major-version upgrades require a database upgrade procedure, not just
changing the image tag. This single-container package is convenient for a laptop
or small deployment, not a high-availability database service.

### Upgrade from 0.1.0

Back up and test the restore first. Stop all old MCP processes, then replace the
binary or container with 0.2.0 using the same database or volume. Startup applies
the lifecycle migration atomically under the existing database advisory lock.
Existing raw text, IDs, fragments, vectors, relationships, and embedding model
metadata are preserved. Existing facts start active, unconfirmed, and short-term;
their context is empty. No re-embedding or model download is required.

Keep the original embedding model and dimensions when enabling vector or hybrid
recall. Do not run 0.1.0 and 0.2.0 MCP processes concurrently against the upgraded
database: older clients cannot apply the new lifecycle visibility rules. Rollback
means stopping 0.2.0, restoring the pre-upgrade backup to a separate database or
volume, and pointing 0.1.0 at that restored copy. An in-place downgrade is not
supported and would expose archived or superseded facts through the old server.

For optional models, pass the [model settings](MODELS.md) as container environment
variables. For a calibrated similarity threshold in the all-in-one
image, set `MINDLEAK_RECALL_MIN_SIMILARITY` in your shell or `.env`. Both Compose
templates forward it, defaulting to `-1` (unfiltered) when unset or empty.
Recreate the all-in-one container with
`docker compose -f docker/compose.all-in-one.yml up --detach --wait` after changing
the setting. With `docker run`, pass it explicitly using `--env`.

A host model server may require
`--add-host host.docker.internal:host-gateway` and local network access. Keep the
database managed internally; use the native binary or app-only image when you
want a separately managed PostgreSQL service.
