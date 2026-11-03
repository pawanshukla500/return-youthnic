# Portal pathways M9 — Meesho + Myntra (from `claim_portal_final` reference)

Source: `C:/Users/Pawan Shukla/Desktop/claim_portal_final` — a Flask + Selenium
reference portal. Everything below is **observed in those scripts, NOT
live-verified** against the current supplier sites. Selectors and URLs must be
re-confirmed in a read-only operator session before any engine change.
Flipkart / Amazon / Ajio pathways are deferred to the in-depth session.

## Meesho — filing flow (`meesho_auto_filer.py`)

1. Queue source: open claims with no ticket ID yet (reference reads a Google
   Sheet; our system of record is Postgres — sheet columns map to claim fields,
   never the reverse).
2. Login page: `https://supplier.meesho.com/panel/v3/new/root/login`
3. Claim form, chosen by claim kind:
   - Normal: `.../panel/v3/new/experience/yqcue/support/1/1/create`
   - RTO: `.../panel/v3/new/experience/yqcue/support/1/139/create`
4. Form fields, in order:
   - Text inputs located by placeholder (order/AWB identifiers)
   - State dropdown select
   - Description textarea (reference generates it with Gemini AI from
     issue + order data, with a template fallback per issue family:
     wrong/misship, missing, damage/tamper, empty, SKU mismatch)
   - Callback number field
   - File uploads located by label; required-upload set differs for RTO
     vs normal — verify per form before submit
5. Pre-submit guards (reference blocks filing when the page says):
   - return order must be delivered / collect the return delivery first
   - ticket already exists / duplicate ticket
6. Submit, then extract the ticket ID from the success page:
   - Ticket IDs observed as 12 digits (e.g. `777535617152`)
   - DOM containers mentioning "ticket" first, regex fallback on
     `Ticket ID/No./Number/#/:` followed by 6–15 digits
   - Standalone 12-digit numbers that are NOT order IDs are the ticket
7. Evidence: per-tracking-ID folder; video converted with ffmpeg before upload.

Engine cross-check (`desktop-agent/src/marketplaces/meesho.ts`): diff the form
URLs and the field order above against the engine during the operator live
session. Eligibility-guard strings belong in the engine's pre-submit check.
Ticket-extraction (12-digit rule) belongs in the submit-result parser, and
feeds `claim_automation_follow_ups` — but per AGENTS.md,
`checkClaimStatus()` is still unimplemented, so follow-ups stay read-only
until then.

## Myntra — tracking flow (`myntra_tracker.py`)

1. Portal: `https://partners.myntrainfo.com/`
2. Ticket deep link: `https://partners.myntrainfo.com/SPF?ticketId={ticket_id}`
3. Login with a manual-completion wait (operator finishes OTP/CAPTCHA in the
   window; cookies persist for later runs).
4. Per ticket: open the deep link, read status text, normalize with
   AI assistance, record status + rejection reason + approved amount.
5. This is the read path that `checkClaimStatus()` for a Myntra marketplace
   class would wrap when tracking is turned on.

## Reference dashboard UI pattern (Flask templates)

`base.html` + `_sidebar.html` + `marketplace.html`: shell with sidebar nav,
topbar, stat cards, claims table. This is the layout model for the desktop
dashboard sidebar rework (light mode, tab-segregated sections) — structure
only, no code copied.

## Deferred (in-depth session with operator)

- Flipkart / Amazon / Ajio click-paths (`flipkart_tracker.py` and portal
  templates not yet mined).
- Live re-verification of every URL/selector above (sites change).
- `checkClaimStatus()` implementation per marketplace (tracking stays
  "not implemented" until then).
