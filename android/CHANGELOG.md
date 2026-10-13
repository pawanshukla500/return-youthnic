# Changelog - Youthnic Native Android Return Scanner

All notable changes to the native Android application are documented in this file following [Semantic Versioning](https://semver.org/).

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
