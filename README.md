# Day Care Chemo Summary – Android

Same app as the Windows version (settings screen, consultant list, vitals with units, move-up/down chemo rows,
delete-cycle, Date of Discharge, Google Sheets sync, one-page PDF share). Rebuilt from the latest desktop source.

## Get the APK (no Android Studio needed)
1. Create a free GitHub account → New repository (private is fine), e.g. `daycare-chemo-android`.
2. Upload everything in this folder (keep the `.github` folder) → commit to `main`.
3. Open the repo → **Actions** tab → *Build Android APK* → wait ~5–8 min.
4. Open the finished run → **Artifacts** → download `day-care-chemo-summary-apk` → unzip → `app-debug.apk`.
5. Send the APK to the phone, tap it, allow "Install unknown apps" when asked.

## Or build locally
`npm install && npx cap sync android` then open `android/` in Android Studio → Build → Build APK(s).

## Notes
- Data is stored privately on the phone; Google Sheets sync uses the same service-account key + Sheet ID as the desktop app
  (Settings → Cloud Sync). The key sits on the phone – use a dedicated service account and keep the phone locked.
- "Print summary" creates a one-page PDF and opens the Android share sheet (Print / Save / WhatsApp).
- Auto-update is Windows-only; on Android install a newer APK over the old one (data is kept).
