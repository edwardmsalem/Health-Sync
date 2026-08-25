/**
 * Pure zip reading for Takeout exports — no Expo/native imports, so it is
 * unit-testable off-device (see provider.test.ts).
 */

import { unzipSync, strFromU8 } from "fflate";
import type { HealthRecord } from "health-sync";
import { classifyTakeoutFile, parseTakeoutFile } from "./parse.ts";

export interface TakeoutZipResult {
  records: HealthRecord[];
  filesParsed: number;
  /**
   * A sample of .json files present that no parser claimed. Empty on a
   * normal export; if Google changes the layout this is what tells us what
   * the new one looks like, instead of the import silently finding nothing.
   */
  unrecognized: string[];
}

const UNRECOGNIZED_SAMPLE = 25;

/** Parse every recognized Fitbit/Google Health JSON file inside a Takeout zip. */
export function parseTakeoutZip(
  zipBytes: Uint8Array,
  utcOffsetMs: number,
  onProgress?: (filesParsed: number, total: number) => void,
): TakeoutZipResult {
  const unrecognized: string[] = [];
  const entries = unzipSync(zipBytes, {
    filter: (file) => {
      if (classifyTakeoutFile(file.name) !== null) return true;
      if (
        file.name.toLowerCase().endsWith(".json") &&
        unrecognized.length < UNRECOGNIZED_SAMPLE
      ) {
        unrecognized.push(file.name);
      }
      return false;
    },
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
  return { records, filesParsed, unrecognized };
}
