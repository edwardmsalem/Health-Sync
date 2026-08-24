import { describe, it, expect } from "vitest";
import { parseEntries, parseTreatments } from "./parse.ts";
import { NightscoutProvider } from "./provider.ts";

const T0 = Date.UTC(2026, 7, 24, 8, 0, 0);

describe("Nightscout parsing", () => {
  it("parses CGM entries to glucose points", () => {
    const points = parseEntries([
      { sgv: 110, date: T0, type: "sgv" },
      { sgv: 122, date: T0 + 5 * 60_000, type: "sgv" },
      { sgv: 0, date: T0 + 10 * 60_000 }, // sensor gap
      { date: T0 + 15 * 60_000 }, // malformed
    ]);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      metric: "blood_glucose_mgdl",
      value: 110,
      start: T0,
    });
    expect(points[0]!.source.id).toBe("aaps");
  });

  it("parses boluses, carbs, and temp basals", () => {
    const iso = new Date(T0).toISOString();
    const records = parseTreatments([
      { eventType: "Meal Bolus", created_at: iso, insulin: 4.5, carbs: 45 },
      {
        eventType: "Temp Basal",
        created_at: new Date(T0 + 10 * 60_000).toISOString(),
        rate: 1.2,
        duration: 30,
      },
      { eventType: "Note", created_at: iso }, // nothing to extract
    ]);

    const bolus = records.find((r) => r.metric === "insulin_bolus_units")!;
    const carbs = records.find((r) => r.metric === "carbs_g")!;
    const basal = records.find((r) => r.metric === "insulin_basal_units")!;
    expect(bolus).toMatchObject({ type: "point", value: 4.5, start: T0 });
    expect(carbs).toMatchObject({ type: "point", value: 45 });
    // 1.2 U/h for 30 min = 0.6 U over the interval.
    expect(basal).toMatchObject({
      type: "cumulative",
      value: 0.6,
      start: T0 + 10 * 60_000,
      end: T0 + 40 * 60_000,
    });
  });

  it("supports the older `absolute` temp-basal field", () => {
    const records = parseTreatments([
      {
        eventType: "Temp Basal",
        created_at: new Date(T0).toISOString(),
        absolute: 0.8,
        duration: 60,
      },
    ]);
    expect(records[0]).toMatchObject({ metric: "insulin_basal_units", value: 0.8 });
  });
});

describe("NightscoutProvider", () => {
  it("fetches entries and treatments with the token and parses them", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      const body = url.includes("/entries/")
        ? [{ sgv: 115, date: T0, type: "sgv" }]
        : [{ eventType: "Meal Bolus", created_at: new Date(T0).toISOString(), insulin: 3 }];
      return {
        ok: true,
        status: 200,
        json: async () => body,
      };
    }) as unknown as typeof fetch;

    const provider = new NightscoutProvider(
      { url: "https://ns.example.com", token: "secret-token" },
      fakeFetch,
    );
    const records = await provider.read({ start: T0 - 3_600_000, end: T0 + 3_600_000 });

    expect(records).toHaveLength(2);
    expect(provider.readOnly).toBe(true);
    expect(calls.every((u) => u.includes("token=secret-token"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/v1/entries/sgv.json"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/v1/treatments.json"))).toBe(true);
    await expect(provider.write()).rejects.toThrow(/read-only/);
  });
});
