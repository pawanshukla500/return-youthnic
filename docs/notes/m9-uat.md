# M9 UAT — light dashboard UI + update system (installed build 1.2.0, rebuilt 2026-11-03)

Build: `dist-electron/Return.App.Setup.1.2.0.exe` (120,274,417 bytes, unsigned),
installed over 1.2.0. Answered by operator, one test at a time.

- [x] T1 — App opens, light theme default, sidebar visible (Status/Setup/Claims/Follow-ups/AI Center/Updates)
- [x] T2 — Sidebar tabs switch sections (screenshots show Status/Setup/Claims/Follow-ups/AI Center/Updates each rendering)
- [ ] T3 — Theme toggle switches to dark and back; persists after restart (toggle visible in header, not yet exercised)
- [x] T4 — Updates tab shows current version + Check now result ('Up to date (this app: 1.2.0)', last checked timestamp shown)
- [~] T5 — Sign-in works (Pawan Shukla, bot running); queue syncs (1 Meesho prepared claim VLR083002308587); Poll Now/Pause visible. Pause/Resume toggle not yet demonstrated.

## Results (2026-11-03, operator screenshots of installed 1.2.0 rebuild)

- T1 PASS: light theme default, sidebar with all six tabs; header shows operator name, bot-running pill, Dark toggle, Sign out.
- T2 PASS: Status shows 'Action required' + Meesho-Ready chip + KPIs (1 tracked / 1 action required); Setup shows Meesho connected-cookies-saved + 5 Connect panels; Claims shows panel strip (Meesho auto, rest assisted) + 1 prepared Meesho row + live activity log; Follow-ups empty as expected; AI Center lists 6 providers, 0 keys; Updates tab as T4.
- T4 PASS: Updates tab reads 'This app: 1.2.0', auto-check on, 'Up to date', last-checked timestamp.
- Backend: production /api/health returns ok:true, database connected, name return-scan_youthnic — matches app backend URL.
- Open: T3 theme toggle round-trip; T5 Pause/Resume toggle; live Meesho/mobile/Firebase/follow-up sessions.
