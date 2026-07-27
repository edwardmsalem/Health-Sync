fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios register

```sh
[bundle exec] fastlane ios register
```

One-time: register the bundle ID (with iCloud) and the App Store Connect app record

### ios build

```sh
[bundle exec] fastlane ios build
```

Build a signed IPA

### ios release

```sh
[bundle exec] fastlane ios release
```

Upload the built IPA to TestFlight

### ios ship

```sh
[bundle exec] fastlane ios ship
```

Build and upload in one go

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
