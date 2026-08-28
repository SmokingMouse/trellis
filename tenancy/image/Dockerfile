# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

ARG BUN_VERSION=1.3.14
RUN npm install --global "bun@${BUN_VERSION}"

# next.config.ts uses os.homedir() as turbopack.root. HOME must therefore be
# an ancestor of the project copied below.
ENV HOME=/opt
WORKDIR /opt/trellis
COPY . .
RUN bun install --frozen-lockfile
RUN bun --bun run build

FROM node:22-bookworm-slim AS runtime

ARG BUN_VERSION=1.3.14
ARG TTYD_VERSION=1.7.7

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git procps tmux; \
    curl -fsSL \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.aarch64" \
      -o /usr/local/bin/ttyd; \
    chmod 0755 /usr/local/bin/ttyd; \
    rm -rf /var/lib/apt/lists/*

RUN npm install --global \
      "bun@${BUN_VERSION}" \
      @anthropic-ai/claude-code \
      @openai/codex \
    && npm cache clean --force

# The official node image already owns UID/GID 1000. Rename that account so
# the runtime identity is tenant:tenant without creating a duplicate UID.
RUN usermod --login tenant --home /home/tenant --move-home node \
    && groupmod --new-name tenant node

COPY --from=build --chown=tenant:tenant /opt/trellis /opt/trellis
COPY --chmod=0755 tenancy/image/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/home/tenant \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

USER tenant
WORKDIR /opt/trellis
EXPOSE 3088

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -sf http://127.0.0.1:3088/__gate/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
