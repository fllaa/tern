#!/usr/bin/env bash
# Local SSH test rig: OpenSSH on 127.0.0.1:2222, dropbear on 127.0.0.1:2223.
# User: tern. Auth: throwaway keypair at .rig/ssh/id_ed25519 or password "tern123".
# Spikes/tests read TERN_SSH_HOST / TERN_SSH_PORT / TERN_SSH_KEY (defaults match).
set -euo pipefail
cd "$(dirname "$0")/.."

RIG_DIR=.rig/ssh

case "${1:-}" in
  up)
    mkdir -p "$RIG_DIR"
    if [ ! -f "$RIG_DIR/id_ed25519" ]; then
      ssh-keygen -t ed25519 -N "" -C "tern-rig-throwaway" -f "$RIG_DIR/id_ed25519" >/dev/null
      cp "$RIG_DIR/id_ed25519.pub" "$RIG_DIR/authorized_keys"
    fi
    docker compose -f docker/compose.yml up -d --build
    for port in 2222 2223 2224; do
      ok=""
      for _ in $(seq 1 30); do
        if nc -z 127.0.0.1 "$port" 2>/dev/null; then ok=1; break; fi
        sleep 1
      done
      [ -n "$ok" ] || { echo "error: port $port did not come up" >&2; exit 1; }
    done
    echo "rig up: openssh :2222, dropbear :2223, openssh-nopassword :2224"
    echo "        (user tern, key $RIG_DIR/id_ed25519, password tern123)"
    ;;
  down)
    docker compose -f docker/compose.yml down -v
    ;;
  status)
    docker compose -f docker/compose.yml ps
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 2
    ;;
esac
