# Health Sync — iOS app

The iPhone app that runs the sync, with **Apple Health as the hub**:
- **Fitbit cloud** (optional, two-way): sleep/workouts/weight out, everything in
- **Nightscout / AAPS** (optional, read-only in): CGM glucose, insulin
  (boluses + temp-basal segments), carbs — into Apple Health
- **Garmin**: wear it 24/7 paired to Android; Garmin Connect's own Apple
  Health integration lands its data in HealthKit, where the engine treats it
  as one more source (`garmin`) and dedupes it against everything else
- **Manual entries** (Health app "+"): recognized via `HKWasUserEntered` and
  ranked ABOVE all devices — an under-desk treadmill walk you logged by hand
  wins its time window over a wrist that barely moved

All powered by the shared engine in `packages/engine`.

Once Fitbit is connected, the app registers a **background task** so iOS
re-runs the sync automatically a few times a day (cadence is up to iOS;
keep Background App Refresh enabled in Settings). The Sync button is for
on-demand runs and first-time setup.

```
App.tsx                     UI: connect Fitbit, sync, results
src/
  sync/background.ts        BGTaskScheduler task: periodic automatic sync
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
   `healthsync://oauth`. Paste the Client ID into `expo.extra.fitbitClientId`
   in `app.json`.
2. **Apple side**: an Apple Developer account with the HealthKit capability
   (the config plugin in `app.json` sets up entitlements and Info.plist).

## Install via TestFlight (recommended — no Mac needed)

Builds run on Expo's EAS cloud and submit straight to App Store Connect.
Prerequisites: a **paid Apple Developer Program** membership ($99/yr —
TestFlight requires it) and a free Expo account.

```bash
npm install                    # repo root
cd apps/mobile
npm i -g eas-cli && eas login  # free Expo account
eas init                       # links the project to your Expo account (once)
npm run build:testflight       # cloud build; sign in with your Apple ID when
                               # prompted — EAS creates certs/profiles and the
                               # HealthKit-capable App ID automatically
npm run submit:testflight      # uploads the finished build to App Store Connect
```

Then in [App Store Connect](https://appstoreconnect.apple.com) → your app →
**TestFlight**: add yourself to Internal Testing, and install the app on your
iPhone through the TestFlight app. Internal builds are installable within
minutes of processing — no App Review needed. Later builds are just
`build:testflight` + `submit:testflight` again; the build number
auto-increments.

## Build & run locally (alternative; needs a Mac with Xcode)

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

## Google Health's built-in "Connect to Apple Health"

The Google Health (Fitbit) iOS app offers its own Apple Health connection.
It is **import-only** (Apple → Google): Apple Health never receives your
Fitbit data through it, which is the direction that matters. Recommendation:
**leave it OFF** and let this app own both directions — one transport per
direction keeps every record tagged and deduped under our rules, instead of
depending on Google's opaque merge for the overlap. (If you do enable it,
the sync stays correct — gap-filling means we never add data to time a
platform already covers — but Google-side totals then rely on Google's own
multi-device arbitration.)

## Known platform asymmetries (Fitbit API limitations)

- Fitbit's API **cannot ingest raw step / heart-rate / distance samples** —
  there are simply no write endpoints. Apple-only activity syncs to Fitbit as
  logged *activities/sleep/weight*; raw Watch step samples stay Apple-side.
  Everything Fitbit records still syncs fully INTO Apple Health, and overlap
  dedup protects both directions. The app reports skipped records per sync.
- Fitbit has no record metadata, so sync-authored records are tracked in a
  local logId map (`tagStore`) instead of platform-side tags.
