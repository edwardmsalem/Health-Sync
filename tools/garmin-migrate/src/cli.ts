/**
 * garmin-migrate CLI
 *
 *   npm run migrate -- --export ~/Downloads/apple_health_export/export.xml \
 *       [--fitbit-token <token>] [--since 2020-01-01] [--out ./garmin-out]
 *
 * Produces:
 *   garmin-out/tcx/*.tcx    one file per (deduped) workout
 *   garmin-out/weight.csv   weight + body-fat history
 *   garmin-out/summary.json what was kept/dropped
 *
 * Then upload with upload.py (bulk, via the garminconnect Python library) or
 * manually at https://connect.garmin.com/modern/import-data
 */

import { parseExportXml } from "./parseExport.ts";
import { fetchAllFitbitActivities } from "./fitbitActivities.ts";
import { migrate } from "./migrate.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const exportPath = arg("export");
if (!exportPath) {
  console.error(
    "Usage: npm run migrate -- --export <export.xml> [--fitbit-token <token>] [--since YYYY-MM-DD] [--out <dir>]",
  );
  process.exit(1);
}
const outDir = arg("out") ?? "./garmin-out";
const sinceArg = arg("since");
const sinceMs = sinceArg ? Date.parse(`${sinceArg}T00:00:00Z`) : undefined;
if (sinceArg && Number.isNaN(sinceMs)) {
  console.error(`Bad --since date: ${sinceArg} (expected YYYY-MM-DD)`);
  process.exit(1);
}

console.log(`Parsing ${exportPath} (streaming, may take a minute)...`);
const exportData = await parseExportXml(exportPath);
console.log(
  `  Apple export: ${exportData.workouts.length} workouts, ${exportData.bodyMetrics.length} weight/body-fat records`,
);

const fitbitToken = arg("fitbit-token");
if (fitbitToken) {
  console.log("Fetching Fitbit activity history...");
  const fitbitWorkouts = await fetchAllFitbitActivities(fitbitToken);
  console.log(`  Fitbit: ${fitbitWorkouts.length} activities`);
  exportData.workouts.push(...fitbitWorkouts);
}

const result = await migrate({ ...exportData, outDir, sinceMs });

console.log(`
Done. Wrote to ${outDir}/
  ${result.tcxFiles.length} workout TCX files (${result.duplicateWorkoutsDropped} cross-source duplicates removed)
  weight.csv with ${result.weightRows} entries (${result.duplicateBodyMetricsDropped} duplicates removed)

Next: push to Garmin Connect
  python3 -m pip install garminconnect
  python3 upload.py ${outDir}          # prompts for Garmin email/password (MFA supported)
or import the TCX files manually at https://connect.garmin.com/modern/import-data
`);
