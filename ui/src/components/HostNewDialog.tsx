// Add-host form.
//
// The secret field is the part that matters: whatever is typed here goes
// straight to the OS keychain via `create_host` and is never stored in the
// database, never returned by `list_hosts`, and never round-trips through the
// webview again — subsequent reads only see a `hasSecret` boolean.
//
// Auth is a chain: a first method plus one optional fallback. The chain holds
// at most one credential-bearing method (see lib/auth-chain), so the single
// secret field is always unambiguous.

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldControl, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import {
  credentialedKind,
  fallbackOptions,
  methodLabel,
  toChain,
} from "../lib/auth-chain";
import {
  type AuthKind,
  createHost,
  inspectKey,
  type KeyInfo,
  verifyKeyPassphrase,
} from "../lib/hosts-ipc";

const FIRST_METHODS: AuthKind[] = ["agent", "key_file", "password"];

export function HostNewDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [first, setFirst] = useState<AuthKind>("agent");
  const [then, setThen] = useState<AuthKind | "none">("none");
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Key inspection, driven by the key path whenever the chain uses a key.
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [keyError, setKeyError] = useState("");
  const [inspecting, setInspecting] = useState(false);

  const chain = useMemo(() => toChain(first, then), [first, then]);
  const usesKey = chain.includes("key_file");
  const credentialed = credentialedKind(chain);

  const chooseFirst = (k: AuthKind) => {
    setFirst(k);
    // Drop a fallback the new primary no longer permits (the one-credential
    // rule), so the form can never hold an unrepresentable chain.
    setThen((prev) =>
      prev !== "none" && fallbackOptions(k).includes(prev) ? prev : "none",
    );
  };

  useEffect(() => {
    const path = keyPath.trim();
    if (!usesKey || !path) {
      setKeyInfo(null);
      setKeyError("");
      setInspecting(false);
      return;
    }
    // Debounced: the path is typed, and inspecting every keystroke would both
    // thrash the filesystem and flash errors for half-typed paths.
    setInspecting(true);
    const timer = setTimeout(() => {
      inspectKey(path)
        .then((info) => {
          setKeyInfo(info);
          setKeyError("");
        })
        .catch((e) => {
          setKeyInfo(null);
          setKeyError(String(e));
        })
        .finally(() => setInspecting(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [usesKey, keyPath]);

  // A passphrase is only meaningful for an encrypted key; a password is always.
  const wantsPassphrase = credentialed === "key_file" && keyInfo?.encrypted === true;
  const wantsPassword = credentialed === "password";
  const secretLabel = wantsPassword ? "Password" : "Key passphrase";

  // Save is blocked while the key is still being resolved, or if it did not
  // resolve — storing a passphrase against a path that is not a key would fail
  // much later, at connect time.
  const keyBlocks = usesKey && (!keyPath.trim() || inspecting || !!keyError || !keyInfo);
  const canSave = !busy && !!hostname.trim() && !keyBlocks;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (usesKey) {
        // Pre-flight: confirm the key parses and, if encrypted, that the
        // passphrase is right — before it reaches the keyring. A wrong
        // passphrase caught here is a form error; caught at connect time it is
        // a mysterious auth failure.
        await verifyKeyPassphrase(keyPath.trim(), secret || null);
      }

      const store = wantsPassword || wantsPassphrase ? secret : "";
      await createHost(
        {
          name: name.trim() || hostname.trim(),
          hostname: hostname.trim(),
          port: Number(port) || 22,
          username: username.trim(),
          auth: first,
          authFallbacks: then === "none" ? [] : [then],
          keyPath: usesKey ? keyPath.trim() || null : null,
        },
        store || undefined,
      );
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add host</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <FieldControl
              render={
                <Input
                  placeholder="Defaults to the hostname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              }
            />
          </Field>

          <div className="flex gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Hostname</FieldLabel>
              <FieldControl
                render={
                  <Input
                    placeholder="host.example.com"
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value)}
                  />
                }
              />
            </Field>
            <Field className="w-24">
              <FieldLabel>Port</FieldLabel>
              <FieldControl
                render={<Input value={port} onChange={(e) => setPort(e.target.value)} />}
              />
            </Field>
          </div>

          <Field>
            <FieldLabel>User</FieldLabel>
            <FieldControl
              render={
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              }
            />
          </Field>

          <Field>
            <FieldLabel>Authentication</FieldLabel>
            <div className="flex gap-1">
              {FIRST_METHODS.map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={first === k ? "primary" : "secondary"}
                  onClick={() => chooseFirst(k)}
                >
                  {methodLabel(k)}
                </Button>
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel>If it fails, then try</FieldLabel>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={then === "none" ? "primary" : "secondary"}
                onClick={() => setThen("none")}
              >
                Nothing
              </Button>
              {fallbackOptions(first).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={then === k ? "primary" : "secondary"}
                  onClick={() => setThen(k)}
                >
                  {methodLabel(k)}
                </Button>
              ))}
            </div>
          </Field>

          {usesKey && (
            <Field>
              <FieldLabel>Private key path</FieldLabel>
              <FieldControl
                render={
                  <Input
                    placeholder="~/.ssh/id_ed25519"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                  />
                }
              />
              {inspecting && (
                <p className="flex items-center gap-1.5 text-xs text-[var(--lilt-text-subtle)]">
                  <Spinner size={12} /> Inspecting…
                </p>
              )}
              {keyError && (
                <p className="text-xs text-[var(--lilt-danger-text)]">{keyError}</p>
              )}
              {keyInfo && !inspecting && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--lilt-text-subtle)]">
                  <Badge variant="default">{keyInfo.format}</Badge>
                  {keyInfo.algorithm && <span>{keyInfo.algorithm}</span>}
                  {keyInfo.encrypted && <Badge variant="warning">encrypted</Badge>}
                  {keyInfo.fingerprint && (
                    <span className="font-mono">{keyInfo.fingerprint}</span>
                  )}
                </div>
              )}
            </Field>
          )}

          {(wantsPassword || wantsPassphrase) && (
            <Field>
              <FieldLabel>{secretLabel}</FieldLabel>
              <FieldControl
                render={
                  <Input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                }
              />
              <p className="text-xs text-[var(--lilt-text-subtle)]">
                Stored in the OS keychain, never in Tern's database.
              </p>
            </Field>
          )}

          {error && <p className="text-xs text-[var(--lilt-danger-text)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
