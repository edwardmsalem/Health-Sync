/**
 * Fetch the full Fitbit activity-log history with a bearer token.
 *
 * Why optional: after the Health-Sync iOS app has been running, Apple Health
 * already contains the merged record — but Fitbit workouts are represented
 * there as energy/distance samples, not HKWorkouts, so they won't be in the
 * export's <Workout> list. Passing --fitbit-token pulls them from Fitbit
 * directly; the engine's workout dedup removes any that Apple also has.
 *
 * Getting a token quickly (no code changes): dev.fitbit.com → Manage My Apps
 * → your app → "OAuth 2.0 tutorial" link — it walks you to a copy-pasteable
 * access token in about a minute.
 */

import type { WorkoutRecord } from "health-sync";

interface FitbitActivityLog {
  logId: number;
  activityName: string;
  startTime: string; // ISO with offset
  duration: number; // ms
  calories?: number;
  distance?: number; // km
}

function normalizeActivity(name: string): string {
  const n = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_|_$/g, "");
  const aliases: Record<string, string> = {
    run: "running",
    running: "running",
    walk: "walking",
    walking: "walking",
    bike: "cycling",
    biking: "cycling",
    outdoor_bike: "cycling",
    cycling: "cycling",
    swim: "swimming",
    swimming: "swimming",
    weights: "strength_training",
    workout: "workout",
    hike: "hiking",
    hiking: "hiking",
    yoga: "yoga",
    treadmill: "running",
    elliptical: "elliptical",
    sport: "sport",
    aerobic_workout: "workout",
  };
  return aliases[n] ?? n;
}

export function activityLogsToWorkouts(logs: FitbitActivityLog[]): WorkoutRecord[] {
  return logs.map((log) => {
    const start = Date.parse(log.startTime);
    return {
      type: "workout" as const,
      nativeId: String(log.logId),
      activity: normalizeActivity(log.activityName),
      start,
      end: start + log.duration,
      source: { id: "fitbit", name: "Fitbit", platform: "google" as const },
      activeEnergyKcal: log.calories,
      distanceMeters:
        log.distance !== undefined ? Math.round(log.distance * 1000) : undefined,
    };
  });
}

export async function fetchAllFitbitActivities(
  accessToken: string,
  afterDate = "2010-01-01",
): Promise<WorkoutRecord[]> {
  const logs: FitbitActivityLog[] = [];
  let url: string | null =
    `https://api.fitbit.com/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&limit=100&offset=0`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Fitbit activities fetch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      activities?: FitbitActivityLog[];
      pagination?: { next?: string };
    };
    logs.push(...(json.activities ?? []));
    url = json.pagination?.next || null;
  }
  return activityLogsToWorkouts(logs);
}
