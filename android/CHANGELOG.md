# Changelog - Youthnic Native Android Return Scanner

All notable changes to the native Android application are documented in this file following [Semantic Versioning](https://semver.org/).

## [Unreleased] - 2026-10-13

The version number is the CI run number (`1.0.<run>`, version code `10000 + run`); it is fixed when the push to `main` publishes the release.

### Fixed
- **Crash after tapping a marketplace.** The scanner screen formatted its "scanned today" count with a `%d` string but passed the formatted text from `Ui.count` ("1,234"), which throws `IllegalFormatConversionException` as soon as the screen opens. The marketplace badge had the same mistake. Both strings now take `%s`, and `StringFormatsTest` fails if any `getString(..., Ui.count(...))` meets a numeric placeholder.
- **Lookups never matched and saves never succeeded.** The app read a different JSON shape than `/api/scan/*` returns. Lookup now reads `{status, shipment{...}}` and handles `duplicate`, `choose` and `not_found`; a save sends the server's category codes (`no_issue`, `missing_component`, ...) with the same quantity rules as the web scan screen; a clear line sends no issue; the shift count reads the formatted `scanned` text; the receipt reads `{replayed, scan{...}}`.
- Lookups are limited to the marketplace the scanner selected (they used to search every account).
- The scan key is cleaned to the server rule `[A-Za-z0-9_-]{8,100}`; an 80-character AWB used to overflow it.
- Swiping the verification sheet away left the scanner blocked until restart. All ways of closing the sheet are now counted in one place.
- Manual AWB entry counted its dialog out twice, so the counter went below zero.
- The camera was started twice on every open; it now starts once.
- The last-scan banner status text had the same colour as its bar and could not be read.
- The torch label did not follow its state; the torch is restored after a camera rebind and reports when the device has none.
- The back and settings buttons on the scanner did nothing. The "remember this terminal" box was ignored. The quantity stepper showed a cross and a refresh arrow instead of - and +.
- The marketplace list no longer shows a made-up "0 scannable" (the server sends no count) or the account name twice.

### Added
- **Camera permission at sign-in.** After a successful sign-in the app explains why the camera is needed and asks for it. People who stay signed in across an update get the same prompt once on the marketplace screen. A refusal no longer closes the scanner: it shows *Allow camera*, or *Open Settings* when Android has blocked the dialog, and Manual AWB keeps working.
- A picker when one AWB matches several returns, instead of a silent guess.
- A ticket ID field, shown only when an administrator makes an issue category require one.
- Online/offline indicator that follows the last request; the idle overlay can be tapped anywhere to wake the camera.
- Colour and key detail (size) under the SKU in the verification sheet; the matched leg (return or forward) as the server reports it.

## [1.0.1] - 2026-10-12

### Added
- **Native Android Architecture:** Pure Kotlin implementation targeting Android 6.0+ (API 23+) through Android 14 (API 34).
- **Forward Scan Ergonomics & Visuals:** Emerald and dark forest theme (`#0E5847`, `#063B2F`, `#10B981`), camera reticle with green rectangular guide, and status pill badges.
- **Continuous CameraX Barcode Engine:** 720p 16:9 battery-optimized preview, continuous autofocus, and unbundled Google Play Services ML Kit 1-D barcode decoding (`play-services-mlkit-barcode-scanning:18.3.1`).
- **Duplicate & Jitter Filter:** `DuplicateGuard` with 80 ms camera frame debounce and 8-second duplicate suppression hold.
- **Return Verification Bottom Sheet:**
  - Marketplace, carrier, return type, order ID, and shipment ID metadata.
  - Multi-item parcel support with individual quantity counters.
  - Product thumbnail loading via bounded memory `LruCache` and disk cache.
  - Interactive full-screen pinch-to-zoom and pan image viewer (`ImageViewerActivity`).
  - Mandatory physical condition inspection checkbox.
  - Return issue chips: Clear Return, Missing Component, Wrong Product, Damaged Product, SKU Change, Size Change, Other.
  - Dynamic missing component sub-issue options (Dupatta, Bottom, Top, Inner, Accessories).
- **Synchronized Audio, Vibration, and Flash Signals:**
  - OK: 1 high beep, 1 green flash, 1 short vibration (triggered only upon PostgreSQL commit).
  - DUPLICATE: 3 high beeps, 3 blue flashes, 3 vibrations.
  - NOT FOUND: Beep-boop prompt tone, 2 purple flashes, 2 vibrations.
  - CHECK: 2 medium beeps, 2 amber flashes, 2 vibrations.
  - STOP: Low error buzzer, 3 red flashes, long warning vibration.
- **Auto-Resume Scanner:** Continuous hands-free warehouse operation — live camera resumes automatically 500 ms after successful database save without requiring a "Scan Again" button tap.
- **Recent Scans & Manual Entry:** Quick bottom sheet of last 50 scans and manual tracking ID entry dialog.
- **Session & Security:** Android KeyStore backed `EncryptedSharedPreferences` for secure Bearer tokens and persistent terminal authentication.
- **In-App Update Engine:** Background polling via WorkManager against `GET /api/app/latest`, SHA-256 verification, and FileProvider APK installation.
- **Lightweight APK Footprint:** Total release APK size under 4 MB achieved through unbundled ML Kit, ViewBinding, and aggressive R8 shrinking.
