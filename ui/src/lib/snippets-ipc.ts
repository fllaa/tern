// Snippets: the store-backed command library.
//
// Bodies are plaintext by design (see migration 0003) — a snippet is a command
// you would have typed, not a credential. Secrets belong in the keyring behind
// a host record.

import { invoke } from "@tauri-apps/api/core";

export interface Snippet {
  id: number;
  name: string;
  body: string;
  description: string | null;
}

export interface NewSnippet {
  name: string;
  body: string;
  description: string | null;
}

export const listSnippets = (): Promise<Snippet[]> => invoke("list_snippets");

export const createSnippet = (snippet: NewSnippet): Promise<number> =>
  invoke("create_snippet", { snippet });

export const updateSnippet = (snippet: Snippet): Promise<void> =>
  invoke("update_snippet", { snippet });

export const deleteSnippet = (id: number): Promise<void> =>
  invoke("delete_snippet", { id });
