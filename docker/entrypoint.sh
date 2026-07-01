#!/bin/sh
# Starts the local PC/SC daemon age-plugin-yubikey talks to, then execs the
# main process. No physical YubiKey is ever attached to this container (see
# README.md) — pcscd just needs to be *running* for the plugin's recipient
# (encrypt-only) operations to work, e.g. when a newly linked bank's access
# token is written back into the vault while running on a session grant.
set -e

mkdir -p /run/pcscd
# /run isn't tmpfs in this image, so a stale socket from a previous crash/
# restart of this same container would otherwise make pcscd refuse to start.
rm -f /run/pcscd/pcscd.comm /run/pcscd/pcscd.pub
pcscd --foreground &

for i in $(seq 1 40); do
  [ -S /run/pcscd/pcscd.comm ] && break
  sleep 0.25
done

exec "$@"
