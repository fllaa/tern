import { TerminalView } from "./components/TerminalView";
import { useSessionStore } from "./store/session";

export default function App() {
  const status = useSessionStore((s) => s.status);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-800 px-3 text-sm">
        <span className="font-medium tracking-wide">Tern</span>
        <span className="text-xs text-neutral-400">{status}</span>
      </header>
      <main className="min-h-0 flex-1">
        <TerminalView />
      </main>
    </div>
  );
}
