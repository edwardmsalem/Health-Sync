/**
 * Read a Google Takeout .zip on-device and merge it into Apple Health.
 *
 * The user exports Fitbit data at takeout.google.com, gets the .zip onto the
 * phone (AirDrop / Files / iCloud Drive), and picks it here. Everything
 * happens locally: unzip in memory with fflate, parse the JSON, then run the
 * normal sync engine so history is deduped against whatever Apple Health
 * already has.
 *
 * The import is chunked by day-span so a large export doesn't hold every
 * record in one engine pass, and so progress can be reported.
 */

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import {
  AppleHealthProvider,
  SyncEngine,
  type HealthRecord,
  type SyncReport,
} from "health-sync";
import { AppleHealthKitBridge } from "../healthkit/bridge.ts";
import { NativeHKClient } from "../healthkit/client.ts";
import { getNightscoutConfig } from "../nightscout/config.ts";
import { AsyncStorageKV } from "../storage/asyncStorageKV.ts";
import { loadLedger } from "../sync/ledgerStore.ts";
import { DEFAULT_SETTINGS, type SyncSettings } from "../sync/runSync.ts";
import { TakeoutProvider } from "./provider.ts";
import { parseTakeoutZip } from "./zip.ts";

export { parseTakeoutZip };

const DAY_MS = 86_400_000;
/** Days of history merged per engine pass. */
const CHUNK_DAYS = 14;

export interface TakeoutImportProgress {
  phase: "reading" | "parsing" | "merging";
  /** 0..1 within the current phase. */
  fraction: number;
  filesParsed?: number;
  recordsFound?: number;
}

export interface TakeoutImportResult {
  cancelled: boolean;
  filesParsed: number;
  recordsFound: number;
  reports: SyncReport[];
  firstDay: string | null;
  lastDay: string | null;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Full flow: pick the zip, parse it, and merge it into Apple Health in
 * day-span chunks. Returns cancelled:true if the picker was dismissed.
 */
export async function importFromTakeout(options: {
  settings?: SyncSettings;
  onProgress?: (p: TakeoutImportProgress) => void;
} = {}): Promise<TakeoutImportResult> {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const report = (p: TakeoutImportProgress) => options.onProgress?.(p);

  const picked = await DocumentPicker.getDocumentAsync({
    type: ["application/zip", "public.zip-archive", "*/*"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets?.[0]) {
    return {
      cancelled: true,
      filesParsed: 0,
      recordsFound: 0,
      reports: [],
      firstDay: null,
      lastDay: null,
    };
  }

  report({ phase: "reading", fraction: 0 });
  const base64 = await FileSystem.readAsStringAsync(picked.assets[0].uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  report({ phase: "reading", fraction: 1 });

  const utcOffsetMs = -new Date().getTimezoneOffset() * 60_000;
  const { records, filesParsed } = parseTakeoutZip(bytes, utcOffsetMs, (done, total) =>
    report({ phase: "parsing", fraction: total ? done / total : 1, filesParsed: done }),
  );

  const provider = new TakeoutProvider(records);
  const span = provider.span();
  if (!span) {
    return {
      cancelled: false,
      filesParsed,
      recordsFound: 0,
      reports: [],
      firstDay: null,
      lastDay: null,
    };
  }

  const kv = new AsyncStorageKV();
  const hkBridge = new AppleHealthKitBridge(new NativeHKClient());
  await hkBridge.authorize();

  const providers = [new AppleHealthProvider(hkBridge), provider];
  const nightscout = await getNightscoutConfig();
  void nightscout; // Nightscout is not needed for a historical file import.

  const engine = new SyncEngine(providers, {
    dedup: { devicePriority: settings.devicePriority, stepsStrategy: "priority" },
    ledger: await loadLedger(kv),
  });

  const reports: SyncReport[] = [];
  const totalMs = span.end - span.start;
  for (let start = span.start; start < span.end; start += CHUNK_DAYS * DAY_MS) {
    const end = Math.min(span.end, start + CHUNK_DAYS * DAY_MS);
    reports.push(await engine.sync({ start, end }));
    report({
      phase: "merging",
      fraction: Math.min(1, (end - span.start) / totalMs),
      filesParsed,
      recordsFound: records.length,
    });
  }

  return {
    cancelled: false,
    filesParsed,
    recordsFound: records.length,
    reports,
    firstDay: dayKey(span.start),
    lastDay: dayKey(span.end - 1),
  };
}
