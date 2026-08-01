FROM node:24-bookworm

# System dependencies.
# - pkg-config + libssl-dev: openssl-sys (pulled by the Rust workspace) links
#   against system OpenSSL — this is what GitHub's ubuntu-latest runners
#   provide implicitly and what a bare bookworm image lacks.
# - cmake: aws-lc-sys builds via the `cmake` crate.
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  pkg-config \
  libssl-dev \
  cmake \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (run as root, before the USER switch — corepack
# writes shims into a root-owned prefix). Pin matches buzz's package.json
# `packageManager` field (pnpm@11.4.0) and the hermit pin in bin/.
RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

# just — buzz's task runner (Justfile is the de-facto gate driver). Pinned to
# the repo's hermit pin (bin/.just-1.46.0.pkg).
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
  | bash -s -- --tag 1.46.0 --to /usr/local/bin

# cargo-nextest — `just test-unit` prefers nextest when present. Pinned to the
# same version buzz's ci.yml installs (0.9.136).
RUN curl -LsSf https://get.nexte.st/0.9.136/linux | tar zxf - -C /usr/local/bin

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Rust toolchain — installed as the agent user (rustup is per-user). The
# toolchain matches buzz's rust-toolchain.toml (channel 1.95.0, profile
# default → includes rustfmt + clippy), so cargo inside the sandbox uses the
# baked toolchain instead of re-downloading ~700MB per run.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain 1.95.0 --profile default

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude and cargo to PATH
ENV PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
