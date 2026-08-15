"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Hydration-safe mount flag. Returns `false` for the server render AND the client's
 * hydration pass (so SSR HTML matches), then `true` after hydration so components can
 * safely render account/`window`-dependent state without "server rendered HTML didn't
 * match the client" errors (e.g. wagmi rehydrates the connected account on first render).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}