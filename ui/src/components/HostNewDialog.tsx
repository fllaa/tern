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

import { open as pickFile } from "@tauri-apps/plugin-dialog";
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
import { Switch } from "@/components/ui/switch";

import {
  credentialedKind,
  fallbackOptions,
  methodLabel,
  toChain,
} from "../lib/auth-chain";
import {
  type AuthKind,
  createHost,
  type Host,
  inspectKey,
  type KeyInfo,
  type SecretUpdate,
  type TestConnectionReq,
  type TestConnectionResult,
  updateHost,
  verifyKeyPassphrase,
} from "../lib/hosts-ipc";
import type { AuthMethodDto } from "../lib/ipc";

const FIRST_METHODS: AuthKind[] = ["agent", "key_file", "password"];

export function HostNewDialog({
  onClose,
  onSaved,
  onTest,
  editing,
}: {
  onClose: () => void;
  onSaved: () => void;
  /** Try the current form values without saving; resolves to the outcome. */
  onTest: (req: TestConnectionReq) => Promise<TestConnectionResult>;
  /** When set, the form edits this host in place instead of creating one. */
  editing?: Host;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [hostname, setHostname] = useState(editing?.hostname ?? "");
  const [port, setPort] = useState(editing ? String(editing.port) : "22");
  const [username, setUsername] = useState(editing?.username ?? "");
  const [proxyJump, setProxyJump] = useState(editing?.proxyJump ?? "");
  const [first, setFirst] = useState<AuthKind>(editing?.auth ?? "agent");
  const [then, setThen] = useState<AuthKind | "none">(
    editing?.authFallbacks[0] ?? "none",
  );
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? "");
  const [secret, setSecret] = useState("");
  // Off only when the host explicitly opted out; a null/absent override inherits
  // the global default, which the switch shows as on.
  const [reconnect, setReconnect] = useState(
    editing ? editing.overrides.reconnectEnabled !== false : true,
  );
  // The mirror image of `reconnect`: on only when the host explicitly opted in.
  // A new host starts off, and an absent override reads as off rather than as
  // "inherit" — there is no global agent-forwarding default to inherit.
  const [forwardAgent, setForwardAgent] = useState(
    editing?.overrides.forwardAgent === true,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

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

  // Native file picker for the key path. No extension filter — OpenSSH keys
  // (id_ed25519, id_rsa) carry none, so filtering by suffix would hide them.
  const browseKey = async () => {
    try {
      const picked = await pickFile({ multiple: false, directory: false });
      if (typeof picked === "string") setKeyPath(picked);
    } catch {
      // Cancelling the dialog, or a picker error, is a no-op — the path field
      // is still there to type into.
    }
  };

  // The chain as wire DTOs, the secret attached to its one credentialed method.
  const authDtos = (): AuthMethodDto[] =>
    chain.map((kind): AuthMethodDto => {
      if (kind === "password") return { method: "password", password: secret };
      if (kind === "key_file")
        return { method: "key_file", path: keyPath.trim(), passphrase: secret || null };
      return { method: "agent" };
    });

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await onTest({
      host: hostname.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      auth: authDtos(),
      host_id: editing?.id ?? null,
    });
    setTestResult(result);
    setTesting(false);
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

  // Tri-state credential intent, only meaningful on edit: keep what is stored
  // unless the field was filled (set) or the method no longer stores anything,
  // e.g. a switch to agent (clear). Create passes the plain secret instead.
  const secretUpdate = (): SecretUpdate => {
    if (!(wantsPassword || wantsPassphrase)) {
      return editing?.hasSecret ? { action: "clear" } : { action: "unchanged" };
    }
    return secret ? { action: "set", secret } : { action: "unchanged" };
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (usesKey) {
        // Pre-flight: confirm the key parses and, if encrypted, that the
        // passphrase is right — before it reaches the keyring. A wrong
        // passphrase caught here is a form error; caught at connect time it is
        // a mysterious auth failure. On edit with an untouched passphrase there
        // is nothing to check: the stored one is kept and we never held it.
        const keepStoredPassphrase = !!editing && keyInfo?.encrypted === true && !secret;
        if (!keepStoredPassphrase) {
          await verifyKeyPassphrase(keyPath.trim(), secret || null);
        }
      }

      if (editing) {
        await updateHost(
          {
            ...editing,
            name: name.trim() || hostname.trim(),
            hostname: hostname.trim(),
            port: Number(port) || 22,
            username: username.trim(),
            auth: first,
            authFallbacks: then === "none" ? [] : [then],
            proxyJump: proxyJump.trim() || null,
            keyPath: usesKey ? keyPath.trim() || null : null,
            // Preserve any other overrides (term, keepalive, …); only the
            // reconnect opt-out is edited here. null clears it back to inherit.
            overrides: {
              ...editing.overrides,
              reconnectEnabled: reconnect ? null : false,
              // Written either way, unlike reconnect above: turning it off has
              // to store a decision, not fall back to a default that could
              // later change underneath a host the user switched off.
              forwardAgent,
            },
          },
          secretUpdate(),
        );
      } else {
        const store = wantsPassword || wantsPassphrase ? secret : "";
        await createHost(
          {
            name: name.trim() || hostname.trim(),
            hostname: hostname.trim(),
            port: Number(port) || 22,
            username: username.trim(),
            auth: first,
            authFallbacks: then === "none" ? [] : [then],
            proxyJump: proxyJump.trim() || null,
            keyPath: usesKey ? keyPath.trim() || null : null,
            // Only the opt-out is stored; leaving it on inherits the global
            // default, so a later change to that default still reaches this host.
            overrides: {
              ...(reconnect ? {} : { reconnectEnabled: false }),
              ...(forwardAgent ? { forwardAgent: true } : {}),
            },
          },
          store || undefined,
        );
      }
      onSaved();
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
          <DialogTitle>{editing ? "Edit host" : "Add host"}</DialogTitle>
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
            <FieldLabel>ProxyJump</FieldLabel>
            <FieldControl
              render={
                <Input
                  placeholder="bastion, or user@host:port (comma-separated for chains)"
                  value={proxyJump}
                  onChange={(e) => setProxyJump(e.target.value)}
                />
              }
            />
            <p className="text-xs text-[var(--lilt-text-subtle)]">
              Route through one or more jump hosts. A hop matching a saved host reuses its
              credentials; otherwise the SSH agent is used.
            </p>
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
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <FieldControl
                    render={
                      <Input
                        placeholder="~/.ssh/id_ed25519"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                      />
                    }
                  />
                </div>
                <Button variant="secondary" onClick={() => void browseKey()}>
                  Browse…
                </Button>
              </div>
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
                {editing?.hasSecret
                  ? "Leave blank to keep the saved one."
                  : "Stored in the OS keychain, never in Tern's database."}
              </p>
            </Field>
          )}

          <div className="flex items-center justify-between gap-3">
            <span id="reconnect-label" className="text-sm text-[var(--lilt-text)]">
              Reconnect automatically if the connection drops
            </span>
            <Switch
              checked={reconnect}
              onCheckedChange={setReconnect}
              aria-labelledby="reconnect-label"
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <span id="forward-agent-label" className="text-sm text-[var(--lilt-text)]">
                Forward my ssh-agent to this host
              </span>
              <Switch
                checked={forwardAgent}
                onCheckedChange={setForwardAgent}
                aria-labelledby="forward-agent-label"
              />
            </div>
            {/* Shown only when it is on: a warning about a switch you have not
                touched is noise, and noise is what stops warnings being read. */}
            {forwardAgent && (
              <p className="mt-1.5 text-xs text-[var(--lilt-warning-text,var(--lilt-danger-text))]">
                While you are connected, anyone with root on this host can use your agent
                to log in anywhere your keys are trusted. They cannot copy the keys. Turn
                this on for hosts you trust to reach further hosts — never on a shared or
                untrusted machine.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-[var(--lilt-danger-text)]">{error}</p>}
        </div>

        {testResult && !testing && (
          <p
            className={`mt-4 text-xs ${
              testResult.ok
                ? "text-[var(--lilt-primary-text)]"
                : "text-[var(--lilt-danger-text)]"
            }`}
          >
            {testResult.ok ? "Connected ✓" : testResult.message}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            disabled={testing || !hostname.trim() || keyBlocks}
            onClick={() => void test()}
          >
            {testing ? (
              <>
                <Spinner size={14} /> Testing…
              </>
            ) : (
              "Test connection"
            )}
          </Button>
          <div className="ml-auto flex gap-3">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!canSave} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
