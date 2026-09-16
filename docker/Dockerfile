FROM rust:1.88-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY tests ./tests
RUN cargo build --locked --release -p mindleak-mcp --bin mindleak-light -j 1

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home mindleak
COPY --from=build /app/target/release/mindleak-light /usr/local/bin/mindleak-light
USER 10001:10001
WORKDIR /home/mindleak
EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/mindleak-light"]
CMD ["--transport", "http", "--listen", "0.0.0.0:8088"]
