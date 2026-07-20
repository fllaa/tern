// Host-key trust dialogs.
//
// Two visually distinct states, deliberately not one component with a flag:
//
//   * first contact — a neutral prompt. This is routine; making it alarming
//     trains people to click through the one that matters.
//   * changed key   — an alarm with no accept button at all. The connection is
//     already refused by the time this renders; recovery is an explicit
//     "forget this key", after which reconnecting is ordinary first contact.
//
// That asymmetry is the entire security value of the pair.

import type { HostKeyPrompt } from "../lib/ipc";

export interface ChangedKey {
  host: string;
  port: number;
  algorithm: string;
  recorded_fingerprint: string;
  presented_fingerprint: string;
  known_hosts_path: string;
  known_hosts_line: number;
}

const overlay = "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4";
const panel =
  "w-full max-w-lg rounded-lg border border-neutral-700 bg-neutral-900 p-5 text-sm text-neutral-100 shadow-xl";
const mono = "font-mono text-xs break-all";

export function FirstContactDialog({
  prompt,
  onDecide,
}: {
  prompt: HostKeyPrompt;
  onDecide: (accept: boolean) => void;
}) {
  return (
    <div className={overlay}>
      <div className={panel}>
        <h2 className="mb-1 text-base font-medium">Unknown host key</h2>
        <p className="mb-3 text-neutral-400">
          First time connecting to{" "}
          <span className="text-neutral-200">
            {prompt.host}:{prompt.port}
          </span>
          . Verify this fingerprint out of band if you can.
        </p>
        <dl className="mb-4 space-y-1 rounded bg-neutral-950 p-3">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-neutral-500">Algorithm</dt>
            <dd className={mono}>{prompt.algorithm}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-neutral-500">Fingerprint</dt>
            <dd className={mono}>{prompt.fingerprint_sha256}</dd>
          </div>
        </dl>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-neutral-300 hover:bg-neutral-800"
            onClick={() => onDecide(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-neutral-200 px-3 py-1.5 font-medium text-neutral-900 hover:bg-white"
            onClick={() => onDecide(true)}
          >
            Trust and connect
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChangedKeyDialog({
  detail,
  onForget,
  onDismiss,
}: {
  detail: ChangedKey;
  onForget: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={overlay}>
      <div className={`${panel} border-red-800`}>
        <h2 className="mb-1 text-base font-medium text-red-300">
          Host key changed — connection refused
        </h2>
        <p className="mb-3 text-neutral-300">
          The key offered by{" "}
          <span className="text-neutral-100">
            {detail.host}:{detail.port}
          </span>{" "}
          does not match the one on record. This happens when a server is rebuilt or
          reinstalled — and it is also what a machine-in-the-middle attack looks like.
          Confirm with whoever runs the host before continuing.
        </p>
        <dl className="mb-4 space-y-1 rounded bg-neutral-950 p-3">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-neutral-500">Expected</dt>
            <dd className={mono}>{detail.recorded_fingerprint}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-neutral-500">Offered</dt>
            <dd className={`${mono} text-red-300`}>{detail.presented_fingerprint}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-neutral-500">Recorded at</dt>
            <dd className={mono}>
              {detail.known_hosts_path}:{detail.known_hosts_line}
            </dd>
          </div>
        </dl>
        {/* No "connect anyway". Forgetting the key is a separate, deliberate
            act; the next connect then presents as ordinary first contact. */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-neutral-300 hover:bg-neutral-800"
            onClick={onDismiss}
          >
            Close
          </button>
          <button
            type="button"
            className="rounded border border-red-700 px-3 py-1.5 text-red-300 hover:bg-red-950"
            onClick={onForget}
          >
            Forget this key
          </button>
        </div>
      </div>
    </div>
  );
}
