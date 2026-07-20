// Host store client. Deliberately separate from ipc.ts, whose import surface
// the Phase 0 benchmark depends on — keeping product commands out of that file
// means bench.ts can never be broken by host-manager churn.

import { invoke } from "@tauri-apps/api/core";

export type AuthKind = "agent" | "key_file" | "password";

export interface HostOverrides {
  term?: string | null;
  keepaliveSecs?: number | null;
  keepaliveMax?: number | null;
  connectTimeoutSecs?: number | null;
  windowSize?: number | null;
  reconnectEnabled?: boolean | null;
  reconnectMaxAttempts?: number | null;
}

export interface Host {
  id: number;
  folderId: number | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthKind;
  /** Whether a credential is stored. The secret itself never crosses the IPC
   *  boundary, and neither does the keyring account name it lives under. */
  hasSecret: boolean;
  keyPath: string | null;
  overrides: HostOverrides;
  proxyJump: string | null;
  source: string;
  color: string | null;
  notes: string | null;
  lastConnectedAt: number | null;
  connectCount: number;
  tags: number[];
}

export interface NewHost {
  folderId?: number | null;
  name: string;
  hostname: string;
  port?: number;
  username?: string;
  auth: AuthKind;
  keyPath?: string | null;
  overrides?: HostOverrides;
  proxyJump?: string | null;
  color?: string | null;
  notes?: string | null;
  tags?: number[];
}

export interface HostFilter {
  query?: string | null;
  folderId?: number | null;
  tagIds?: number[];
  limit?: number | null;
}

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

export interface KnownHostEntry {
  line: number;
  patterns: string;
  algorithm: string;
  fingerprint: string;
  marker: string | null;
  hashed: boolean;
}

export interface KnownHostsImportReport {
  total: number;
  imported: number;
  duplicates: number;
  skippedCertAuthority: number;
  malformed: number;
}

/**
 * What to do with a host's stored credential on update.
 *
 * The tri-state exists because "left the password field alone" and "cleared
 * the password field" are different intents — collapsing them would either
 * wipe credentials on unrelated edits or make clearing one impossible.
 */
export type SecretUpdate =
  | { action: "unchanged" }
  | { action: "set"; secret: string }
  | { action: "clear" };

// ── hosts ────────────────────────────────────────────────────────────────

export const listHosts = (filter: HostFilter = {}): Promise<Host[]> =>
  invoke("list_hosts", { filter });

export const getHost = (id: number): Promise<Host | null> =>
  invoke("get_host", { id });

export const createHost = (
  host: NewHost,
  secret?: string,
): Promise<number> => invoke("create_host", { host, secret: secret ?? null });

export const updateHost = (
  host: Host,
  secret: SecretUpdate = { action: "unchanged" },
): Promise<void> => invoke("update_host", { host, secret });

export const deleteHost = (id: number): Promise<void> =>
  invoke("delete_host", { id });

export const moveHost = (id: number, folderId: number | null): Promise<void> =>
  invoke("move_host", { id, folderId });

export const setHostTags = (id: number, tagIds: number[]): Promise<void> =>
  invoke("set_host_tags", { id, tagIds });

// ── folders ──────────────────────────────────────────────────────────────

export const listFolders = (): Promise<Folder[]> => invoke("list_folders");

export const createFolder = (
  parentId: number | null,
  name: string,
): Promise<number> => invoke("create_folder", { parentId, name });

export const renameFolder = (id: number, name: string): Promise<void> =>
  invoke("rename_folder", { id, name });

export const moveFolder = (
  id: number,
  parentId: number | null,
): Promise<void> => invoke("move_folder", { id, parentId });

export const deleteFolder = (id: number): Promise<void> =>
  invoke("delete_folder", { id });

// ── tags ─────────────────────────────────────────────────────────────────

export const listTags = (): Promise<Tag[]> => invoke("list_tags");

export const createTag = (name: string, color?: string): Promise<number> =>
  invoke("create_tag", { name, color: color ?? null });

export const deleteTag = (id: number): Promise<void> =>
  invoke("delete_tag", { id });

// ── known hosts ──────────────────────────────────────────────────────────

export const listKnownHosts = (): Promise<KnownHostEntry[]> =>
  invoke("list_known_hosts");

/** Forget a host key — the deliberate second step out of a changed-key state. */
export const removeKnownHost = (host: string, port: number): Promise<number> =>
  invoke("remove_known_host", { host, port });

/** Import from another known_hosts file (defaults to ~/.ssh/known_hosts).
 *  The source is opened read-only and never modified. */
export const importKnownHosts = (
  source?: string,
): Promise<KnownHostsImportReport> =>
  invoke("import_known_hosts", { source: source ?? null });
