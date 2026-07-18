/**
 * Content fingerprints identify "the same logical record" across platforms
 * and sync runs, independent of platform-native ids.
 */

import { createHash } from "node:crypto";
import type { HealthRecord } from "../types.js";

export function fingerprint(record: HealthRecord): string {
  const h = createHash("sha256");
  h.update(record.type);
  h.update(String(record.start));
  h.update(String(record.end));
  h.update(record.source.id);
  switch (record.type) {
    case "steps":
      h.update(String(record.steps));
      break;
    case "sleep":
      for (const s of record.stages) {
        h.update(`${s.stage}:${s.start}:${s.end}`);
      }
      break;
    case "workout":
      h.update(record.activity);
      break;
    case "cumulative":
    case "point":
      h.update(record.metric);
      h.update(String(record.value));
      break;
  }
  return h.digest("hex").slice(0, 24);
}
