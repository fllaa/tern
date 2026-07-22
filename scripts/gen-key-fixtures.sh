#!/usr/bin/env bash
# Private-key fixtures for the auth-matrix tests, written to .rig/keys/.
#
# These are throwaway keys for exercising parse/decrypt paths — they authorise
# nothing. .rig/ is gitignored precisely so no private key ever lands in the
# repo; regenerate locally rather than committing what this produces.
#
# ssh-keygen covers OpenSSH, PEM and PKCS#8. PuTTY's .ppk needs puttygen, which
# is not installed everywhere — when it is missing the .ppk fixtures are skipped
# and the tests that need them skip too, the same way the sshd-rig tests do.
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS_DIR=.rig/keys
PASS="tern-fixture-pass"

mkdir -p "$KEYS_DIR"

# ssh-keygen refuses to overwrite and prompts, which would hang CI.
gen() {
  local name=$1 type=$2 passphrase=$3
  shift 3
  rm -f "$KEYS_DIR/$name" "$KEYS_DIR/$name.pub"
  ssh-keygen -q -t "$type" -N "$passphrase" -C "tern-fixture-$name" \
    -f "$KEYS_DIR/$name" "$@"
}

# OpenSSH format (the modern default), clear and encrypted, one per algorithm.
gen id_ed25519      ed25519 ""
gen id_ed25519_enc  ed25519 "$PASS"
gen id_ecdsa        ecdsa   ""       -b 256
gen id_ecdsa_enc    ecdsa   "$PASS"  -b 256
gen id_rsa          rsa     ""       -b 2048
gen id_rsa_enc      rsa     "$PASS"  -b 2048

# Legacy PEM (PKCS#1, "BEGIN RSA PRIVATE KEY"); encrypted PEM carries DEK-Info.
gen id_rsa_pem      rsa     ""       -b 2048 -m PEM
gen id_rsa_pem_enc  rsa     "$PASS"  -b 2048 -m PEM

# PKCS#8 ("BEGIN PRIVATE KEY" / "BEGIN ENCRYPTED PRIVATE KEY").
gen id_rsa_pkcs8 rsa "" -b 2048 -m PKCS8

# Both encrypted PKCS#8 fixtures are written with openssl and an *explicit* PBES2
# PRF — never `ssh-keygen -m PKCS8 -N …`, whose PRF default is platform-dependent:
# HMAC-SHA1 on LibreSSL / older OpenSSL, HMAC-SHA256 on OpenSSL 3. Relying on that
# default made id_rsa_pkcs8_enc actually SHA-256 on Ubuntu CI, so ssh-key
# decrypted it and the "unsupported format" test failed there while passing on
# macOS.
#
# HMAC-SHA1: ssh-key reaches PBKDF2-SHA1 only through `pkcs5/sha1-insecure`, which
# it does not enable, so this fixture is permanently undecryptable here — the
# tests pin it as a known capability limit. (openssl omits the PRF OID for SHA-1
# since it is the RFC 8018 default; the result is a genuine SHA-1 key on every
# platform.)
openssl pkcs8 -topk8 -in "$KEYS_DIR/id_rsa_pkcs8" \
  -out "$KEYS_DIR/id_rsa_pkcs8_enc" \
  -passout "pass:$PASS" -v2 aes-256-cbc -v2prf hmacWithSHA1
cp "$KEYS_DIR/id_rsa_pkcs8.pub" "$KEYS_DIR/id_rsa_pkcs8_enc.pub"

# HMAC-SHA256: the encrypted-PKCS#8 shape ssh-key does decrypt.
openssl pkcs8 -topk8 -in "$KEYS_DIR/id_rsa_pkcs8" \
  -out "$KEYS_DIR/id_rsa_pkcs8_sha256_enc" \
  -passout "pass:$PASS" -v2 aes-256-cbc -v2prf hmacWithSHA256
cp "$KEYS_DIR/id_rsa_pkcs8.pub" "$KEYS_DIR/id_rsa_pkcs8_sha256_enc.pub"

if command -v puttygen >/dev/null 2>&1; then
  # puttygen converts an existing OpenSSH key rather than generating its own,
  # so the .ppk fixtures hold the same key material as id_ed25519 — which also
  # means a PPK-parsed key can be compared against its OpenSSH twin.
  for v in 2 3; do
    rm -f "$KEYS_DIR/id_ed25519_v$v.ppk" "$KEYS_DIR/id_ed25519_v${v}_enc.ppk"
    puttygen "$KEYS_DIR/id_ed25519" -O private -o "$KEYS_DIR/id_ed25519_v$v.ppk" \
      --ppk-param version=$v
    puttygen "$KEYS_DIR/id_ed25519" -O private -o "$KEYS_DIR/id_ed25519_v${v}_enc.ppk" \
      --ppk-param version=$v --new-passphrase <(printf '%s' "$PASS")
  done
  echo "wrote OpenSSH/PEM/PKCS#8 and .ppk v2+v3 fixtures to $KEYS_DIR"
else
  echo "wrote OpenSSH/PEM/PKCS#8 fixtures to $KEYS_DIR"
  echo "note: puttygen not found — .ppk fixtures skipped, PPK tests will skip" >&2
fi
