/**
 * History import (backfill).
 *
 * The regular sync covers a short recent window. Importing older history is a
 * different problem because Fitbit's intraday endpoints cost one API call per
 * metric per day and Fitbit allows only 150 requests/hour: ~4 calls/day means
 * roughly 37 days per hour, so even a couple of months cannot be pulled in one
 * pass.
 *
 * So a backfill is a walk backwards through time in day-sized chunks, with the
 * cursor persisted after every chunk:
 *   - each chunk is a normal, fully deduped engine sync over its own window,
 *     so history is merged with the same overlap rules as live data;
 *   - hitting the rate limit is not a failure, it just ends this pass — the
 *     cursor stays put and the next pass (manual, or the background task)
 *     resumes exactly where it stopped;
 *   - progress is idempotent: re-running a chunk writes nothing new.
 */

import type { SyncReport } from "health-sync";
import { FitbitRateLimitError } from "../fitbit/bridge.ts";
import type { KV } from "../storage/kv.ts";
import { AsyncStorageKV } from "../storage/asyncStorageKV.ts";
import { buildSyncStack, DEFAULT_SETTINGS, type SyncSettings } from "./runSync.ts";

const STATE_KEY = "backfill-state";
const DAY_MS = 86_400_000;

/** Days per chunk. 7 days x ~4 intraday calls = ~28 calls, well under 150. */
export const CHUNK_DAYS = 7;

export interface BackfillState {
  /** Oldest instant we are importing back to. */
  targetStartMs: number;
  /** Next (exclusive) end for the chunk to import; walks backwards. */
  cursorMs: number;
  startedAtMs: number;
}

export async function getBackfillState(kv: KV): Promise<BackfillState | null> {
  const raw = await kv.get(STATE_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as BackfillState;
    if (typeof s.targetStartMs !== "number" || typeof s.cursorMs !== "number") return null;
    return s;
  } catch {
    return null;
  }
}

async function setBackfillState(kv: KV, state: BackfillState | null): Promise<void> {
  await kv.set(STATE_KEY, state ? JSON.stringify(state) : "");
}

/** Begin importing the last `days` of history. Overwrites any prior run. */
export async function startBackfill(
  days: number,
  nowMs = Date.now(),
  kv: KV = new AsyncStorageKV(),
): Promise<BackfillState> {
  const state: BackfillState = {
    targetStartMs: nowMs - days * DAY_MS,
    cursorMs: nowMs,
    startedAtMs: nowMs,
  };
  await setBackfillState(kv, state);
  return state;
}

export async function cancelBackfill(kv: KV = new AsyncStorageKV()): Promise<void> {
  await setBackfillState(kv, null);
}

export interface BackfillProgress {
  /** 0..1 across the requested span. */
  fraction: number;
  daysRemaining: number;
  daysTotal: number;
}

export function progressOf(state: BackfillState): BackfillProgress {
  const total = Math.max(1, state.startedAtMs - state.targetStartMs);
  const remaining = Math.max(0, state.cursorMs - state.targetStartMs);
  return {
    fraction: Math.min(1, Math.max(0, 1 - remaining / total)),
    daysRemaining: Math.ceil(remaining / DAY_MS),
    daysTotal: Math.ceil(total / DAY_MS),
  };
}

export type BackfillOutcome = "completed" | "rate_limited" | "no_backfill" | "chunks_done";

export interface BackfillResult {
  outcome: BackfillOutcome;
  chunksProcessed: number;
  reports: SyncReport[];
  progress: BackfillProgress | null;
  message: string;
}

/**
 * Process up to `maxChunks` chunks of the pending backfill.
 *
 * Returns rather than throws when the Fitbit rate limit is hit — progress is
 * already saved, so this is a normal pause, not an error.
 */
export async function runBackfill(options: {
  maxChunks?: number;
  settings?: SyncSettings;
  kv?: KV;
  onChunk?: (progress: BackfillProgress) => void;
} = {}): Promise<BackfillResult> {
  const kv = options.kv ?? new AsyncStorageKV();
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const maxChunks = options.maxChunks ?? 5;

  const state = await getBackfillState(kv);
  if (!state) {
    return {
      outcome: "no_backfill",
      chunksProcessed: 0,
      reports: [],
      progress: null,
      message: "No history import in progress.",
    };
  }

  const stack = await buildSyncStack(settings);
  const reports: SyncReport[] = [];
  let chunks = 0;
  let cursor = state.cursorMs;

  while (chunks < maxChunks && cursor > state.targetStartMs) {
    const end = cursor;
    const start = Math.max(state.targetStartMs, end - CHUNK_DAYS * DAY_MS);
    try {
      reports.push(await stack.engine.sync({ start, end }));
    } catch (e) {
      if (e instanceof FitbitRateLimitError) {
        await setBackfillState(kv, { ...state, cursorMs: cursor });
        const progress = progressOf({ ...state, cursorMs: cursor });
        return {
          outcome: "rate_limited",
          chunksProcessed: chunks,
          reports,
          progress,
          message: `${e.message}. ${progress.daysRemaining} day(s) left — it resumes automatically.`,
        };
      }
      // Persist what completed before surfacing a real failure.
      await setBackfillState(kv, { ...state, cursorMs: cursor });
      throw e;
    }
    cursor = start;
    chunks++;
    await setBackfillState(kv, { ...state, cursorMs: cursor });
    options.onChunk?.(progressOf({ ...state, cursorMs: cursor }));
  }

  if (cursor <= state.targetStartMs) {
    await setBackfillState(kv, null);
    return {
      outcome: "completed",
      chunksProcessed: chunks,
      reports,
      progress: { fraction: 1, daysRemaining: 0, daysTotal: progressOf(state).daysTotal },
      message: "History import complete.",
    };
  }

  const progress = progressOf({ ...state, cursorMs: cursor });
  return {
    outcome: "chunks_done",
    chunksProcessed: chunks,
    reports,
    progress,
    message: `${progress.daysRemaining} day(s) of history left — tap again or let it finish in the background.`,
  };
}
