FROM rust:1.98-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY tests ./tests
RUN cargo build --locked --release -p mindleak-mcp --bin mindleak-light -j 1

FROM debian:bookworm-slim AS app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home mindleak
COPY --from=build /app/target/release/mindleak-light /usr/local/bin/mindleak-light
COPY LICENSE /usr/share/doc/mindleak-light/LICENSE
USER 10001:10001
WORKDIR /home/mindleak
EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/mindleak-light"]
CMD ["--transport", "http", "--listen", "0.0.0.0:8088"]

FROM pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b AS all-in-one
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home mindleak \
    && mkdir -p /opt/mindleak
COPY --from=build /app/target/release/mindleak-light /usr/local/bin/mindleak-light
COPY LICENSE /usr/share/doc/mindleak-light/LICENSE
COPY docker/all-in-one/entrypoint.sh /usr/local/bin/mindleak-entrypoint
COPY docker/all-in-one/supervisord.conf /etc/supervisor/mindleak.conf
RUN chmod 755 /usr/local/bin/mindleak-entrypoint
ENV POSTGRES_USER=mindleak_light \
    POSTGRES_DB=mindleak_light \
    MINDLEAK_DECOMPOSITION=sentences \
    MINDLEAK_RETRIEVAL=keyword
WORKDIR /opt/mindleak
EXPOSE 8088
VOLUME ["/var/lib/postgresql/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=4s --start-period=60s --retries=3 \
    CMD curl --fail --silent --max-time 3 -H "Authorization: Bearer $MINDLEAK_HTTP_TOKEN" http://127.0.0.1:8088/health || exit 1
ENTRYPOINT ["/usr/local/bin/mindleak-entrypoint"]
CMD []
