# Health Sync — iOS app

The iPhone app that runs the sync: **Apple Health (HealthKit) ⇄ Fitbit cloud**,
powered by the shared engine in `packages/engine`. No Android device is
needed — your Fitbit's data lives in Fitbit's cloud, and the app talks to it
directly over the Fitbit Web API.

```
App.tsx                     UI: connect Fitbit, sync, results
src/
  healthkit/
    mapping.ts              HK types/units/stages <-> engine records (pure, tested)
    bridge.ts               engine HealthKitBridge over a narrow HKClient
    client.ts               the ONLY native-touching file (@kingstinct/react-native-healthkit)
  fitbit/
    parse.ts                Fitbit API responses -> engine records (pure, tested)
    serialize.ts            engine records -> Fitbit write requests (pure, tested)
    tagStore.ts             logId <-> externalId map (echo prevention; Fitbit has no metadata)
    bridge.ts               engine HealthConnectBridge over the Fitbit Web API
    auth.ts                 OAuth 2.0 PKCE + token refresh (SecureStore)
  sync/runSync.ts           wires providers + ledger, runs one pass
  storage/                  injectable KV (AsyncStorage in prod, memory in tests)
```

## One-time setup

1. **Fitbit developer app** (2 minutes): at <https://dev.fitbit.com/apps>
   register an app with OAuth 2.0 Application Type **Personal** (this grants
   intraday — minute-level — access for your own account) and Redirect URL
   `healthsync://oauth`. Paste the Client ID into `FITBIT_CLIENT_ID` in
   `src/fitbit/auth.ts`.
2. **Apple side**: an Apple Developer account with the HealthKit capability
   (the config plugin in `app.json` sets up entitlements and Info.plist).

## Build & run (needs a Mac with Xcode; HealthKit does not exist on simulator-only data, use a real iPhone for meaningful testing)

```bash
npm install               # from the repo root (workspaces)
cd apps/mobile
npx expo prebuild -p ios  # generates the Xcode project with HealthKit entitlements
npx expo run:ios --device # build to your iPhone
```

## Tests

`npm test` — 22 tests, including an end-to-end pass: fake HealthKit store +
fake Fitbit HTTP server around the **real** engine and **real** bridges,
verifying overlap dedup, gap-filling, tagging, and echo-free re-runs. The
only untested file is `src/healthkit/client.ts` (requires a device).

## Known platform asymmetries (Fitbit API limitations)

- Fitbit's API **cannot ingest raw step / heart-rate / distance samples** —
  there are simply no write endpoints. Apple-only activity syncs to Fitbit as
  logged *activities/sleep/weight*; raw Watch step samples stay Apple-side.
  Everything Fitbit records still syncs fully INTO Apple Health, and overlap
  dedup protects both directions. The app reports skipped records per sync.
- Fitbit has no record metadata, so sync-authored records are tracked in a
  local logId map (`tagStore`) instead of platform-side tags.
