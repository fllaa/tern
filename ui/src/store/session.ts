import { create } from "zustand";

export type SessionStatus = "idle" | "connecting" | "connected" | "error";

interface SessionState {
  status: SessionStatus;
  setStatus: (status: SessionStatus) => void;
}

/** Minimal state seam for the Phase 0 spikes; the real session model lands in Phase 1. */
export const useSessionStore = create<SessionState>((set) => ({
  status: "idle",
  setStatus: (status) => set({ status }),
}));
