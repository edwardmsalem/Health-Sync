/**
 * Pure zip reading for Takeout exports — no Expo/native imports, so it is
 * unit-testable off-device (see provider.test.ts).
 */

import { unzipSync, strFromU8 } from "fflate";
import type { HealthRecord } from "health-sync";
import { classifyTakeoutFile, parseTakeoutFile } from "./parse.ts";

/** Parse every recognized Fitbit JSON file inside a Takeout zip. */
export function parseTakeoutZip(
  zipBytes: Uint8Array,
  utcOffsetMs: number,
  onProgress?: (filesParsed: number, total: number) => void,
): { records: HealthRecord[]; filesParsed: number } {
  const entries = unzipSync(zipBytes, {
    filter: (file) => classifyTakeoutFile(file.name) !== null,
  });
  const names = Object.keys(entries);
  const records: HealthRecord[] = [];
  let filesParsed = 0;
  for (const name of names) {
    try {
      const json = JSON.parse(strFromU8(entries[name]!));
      records.push(...parseTakeoutFile(name, json, utcOffsetMs));
    } catch {
      // A single malformed file shouldn't abandon the whole import.
    }
    filesParsed++;
    onProgress?.(filesParsed, names.length);
  }
  return { records, filesParsed };
}
