# syntax=docker/dockerfile:1

# ---- age-plugin-yubikey, built from source (crates.io, pinned) rather than
# fetched as a prebuilt release binary, so the build itself is the trust
# anchor instead of an unverified downloaded blob. ----
FROM rust:slim-bookworm AS yubikey-plugin-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpcsclite-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install age-plugin-yubikey --version 0.5.1 --locked --root /out

# ---- Node app build ----
FROM node:22-bookworm-slim AS app-build
WORKDIR /app
# better-sqlite3 falls back to compiling from source if no prebuilt binary
# matches this platform/arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# `age` decrypts/encrypts; `pcscd`/`libpcsclite1` are what age-plugin-yubikey
# needs to even start up (see docker/entrypoint.sh) — no physical YubiKey is
# ever attached to this container; decrypting the vault directly here would
# fail by design (see README.md "Docker deployment").
RUN apt-get update && apt-get install -y --no-install-recommends \
      age pcscd libpcsclite1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=yubikey-plugin-build /out/bin/age-plugin-yubikey /usr/local/bin/age-plugin-yubikey
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/dist ./dist
COPY --from=app-build /app/package.json ./package.json
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV FINANCES_DATA_DIR=/app/data

EXPOSE 4000
VOLUME ["/app/data"]

# Runs as root: pcscd needs it to manage /run/pcscd and (on a native Linux
# Docker host, if ever wired up) USB device nodes. Acceptable here since this
# container is single-purpose, not internet-facing, and never gets a real
# physical device passed through.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
