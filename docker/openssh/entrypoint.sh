#!/bin/sh
set -e

# Fresh host keys on every container creation — exercises the client's TOFU path.
ssh-keygen -A

# Throwaway password for the auth-matrix tests (loopback-only rig fixture).
echo "tern:tern123" | chpasswd

# Authorized key is bind-mounted read-only; install with correct perms.
if [ -f /rig/authorized_keys ]; then
  cp /rig/authorized_keys /home/tern/.ssh/authorized_keys
  chown tern:tern /home/tern/.ssh/authorized_keys
  chmod 600 /home/tern/.ssh/authorized_keys
fi

# Benchmark corpus: ~100 MB of base64 lines (75 MB raw * 4/3).
if [ ! -f /bench/100mb.txt ]; then
  dd if=/dev/urandom bs=1M count=75 2>/dev/null | base64 -w 76 >/bench/100mb.txt
fi
chmod 644 /bench/100mb.txt

exec /usr/sbin/sshd -D -e
