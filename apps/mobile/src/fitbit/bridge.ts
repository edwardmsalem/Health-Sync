/**
 * Fitbit Web API bridge — the "google" platform side of the sync, reachable
 * directly from the iPhone (no Android device needed; your Fitbit's data
 * lives in Fitbit's cloud).
 *
 * Implements the engine's HealthConnectBridge interface:
 *   - readRecords: intraday steps/distance/calories/heart rate, sleep logs,
 *     activity logs, weight logs, for each local day touching the range;
 *   - insertRecords: sleep / activity / weight+fat logs. Records with no
 *     Fitbit write endpoint (raw steps, HR, ...) are counted in
 *     `skippedWrites` — the Fitbit API simply cannot ingest them;
 *   - deleteRecordsByClientIds: via the local logId<->externalId tag store
 *     (Fitbit has no metadata field, so tagging is client-side).
 *
 * All parsing/serialization is in parse.ts / serialize.ts (pure, tested);
 * this class only orchestrates HTTP.
 */

import type { HealthConnectBridge, HealthRecord, TimeRange } from "health-sync";
import {
  FitbitActivityLog,
  FitbitSleepLog,
  FitbitWeightLog,
  parseActivityLogs,
  parseIntradayCumulative,
  parseIntradayHeartRate,
  parseIntradaySteps,
  parseSleepLogs,
  parseWeightLogs,
} from "./parse.ts";
import { deletePathFor, serializeRecord, toLocalParts } from "./serialize.ts";
import { FitbitTagStore } from "./tagStore.ts";

const API = "https://api.fitbit.com";
const DAY_MS = 86_400_000;

export interface FitbitHttp {
  /** Perform an authorized request; throws on non-2xx. */
  request(method: "GET" | "POST" | "DELETE", path: string, body?: URLSearchParams): Promise<unknown>;
}

/**
 * Fitbit allows 150 requests/hour per user. The intraday endpoints cost one
 * call per metric per day, so a long history import will hit this — callers
 * (see sync/backfill.ts) catch it, save their progress, and resume later.
 */
export class FitbitRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(
      retryAfterSeconds
        ? `Fitbit rate limit reached — retry in about ${Math.ceil(retryAfterSeconds / 60)} min`
        : "Fitbit rate limit reached — retry within the hour",
    );
    this.name = "FitbitRateLimitError";
  }
}

/** Default HTTP implementation over fetch + a token supplier. */
export class FetchFitbitHttp implements FitbitHttp {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: URLSearchParams): Promise<unknown> {
    const token = await this.getAccessToken();
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Language": "en_US",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body?.toString(),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      throw new FitbitRateLimitError(Number.isFinite(retryAfter) ? retryAfter : null);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fitbit ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }
}

export class FitbitBridge implements HealthConnectBridge {
  /** Records that had no Fitbit write endpoint on the last insertRecords. */
  skippedWrites: HealthRecord[] = [];

  constructor(
    private readonly http: FitbitHttp,
    private readonly tagStore: FitbitTagStore,
    private readonly utcOffsetMs: number,
  ) {}

  /** Local "yyyy-MM-dd" strings for every day the range touches. */
  private daysIn(range: TimeRange): string[] {
    const days: string[] = [];
    for (let t = range.start; t < range.end + DAY_MS; t += DAY_MS) {
      const { date } = toLocalParts(t, this.utcOffsetMs);
      if (!days.includes(date)) days.push(date);
      if (days.length > 62) break; // API sanity bound
    }
    return days;
  }

  async readRecords(range: TimeRange): Promise<HealthRecord[]> {
    const days = this.daysIn(range);
    const out: HealthRecord[] = [];

    for (const date of days) {
      const [steps, distance, calories, heart] = await Promise.all([
        this.http.request("GET", `/1/user/-/activities/steps/date/${date}/1d/1min.json`),
        this.http.request("GET", `/1/user/-/activities/distance/date/${date}/1d/1min.json`),
        this.http.request("GET", `/1/user/-/activities/calories/date/${date}/1d/1min.json`),
        this.http.request("GET", `/1/user/-/activities/heart/date/${date}/1d/1min.json`),
      ]);
      out.push(
        ...parseIntradaySteps(date, (steps as any)["activities-steps-intraday"] ?? { dataset: [] }, this.utcOffsetMs),
        ...parseIntradayCumulative(date, (distance as any)["activities-distance-intraday"] ?? { dataset: [] }, this.utcOffsetMs, "distance_m", 1000),
        ...parseIntradayCumulative(date, (calories as any)["activities-calories-intraday"] ?? { dataset: [] }, this.utcOffsetMs, "active_energy_kcal", 1),
        ...parseIntradayHeartRate(date, (heart as any)["activities-heart-intraday"] ?? { dataset: [] }, this.utcOffsetMs),
      );
    }

    const first = days[0]!;
    const last = days[days.length - 1]!;
    const [sleepRes, weightRes, activityRes] = await Promise.all([
      this.http.request("GET", `/1.2/user/-/sleep/date/${first}/${last}.json`),
      this.http.request("GET", `/1/user/-/body/log/weight/date/${first}/${last}.json`),
      this.http.request("GET", `/1/user/-/activities/list.json?afterDate=${first}&sort=asc&limit=100&offset=0`),
    ]);
    out.push(
      ...parseSleepLogs(((sleepRes as any).sleep ?? []) as FitbitSleepLog[], this.utcOffsetMs),
      ...parseWeightLogs(((weightRes as any).weight ?? []) as FitbitWeightLog[], this.utcOffsetMs),
      ...parseActivityLogs(((activityRes as any).activities ?? []) as FitbitActivityLog[]),
    );

    // Mark records we authored (via the tag store) so the engine skips them.
    return out
      .map((r) => {
        const externalId = r.nativeId ? this.tagStore.externalIdFor(r.nativeId) : undefined;
        return externalId ? { ...r, externalId } : r;
      })
      .filter((r) => r.start < range.end && r.end >= range.start);
  }

  async insertRecords(records: HealthRecord[]): Promise<void> {
    this.skippedWrites = [];
    for (const record of records) {
      const write = serializeRecord(record, this.utcOffsetMs);
      if (!write) {
        this.skippedWrites.push(record);
        continue;
      }
      const res = (await this.http.request("POST", write.path, new URLSearchParams(write.params))) as any;
      const logId =
        res?.sleep?.logId ?? res?.activityLog?.logId ?? res?.weightLog?.logId ?? res?.fatLog?.logId;
      if (logId !== undefined && record.externalId) {
        this.tagStore.record(logId, record.externalId, write.kind);
      }
    }
    await this.tagStore.save();
  }

  async deleteRecordsByClientIds(clientRecordIds: string[]): Promise<void> {
    for (const externalId of clientRecordIds) {
      const entry = this.tagStore.entryFor(externalId);
      if (!entry) continue;
      await this.http.request("DELETE", deletePathFor(entry.kind, entry.logId));
      this.tagStore.forget(entry.logId);
    }
    await this.tagStore.save();
  }
}
