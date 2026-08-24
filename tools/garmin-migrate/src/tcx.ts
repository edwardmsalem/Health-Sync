/**
 * Pure TCX (Training Center XML) generator — the format Garmin Connect's
 * importer accepts. One activity per file.
 *
 * TCX's Sport enum only allows Running | Biking | Other; the real activity
 * name goes in <Notes> so it's visible after import (Garmin lets you change
 * the activity type on the imported activity).
 */

import type { WorkoutRecord } from "health-sync";

function tcxSport(activity: string): "Running" | "Biking" | "Other" {
  if (activity === "running") return "Running";
  if (activity === "cycling") return "Biking";
  return "Other";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const iso = (ms: number) => new Date(ms).toISOString();

export function workoutToTcx(w: WorkoutRecord): string {
  const start = iso(w.start);
  const totalSeconds = Math.max(1, Math.round((w.end - w.start) / 1000));
  const distance = Math.max(0, Math.round(w.distanceMeters ?? 0));
  const calories = Math.max(0, Math.round(w.activeEnergyKcal ?? 0));
  const note = `${w.activity} (imported from ${w.source.name ?? w.source.id} via health-sync)`;

  // Two minimal trackpoints (start/end with cumulative distance) — some
  // importers reject lap-only TCX files.
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="${tcxSport(w.activity)}">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${totalSeconds}</TotalTimeSeconds>
        <DistanceMeters>${distance}</DistanceMeters>
        <Calories>${calories}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
          <Trackpoint>
            <Time>${start}</Time>
            <DistanceMeters>0</DistanceMeters>
          </Trackpoint>
          <Trackpoint>
            <Time>${iso(w.end)}</Time>
            <DistanceMeters>${distance}</DistanceMeters>
          </Trackpoint>
        </Track>
      </Lap>
      <Notes>${esc(note)}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

/** Stable, sortable filename for a workout's TCX file. */
export function tcxFilename(w: WorkoutRecord): string {
  const stamp = new Date(w.start)
    .toISOString()
    .replace(/[:]/g, "-")
    .replace(/\..+$/, "");
  return `${stamp}_${w.activity.replace(/[^a-z0-9_]+/gi, "-")}.tcx`;
}
