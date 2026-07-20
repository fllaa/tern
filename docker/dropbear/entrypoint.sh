#!/bin/sh
set -e

# Throwaway password for the auth-matrix tests (loopback-only rig fixture).
echo "tern:tern123" | chpasswd

if [ -f /rig/authorized_keys ]; then
  cp /rig/authorized_keys /home/tern/.ssh/authorized_keys
  chown tern:tern /home/tern/.ssh/authorized_keys
  chmod 600 /home/tern/.ssh/authorized_keys
fi

# -F foreground, -E log to stderr, -R generate host keys on first start.
exec dropbear -F -E -R
