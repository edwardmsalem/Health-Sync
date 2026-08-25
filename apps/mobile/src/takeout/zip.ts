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

/** List the entries in a zip without decompressing any of them. */
function listNames(zipBytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zipBytes, {
    filter: (file) => {
      names.push(file.name);
      return false; // record the name, decompress nothing
    },
  });
  return names;
}

/**
 * Parse every recognized Fitbit/Google Health JSON file inside a Takeout zip.
 *
 * Files are decompressed ONE AT A TIME rather than in a single unzipSync
 * pass. A couple of months of Fitbit data holds millions of heart-rate
 * readings — well over 100MB of JSON if every file were expanded at once,
 * which is enough to get the app killed on a phone. Walking the archive per
 * file keeps only one decompressed file alive at a time; re-scanning the
 * central directory each pass is cheap by comparison.
 */
export function parseTakeoutZip(
  zipBytes: Uint8Array,
  utcOffsetMs: number,
  onProgress?: (filesParsed: number, total: number) => void,
): TakeoutZipResult {
  const unrecognized: string[] = [];
  const wanted: string[] = [];

  for (const name of listNames(zipBytes)) {
    if (classifyTakeoutFile(name) !== null) {
      wanted.push(name);
    } else if (name.toLowerCase().endsWith(".json") && unrecognized.length < UNRECOGNIZED_SAMPLE) {
      unrecognized.push(name);
    }
  }

  const records: HealthRecord[] = [];
  let filesParsed = 0;
  for (const name of wanted) {
    try {
      const entry = unzipSync(zipBytes, { filter: (f) => f.name === name })[name];
      if (entry) {
        records.push(...parseTakeoutFile(name, JSON.parse(strFromU8(entry)), utcOffsetMs));
      }
    } catch {
      // A single malformed file shouldn't abandon the whole import.
    }
    filesParsed++;
    onProgress?.(filesParsed, wanted.length);
  }

  return { records, filesParsed, unrecognized };
}
