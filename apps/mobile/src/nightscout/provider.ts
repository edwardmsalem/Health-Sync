/**
 * Nightscout as a read-only engine provider: AAPS diabetes data (CGM
 * glucose, insulin, carbs) flows INTO the hub; the engine never writes back.
 *
 * Auth: Nightscout access tokens (Admin -> Subjects) go in the `token` query
 * param. A raw API_SECRET works too — pass it as the token and it's sent as
 * the api-secret header instead (hashed handling left to the server config).
 */

import type { HealthProvider, HealthRecord, TimeRange } from "health-sync";
import type { NightscoutConfig } from "./config.ts";
import {
  parseEntries,
  parseTreatments,
  type NightscoutEntry,
  type NightscoutTreatment,
} from "./parse.ts";

type FetchLike = typeof fetch;

export class NightscoutProvider implements HealthProvider {
  readonly platform = "nightscout" as const;
  readonly readOnly = true;

  constructor(
    private readonly config: NightscoutConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async get(path: string): Promise<unknown> {
    const sep = path.includes("?") ? "&" : "?";
    const url =
      `${this.config.url}${path}` +
      (this.config.token ? `${sep}token=${encodeURIComponent(this.config.token)}` : "");
    const res = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Nightscout GET ${path} failed (${res.status})`);
    }
    return res.json();
  }

  async read(range: TimeRange): Promise<HealthRecord[]> {
    const fromIso = new Date(range.start).toISOString();
    const toIso = new Date(range.end).toISOString();
    const [entries, treatments] = await Promise.all([
      this.get(
        `/api/v1/entries/sgv.json?find[date][$gte]=${range.start}&find[date][$lte]=${range.end}&count=20000`,
      ) as Promise<NightscoutEntry[]>,
      this.get(
        `/api/v1/treatments.json?find[created_at][$gte]=${fromIso}&find[created_at][$lte]=${toIso}&count=10000`,
      ) as Promise<NightscoutTreatment[]>,
    ]);
    return [...parseEntries(entries ?? []), ...parseTreatments(treatments ?? [])];
  }

  async write(): Promise<void> {
    throw new Error("Nightscout provider is read-only");
  }

  async deleteByExternalIds(): Promise<void> {
    throw new Error("Nightscout provider is read-only");
  }
}
