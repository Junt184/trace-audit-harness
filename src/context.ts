import { statSync } from "node:fs";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ContextSnapshot } from "./types.js";

export function sessionVersion(file?: string) {
  if (!file) return undefined;
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export function contextSnapshot(
  usage: ContextUsage | undefined,
  capacity: number,
  auto: boolean,
  compacting: boolean,
  previous?: ContextSnapshot,
): ContextSnapshot {
  const tokens = usage?.tokens ?? null;
  const contextWindow = usage?.contextWindow ?? capacity;
  return {
    tokens,
    contextWindow,
    percent: usage?.percent ?? null,
    remainingTokens:
      tokens === null ? null : Math.max(0, contextWindow - tokens),
    autoCompactionEnabled: auto,
    isCompacting: compacting,
    source: usage ? "sdk" : "unavailable",
    sampledAt: new Date().toISOString(),
    lastCompaction: previous?.lastCompaction,
    compactionError: previous?.compactionError,
  };
}
