/**
 * Provider abstraction: one implementation per platform.
 *
 * Reads must return ALL records in the range, including ones this engine
 * wrote earlier (the engine filters those out itself via `externalId`).
 * Writes must persist `externalId` so sync-authored records are recognizable
 * on later reads — every mainstream health API supports this
 * (HealthKit metadata / HKMetadataKeyExternalUUID, Health Connect clientRecordId,
 * Fitbit log ids kept in the ledger).
 */

import type { HealthRecord, Platform, TimeRange } from "../types.js";

export interface HealthProvider {
  readonly platform: Platform;
  /**
   * A read-only provider is a pure data source (e.g. Nightscout CGM data):
   * its records feed the canonical timeline and sync to every writable
   * platform, but the engine never writes to or deletes from it.
   */
  readonly readOnly?: boolean;
  /** Read all records of the given types in the range. */
  read(range: TimeRange): Promise<HealthRecord[]>;
  /** Write records; must persist each record's externalId. */
  write(records: HealthRecord[]): Promise<void>;
  /** Delete previously sync-authored records by externalId (for re-writes). */
  deleteByExternalIds(externalIds: string[]): Promise<void>;
}
