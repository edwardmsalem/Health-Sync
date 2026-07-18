/**
 * Overlap-aware sleep deduplication.
 *
 * When two wearables track the same night, both platforms end up with a sleep
 * session covering roughly the same interval (e.g. Watch: 23:10-06:45,
 * Fitbit: 23:00-07:05). Keeping both would double-count sleep time.
 *
 * Approach:
 *   1. Sweep sessions in start order and cluster transitively-overlapping
 *      sessions (same night, possibly from several devices).
 *   2. In each cluster pick a primary session: highest device priority,
 *      tie-broken by richer stage data, then by longer duration.
 *   3. Keep the primary as-is. Trim every other session to the portions that
 *      don't overlap ANY kept session — a device that kept recording after
 *      the primary stopped contributes only that extra tail. Fragments
 *      shorter than `minSleepFragmentMs` are discarded as noise.
 */

import type { SleepSession, SleepStageInterval } from "../types.js";
import { overlaps, durationMs } from "../types.js";
import { DedupConfig, priorityRank } from "../config.js";

function clusterSessions(sessions: SleepSession[]): SleepSession[][] {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  const clusters: SleepSession[][] = [];
  let current: SleepSession[] = [];
  let currentEnd = -Infinity;
  for (const s of sorted) {
    if (current.length > 0 && s.start < currentEnd) {
      current.push(s);
      currentEnd = Math.max(currentEnd, s.end);
    } else {
      if (current.length > 0) clusters.push(current);
      current = [s];
      currentEnd = s.end;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Richness score: staged sessions beat plain "asleep" blobs. */
function stageRichness(s: SleepSession): number {
  const staged = s.stages.filter(
    (st) => st.stage !== "asleep" && st.stage !== "in_bed",
  );
  return staged.length;
}

function pickPrimary(cluster: SleepSession[], config: DedupConfig): SleepSession {
  return [...cluster].sort((a, b) => {
    const pr = priorityRank(config, a.source.id) - priorityRank(config, b.source.id);
    if (pr !== 0) return pr;
    const rich = stageRichness(b) - stageRichness(a);
    if (rich !== 0) return rich;
    return durationMs(b) - durationMs(a);
  })[0]!;
}

/** Subtract a set of kept intervals from a session, returning the remainders. */
function subtract(
  session: SleepSession,
  kept: { start: number; end: number }[],
): { start: number; end: number }[] {
  let pieces = [{ start: session.start, end: session.end }];
  for (const k of kept) {
    const next: { start: number; end: number }[] = [];
    for (const p of pieces) {
      if (!overlaps(p, k)) {
        next.push(p);
        continue;
      }
      if (p.start < k.start) next.push({ start: p.start, end: k.start });
      if (p.end > k.end) next.push({ start: k.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

function clipStages(
  stages: SleepStageInterval[],
  piece: { start: number; end: number },
): SleepStageInterval[] {
  const out: SleepStageInterval[] = [];
  for (const st of stages) {
    const start = Math.max(st.start, piece.start);
    const end = Math.min(st.end, piece.end);
    if (end > start) out.push({ stage: st.stage, start, end });
  }
  return out;
}

export interface DedupedSleep {
  /** Canonical, non-double-counted sleep sessions. */
  sessions: SleepSession[];
  /** Sessions (or parts) that were dropped as duplicates, for reporting. */
  droppedMs: number;
}

export function dedupeSleep(
  sessions: SleepSession[],
  config: DedupConfig,
): DedupedSleep {
  const out: SleepSession[] = [];
  let droppedMs = 0;

  for (const cluster of clusterSessions(sessions)) {
    if (cluster.length === 1) {
      out.push(cluster[0]!);
      continue;
    }
    const primary = pickPrimary(cluster, config);
    out.push(primary);
    const kept: { start: number; end: number }[] = [
      { start: primary.start, end: primary.end },
    ];

    // Losers ordered by priority so the second-best device claims leftover
    // time before less-trusted devices do.
    const losers = cluster
      .filter((s) => s !== primary)
      .sort(
        (a, b) =>
          priorityRank(config, a.source.id) - priorityRank(config, b.source.id),
      );

    for (const loser of losers) {
      let keptFromLoser = 0;
      for (const piece of subtract(loser, kept)) {
        const len = piece.end - piece.start;
        if (len >= config.minSleepFragmentMs) {
          out.push({
            ...loser,
            nativeId: undefined,
            start: piece.start,
            end: piece.end,
            stages: clipStages(loser.stages, piece),
          });
          kept.push(piece);
          keptFromLoser += len;
        }
      }
      droppedMs += durationMs(loser) - keptFromLoser;
    }
  }

  out.sort((a, b) => a.start - b.start);
  return { sessions: out, droppedMs };
}
