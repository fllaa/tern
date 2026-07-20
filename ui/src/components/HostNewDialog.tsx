// Add-host form.
//
// The secret field is the part that matters: whatever is typed here goes
// straight to the OS keychain via `create_host` and is never stored in the
// database, never returned by `list_hosts`, and never round-trips through the
// webview again — subsequent reads only see a `hasSecret` boolean.

import { useState } from "react";

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

import { type AuthKind, createHost } from "../lib/hosts-ipc";

const AUTH_LABELS: Array<{ value: AuthKind; label: string }> = [
  { value: "agent", label: "ssh-agent" },
  { value: "key_file", label: "Private key" },
  { value: "password", label: "Password" },
];

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
  const [auth, setAuth] = useState<AuthKind>("agent");
  const [keyPath, setKeyPath] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await createHost(
        {
          name: name.trim() || hostname.trim(),
          hostname: hostname.trim(),
          port: Number(port) || 22,
          username: username.trim(),
          auth,
          keyPath: auth === "key_file" ? keyPath.trim() || null : null,
        },
        secret || undefined,
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
              {AUTH_LABELS.map((a) => (
                <Button
                  key={a.value}
                  size="sm"
                  variant={auth === a.value ? "primary" : "secondary"}
                  onClick={() => setAuth(a.value)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </Field>

          {auth === "key_file" && (
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
            </Field>
          )}

          {auth !== "agent" && (
            <Field>
              <FieldLabel>
                {auth === "password" ? "Password" : "Key passphrase"}
              </FieldLabel>
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

          {error && <p className="text-xs text-[var(--lilt-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !hostname.trim()} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
