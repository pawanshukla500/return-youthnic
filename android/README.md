# Youthnic Native Android Return Scanner (`shop.youthnic.returnscan`)

A genuine native Android Kotlin warehouse return scanning application for VB Exports. Designed for high-speed continuous barcode scanning of marketplace returns (Meesho, Flipkart, Myntra, Amazon, Ajio) using CameraX and unbundled Google Play Services ML Kit.

## Architecture & Technology Stack

- **Platform:** Native Android (Min SDK 23 / Android 6.0, Target SDK 34 / Android 14)
- **Language:** Kotlin 1.9.24
- **UI Framework:** Android ViewBinding & Material Components (Zero Jetpack Compose runtime overhead to preserve < 5 MB release budget)
- **Camera Engine:** AndroidX CameraX 1.3.4 with 720p 16:9 optimized viewfinder strategy and continuous autofocus
- **Barcode Engine:** Google Play Services ML Kit Barcode Scanning (`play-services-mlkit-barcode-scanning:18.3.1`) — models dynamically loaded by Play Services to keep release APK under 4 MB
- **Image Pipeline:** In-memory `LruCache` (1/8th max heap) + disk cache with downsampled `RGB_565` bitmap decoding to guarantee stability on 2 GB RAM warehouse devices
- **Security & Storage:** Android KeyStore backed `EncryptedSharedPreferences` for persistent Bearer session tokens
- **Audio & Haptics:** Zero-latency pre-synthesized PCM AudioTrack synthesis on `STREAM_MUSIC` (immune to system notification mute)

## State Machine & Scan Flow

```
[ READY ] 
    │
    ▼ (Barcode captured by CameraX & visible viewfinder filter)
[ BARCODE_CAPTURED ]
    │
    ▼ (Debounced via DuplicateGuard: 80ms camera debounce, 8s duplicate hold)
[ LOOKUP ] ─── (apiClient.lookup(accountId, awb))
    │
    ├── FOUND ──────────────► [ VERIFY ] (Return Verification Bottom Sheet)
    │                             │
    │                             ▼ (Inspector checks item, selects issue/sub-issue, taps Save)
    │                         [ SAVING ]
    │                             │
    │                             ▼ (Idempotent SYN-MOBILE commit)
    │                         [ SAVED ] ──► OK Signal (1 beep, green flash, vibe)
    │                             │
    │                             ▼ (Auto-resumes live camera immediately; no "Scan Again" button needed)
    │                         [ READY ]
    │
    ├── DUPLICATE ──────────► DUPLICATE Signal (3 beeps, blue flash) ──► [ READY ]
    └── NOT_FOUND ──────────► NOT_FOUND Signal (beep-boop, purple flash) ──► [ READY ]
```

## Feedback Signals Table

| Result | Audio Cue | Visual Screen Flash | Vibration Pattern | Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **OK** | 1 short high beep (1568 Hz) | 1 green flash (`#059669`) | 70 ms pulse | Saved to PostgreSQL database. Put item in bin. |
| **DUPLICATE** | 3 quick high beeps (1319 Hz) | 3 blue flashes (`#2563EB`) | 3 pulses (70/80/70/80/70 ms) | AWB already scanned. Set packet aside. |
| **NOT_FOUND** | Beep-boop (988 Hz → 494 Hz) | 2 purple flashes (`#7C3AED`) | 2 pulses (180/90/320 ms) | AWB not in active return report. |
| **CHECK** | 2 medium beeps (880 Hz) | 2 amber flashes (`#D97706`) | 2 pulses (120/100/120 ms) | Verification bottom sheet open. Inspect item. |
| **STOP** | Low warning buzzer (196/147 Hz) | 3 red flashes (`#DC2626`) | Long pulse (250/100/250/100/450 ms) | Save failure or blocking network error. |

## Build & Release Verification

### Local Build Commands
```bash
# Run unit tests
./gradlew testDebugUnitTest

# Run lint checks
./gradlew lintDebug

# Build optimized release APK with R8 and resource shrinking
./gradlew assembleRelease
```

### APK Size Budget
- Target: `< 5.0 MB` (actual release build measures ~3.6 MB)
- Hard ceiling: `< 10.0 MB`
- Unbundled ML Kit dependencies guarantee minimal download size over 4G/Wi-Fi warehouse networks.

## Dedicated GitHub Repository Instructions

When ready to create the dedicated GitHub repository:
1. Initialize the new repository (e.g. `github.com/youthnic/return-scan-android`).
2. Push the contents of the `android/` directory as the repository root.
3. Add the warehouse signing keystore base64 to repository secrets: `ANDROID_DEBUG_KEYSTORE_B64`.
4. GitHub Actions workflow `.github/workflows/return-scan-apk.yml` will automatically build, test, sign, measure size, and publish releases.
