# Meesho Portal Workflow Map — v1 (code-derived, NOT live-verified)

Status: derived from the automation code and the supplier-panel structure the code was written
against. No live supplier-panel session has confirmed these pages since M7. Every entry below
needs operator-gated read-only discovery (§3) before it becomes a trusted procedure. Nothing here
is approved memory.

## 1. Navigation (from code)

- Login: `https://supplier.meesho.com/panel/v3/new/root/login` (email/phone + password; OTP/CAPTCHA manual).
- Post-login panel URL contains `/growth/<slug>/` or `/experience/<slug>/`; `<slug>` is the seller context.
- Support: `https://supplier.meesho.com/panel/v3/new/experience/<slug>/support`.
- Issue page open state: URL contains `/support/1/` OR a visible "Raise a Ticket" control.
- Raise-a-ticket form open state: `input[placeholder="Sub Order Number"]` present.
- Ticket table ("Recently raised tickets"): `tr td` cells matching `^\d{9,15}$`.
- My Tickets: no deep URL recorded — the reader clicks a visible "My Tickets" link from Support and
  re-scans the ticket table. If the portal renames it, the reader reports not-found (never guesses).

## 2. Issue categories (portal labels, authority: `server/meesho-claims.ts` MEESHO_ISSUES)

| Claim issue code | Portal category label |
|---|---|
| `wrong_return` | I have received wrong return |
| `missing_items` | Item/s are missing in my return |
| `wrong_barcode_rto` | I have received a wrong barcoded package in RTO |
| `damaged_return` | I have received damaged return |
| `used_product` | I have received used product as return |

Unmapped codes stop for human review — the bot never substitutes another category.

## 3. Claim form fields (from code)

- Sub Order Number (required, human-typed; Check/Verify/Search clicked after).
- AWB Number (optional, only when the claim carries a tracking ID).
- Packet ID (optional; flyer/barcode placeholder or name match).
- State of the packet: listbox, label match `/state of the packet/i`, options Intact/Tampered.
  Unknown or missing condition stops the job for operator review (never auto-filed).
- Evidence `input[type=file]` boxes mapped by id substring: video → unboxing video,
  waybill/reverse → reverse waybill, product → product images, barcode → barcode image,
  else first unattached image. No unrelated image is ever attached to satisfy a box.
- Description: last `textarea` on the form.

## 4. Validation and refusal signals (from code)

- "Not eligible" (case-insensitive, error-styled, short) after Check → `not_eligible`, never claimed.
- Submit disabled after 20 s → scrape empty inputs + error text; not-eligible wording → `not_eligible`,
  else `manual_intervention_required` with the portal text.
- Portal error words after Submit with the form still open → `manual_intervention_required`.
- Ticket counts only when a NEW 9–15 digit ID appears that was absent before Submit.

## 5. Follow-up reads (from code)

- `checkClaimStatus(ticketId)` re-opens Support, finds the table row containing the ticket ID,
  and returns the row's other cells as raw status text plus a screenshot. High-confidence hints only:
  paid/settled/credited → `paid`, reject/denied/declined/cancelled → `rejected`,
  approv/accept/resolv/completed → `approved`. Everything else is normalized server-side.
- Schedule unchanged: 1:00–2:00 AM Asia/Kolkata window, first check ≥ 48 h after verified submission.
- Compensation: approval alone is not settlement; reconcile against payments data when available.

## 6. Claim windows

- TAT 7 calendar days inclusive; filing due date = received date + 6 days. Never extended by automation.
- Evidence gate: desktop leases only claims in `ready_for_claim` (server-enforced).

## 7. To verify live (operator-gated)

Confirm Support/My Tickets URLs, the five category labels, State-of-packet options, upload field
restrictions, validation messages, ticket status labels, reopen/reply flows, payments/claims
compensation pages, and evidence requirements. Record deltas as map v2; promote only via the
pending → approved memory workflow.
