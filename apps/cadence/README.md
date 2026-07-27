# Cadence

A calendar for iOS and macOS that shows your **iCloud** and **Gmail** calendars
alongside your **Todoist** tasks, with natural-language entry and alerts.

Built in the idiom of Calendars by Readdle: a compact month grid with the
selected day's agenda live underneath it, color carried by the calendars
themselves, and a quick-add field you type sentences into.

---

## Why it is built this way

**iCloud has no web API.** No OAuth, no REST, no webhooks. The only supported
ways in are an app-specific-password CalDAV connection or EventKit on an Apple
device. That single fact drives the whole architecture:

- **EventKit, not per-provider APIs.** A Google account added in system Settings
  is exposed to EventKit over CalDAV, so *both* requested account types arrive
  as ordinary `EKCalendar`s. One framework, no OAuth flow, no Google
  verification review, and nothing leaves the device.
- **Native SwiftUI, not React Native.** Expo has no first-class macOS support,
  and "iOS and macOS" was a requirement. One multiplatform target covers both.
- **CloudKit for preferences only.** Events already sync through iCloud and
  Google; tasks already sync through Todoist. The only thing left needing
  cross-device sync is app preferences, which is small enough that CloudKit
  needs no backend at all.

## Building it

Requires Xcode 15+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`). The `.xcodeproj` is generated rather than committed,
because generated project files merge badly.

```sh
cd apps/cadence
export DEVELOPMENT_TEAM=YOURTEAMID   # from developer.apple.com → Membership
./bootstrap.sh --open
```

Then pick the **My Mac** or an iOS destination and run. On first launch the app
asks for calendar access; without it there is nothing to draw.

To run the tests: `⌘U`, or

```sh
xcodebuild test -project Cadence.xcodeproj -scheme Cadence \
  -destination 'platform=macOS'
```

### Connecting Todoist

Settings → Todoist → paste an API token from
[Todoist's developer settings](https://app.todoist.com/app/settings/integrations/developer).

A personal token rather than OAuth is deliberate for a personal app: a native
client cannot keep an OAuth *client secret* secret, so shipping one would be
security theatre. The token is stored in the keychain and the client only ever
sees a bearer token, so moving to OAuth later means replacing
`TodoistCredentials` and nothing else.

## TestFlight

Same pipeline as SalemTriage — fastlane with match signing — but run locally,
which is how SalemTriage actually ships (its GitHub CI never went green).

```sh
cd apps/cadence
export MATCH_PASSWORD=...     # the match passphrase from the Trio/Triage setup
fastlane ios ship             # build number from TestFlight, gym, upload
```

Lanes: `register` (one-time bundle-ID/app setup — note the app *record* itself
can only be created with an Apple ID, Apple's API forbids it), `build`,
`release`, `ship`. The App Store Connect API key is read from
`~/.appstoreconnect/private_keys/`; CI can override via `FASTLANE_KEY` env.

The first iOS builds ship **without CloudKit** — Apple's API cannot create
iCloud containers (portal-only), so preferences stay on-device until the
container is set up. The re-enable steps are written in
`Cadence/Resources/Cadence-iOS.entitlements`.

## What is in here

| Area | Files | Notes |
|---|---|---|
| Natural language | `NaturalLanguage/` | Quick-add parser. Fully unit tested. |
| Calendars | `Calendar/` | EventKit access, enumeration, read and write. |
| Tasks | `Todoist/` | v1 sync API, incremental `sync_token` merging. |
| Task placement | `Todoist/TaskProjection.swift` | Which tasks appear and where. Unit tested. |
| Layout | `Model/TimelineLayout.swift` | Overlap column-packing. Unit tested. |
| Sync | `Sync/` | `SyncStore` protocol + CloudKit and local stores. |
| Alerts | `Notifications/` | Local notifications for task blocks. |
| UI | `Views/`, `Design/` | Month, week, day, list, quick add, settings. |

### Natural language

Typing into quick add shows a live preview of what was understood *before* you
commit — without that, natural-language input is a guessing game, and one wrong
guess teaches people to stop trusting it.

```
Lunch with Sam tomorrow 1–2:30pm
Dentist next Tuesday 3-4:30 remind me 1 hour before
Standup every weekday at 9:15
Submit report friday 5pm #Work @laptop p1
Flight 10pm-1am
```

Handled: relative days, weekday names, explicit dates in several forms, times,
time ranges (including `11-1pm` → 11am–1pm, and ranges crossing midnight),
durations, recurrence, alert offsets, and Todoist `#project` / `@label` /
priority markers. Text it cannot interpret stays in the title rather than being
dropped.

Ambiguity is resolved the way people speak, not the way a strict parser would:
a bare `2-3` stays a quantity rather than becoming a time range, and `at 3`
becomes 3pm while `at 9` stays 9am.

### Alerts

Event alerts are attached to the event as an `EKAlarm` and delivered by the
system calendar daemon. That is deliberate: they then fire whether or not
Cadence is running, and fire *once* even though the same event is visible on
both your iPhone and your Mac. Scheduling our own notification alongside would
double every alert.

Todoist tasks have no system owner, so those get locally scheduled
notifications, capped under the 64-pending-notification limit iOS enforces.

### Tasks on the calendar

Tasks with a due **time** render as blocks at that time. Tasks due on a **date
with no time** are placed at a default hour — 9 AM out of the box, configurable
in Settings → Todoist.

Placing them means asserting a time the user never picked, so those blocks are
drawn with a dashed edge, a lighter fill, and a "No time" label instead of a
range. A dozen tasks defaulted to 9 AM should not read as a dozen real
commitments. Changing the time in the detail view writes a real due time back
to Todoist.

There is no all-day row: a task is either a block or, if it has no due date at
all, not on the calendar.

## Not done yet

- **Android.** The `SyncStore` protocol is the seam: swapping `CloudKitSyncStore`
  for a `RemoteSyncStore` is a one-call-site change in `PreferencesController`.
  Note that iCloud calendars can only be read on an Apple device, so an Android
  client would need one of your Apple devices relaying them through that backend
  — Google calendars and Todoist would work directly.
- **Drag to move an event.** `AppModel.move(_:to:)` and the EventKit and Todoist
  write paths behind it are implemented and ready; the gesture is not wired up.
- **Direct Google Calendar API.** EventKit covers events, edits, and alerts, but
  not Meet links, granular RSVP, or Google-side notification settings.
- **Widgets and Siri.**

## A note on the design

This follows the *interaction model* of Calendars by Readdle — month grid over a
live agenda, tinted event chips, natural-language quick add — which is largely
the shared iOS calendar idiom. All assets, colors, and code here are original;
nothing is copied from Readdle's app.
