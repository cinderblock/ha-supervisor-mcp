# ha-ops-mcp: a Bun MCP server, wrapped as a Home Assistant add-on.
# Built per-arch natively in CI (ubuntu-24.04 + ubuntu-24.04-arm) and
# stitched into a multi-arch manifest at ghcr.io/cinderblock/ha-ops-mcp.

FROM oven/bun:1-alpine

# Tools for the exec tool. The `ha` CLI talks to the Supervisor with the
# add-on's SUPERVISOR_TOKEN.
RUN apk add --no-cache bash coreutils curl diffutils findutils git jq python3 tar xz

ARG HA_CLI_VERSION=5.6.0
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) arch=amd64 ;; \
        arm64) arch=aarch64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/bin/ha "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/ha_${arch}" \
    && chmod +x /usr/bin/ha \
    && ha --help > /dev/null

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.name="HA Ops MCP" \
    io.hass.description="Box-level MCP server for agents" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.source="https://github.com/cinderblock/ha-ops-mcp"

ENTRYPOINT ["bun", "run", "/app/src/main.ts"]
