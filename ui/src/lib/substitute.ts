// Snippet variable substitution.
//
// A snippet body may carry `{{name}}` placeholders, optionally with a default:
// `{{port:22}}`. The run flow prompts for every distinct placeholder, prefilled
// from the pane's host where the name matches a known context value.
//
// Pure and dependency-free so the whole substitution contract is unit-testable
// without React or a live session.

/** A placeholder found in a snippet body. */
export interface Variable {
  name: string;
  /** The `{{name:default}}` default, or "" when none was written. */
  fallback: string;
}

// Built fresh per call: a shared /g/ regex carries `lastIndex` between callers,
// which is exactly the kind of bug that only shows up on the second run.
const PATTERN = String.raw`\{\{\s*([A-Za-z0-9_.-]+)\s*(?::([^}]*))?\}\}`;
const re = () => new RegExp(PATTERN, "g");

/** Every distinct placeholder, in first-appearance order. */
export function variablesIn(body: string): Variable[] {
  const seen = new Map<string, Variable>();
  for (const m of body.matchAll(re())) {
    const name = m[1];
    if (!seen.has(name)) seen.set(name, { name, fallback: m[2] ?? "" });
  }
  return [...seen.values()];
}

/**
 * Expand every placeholder.
 *
 * A supplied value wins even when empty — the user clearing a field is a
 * deliberate "substitute nothing". Only an *absent* key falls back to the
 * placeholder's own default.
 */
export function substitute(body: string, values: Record<string, string>): string {
  return body.replace(re(), (_all, name: string, fallback?: string) => {
    return values[name] ?? fallback ?? "";
  });
}

/**
 * Context values taken from the pane a snippet will run in, so `{{host}}`,
 * `{{user}}` and `{{port}}` need no typing.
 */
export function hostContext(
  host: { hostname: string; username: string; port: number } | null,
): Record<string, string> {
  if (!host) return {};
  return { host: host.hostname, user: host.username, port: String(host.port) };
}
