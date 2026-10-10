# Day Care Chemo Summary – Android (v2.0, mobile interface)

Mobile-first redesign of the day-care discharge summary app. Same data as the Windows app:
same patient records, same Google Sheet columns (UHID, Date, Cycle…, Date of Discharge), same fields.

- Home: search patients by UHID/name, start a new visit, cloud status light (auto-connects on open)
- Patient page: all cycles, open / delete one cycle, "New cycle (copy last)", pull from cloud
- Editor: Patient · HOPI · Vitals (with units) · Pre-med · Chemo (reorder ↑↓) · Post-med · Tolerance · Discharge
- Print / Share: one-page PDF (letterhead, Times New Roman) or Word; the visit is saved first
- Settings: Google Sheet + key, logo, standard medicines, consultants, backup/CSV

Build: every push to `main` builds the APK on GitHub Actions and publishes it at
Releases → "Latest Android APK" (`apk-latest`). Install over the old APK; data is kept.
