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

describe("temp basal supersession", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = Date.UTC(2026, 7, 25, 12, 0, 0);
  const MIN = 60_000;

  it("truncates a temp basal replaced before its declared duration", () => {
    // AAPS sets 1.0 U/h for 30 min, then replaces it 5 minutes later.
    const records = parseTreatments([
      { eventType: "Temp Basal", created_at: iso(T), rate: 1.0, duration: 30 },
      { eventType: "Temp Basal", created_at: iso(T + 5 * MIN), rate: 2.0, duration: 30 },
    ]);
    const basals = records.filter((r) => r.metric === "insulin_basal_units");
    expect(basals).toHaveLength(2);
    // 1.0 U/h for 5 min = 0.083 U, NOT 0.5 U from the declared 30 min.
    expect(basals[0]!.value).toBeCloseTo(0.083, 3);
    expect(basals[0]!.end).toBe(T + 5 * MIN);
    // The last one keeps its declared duration: 2.0 U/h for 30 min = 1 U.
    expect(basals[1]!.value).toBeCloseTo(1.0, 3);
  });

  it("keeps the full duration when nothing supersedes it", () => {
    const records = parseTreatments([
      { eventType: "Temp Basal", created_at: iso(T), rate: 1.2, duration: 30 },
    ]);
    const b = records.find((r) => r.metric === "insulin_basal_units")!;
    expect(b.value).toBeCloseTo(0.6, 3);
    expect(b.end).toBe(T + 30 * MIN);
  });

  it("a back-to-back run does not over-count", () => {
    // Six 30-minute temp basals at 1 U/h, each replaced after 5 minutes.
    // Real delivery is 30 minutes of 1 U/h = 0.5 U, not 6 x 0.5 = 3 U.
    const treatments = Array.from({ length: 6 }, (_, i) => ({
      eventType: "Temp Basal",
      created_at: iso(T + i * 5 * MIN),
      rate: 1.0,
      duration: 30,
    }));
    const basals = parseTreatments(treatments).filter(
      (r) => r.metric === "insulin_basal_units",
    );
    const total = basals.reduce((t, b) => t + b.value, 0);
    // five 5-minute segments + the final full 30 minutes
    expect(total).toBeCloseTo(5 * (1 / 12) + 0.5, 2);
    expect(total).toBeLessThan(3);
  });

  it("ignores a zero-rate or malformed temp basal", () => {
    const records = parseTreatments([
      { eventType: "Temp Basal", created_at: iso(T), rate: 0, duration: 30 },
      { eventType: "Temp Basal", created_at: iso(T + MIN) },
    ]);
    expect(records.filter((r) => r.metric === "insulin_basal_units")).toHaveLength(0);
  });
});
