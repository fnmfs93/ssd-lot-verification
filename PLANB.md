# Plan B: QR Lot Verification System (Node.js + Turso + Vercel)

**Difference from PLAN.md**: PLAN.md requires real login authentication for Production and QA users. Plan B replaces that with a **PIC (person-in-charge) selection or badge scan** — no login, no sessions, no passwords. The operator identifies themselves by picking their name from a list or scanning a PIC badge QR at the start of a scan flow. Everything else (data model shape, matching rules, match/unmatch-only outcome, no email/blocking) is the same as PLAN.md.

**Purpose**: Production scans 1 large lot QR code plus 3-or-more smaller part QR codes. QA later re-scans the same lot QR code and the same part QR codes. The system compares each scanned part against the saved part records for that lot, shows either **MATCH** or **UNMATCH**, and saves a traceable QA verification record tied to the PIC who performed the scan. This is a verification system, not an automatic blocking or email-alert workflow.

**Stack**: Node.js web app + Turso (LibSQL) + GitHub + Vercel. No auth provider needed.

## 1. Project setup

- Create a Node.js app repo in GitHub.
- Use a full-stack web setup that supports server routes and browser camera access.
- Configure environment variables for:
  - `TURSO_DATABASE_URL`
  - `TURSO_AUTH_TOKEN`
  - app base URL
- Deploy the app to Vercel over HTTPS so camera APIs work reliably on phones, tablets, and desktop browsers.

## 2. Data model - Turso

Same shape as PLAN.md, plus a `pics` table to back the selection/scan step.

- `pics`
  - `id`
  - `code` (short ID, printed on a badge as a QR/barcode, or typed manually)
  - `name`
  - `active` (boolean — only active PICs are selectable)

- `lots`
  - `id`
  - `lot_id` (unique, from lot QR)
  - `prod_pic_id` (FK to `pics`)
  - `prod_pic_name` (denormalized snapshot at time of scan, so history reads correctly even if a PIC is later renamed/deactivated)
  - `prod_station`
  - `prod_timestamp`
  - `latest_qa_result` (`matched`, `unmatched`, nullable if not yet checked)
  - `latest_qa_timestamp`
  - `created_at`
  - `updated_at`

- `lot_items`
  - `id`
  - `lot_id` (FK)
  - `slot` (1..n)
  - `prod_value`

- `qa_verifications`
  - `id`
  - `lot_id` (FK)
  - `qa_pic_id` (FK to `pics`)
  - `qa_pic_name` (denormalized snapshot)
  - `qa_station`
  - `result` (`matched`, `unmatched`)
  - `verified_at`
  - `remarks` (optional later)

- `qa_verification_items`
  - `id`
  - `verification_id` (FK)
  - `slot`
  - `scanned_value`
  - `match_result` (`matched`, `unmatched`)

Supporting tables:

- `audit_log` (recommended)
  - append-only trail for production scan, QA verification, and any future admin actions
- `app_config` (optional later)
  - key/value config if business rules later vary by product or line

Migration tooling: Drizzle, same as PLAN.md.

## 3. PIC identification (no login)

Replaces PLAN.md §3 (authentication).

- No login, no password, no session/JWT.
- Before scanning, the operator either:
  - selects their name from a short list of active PICs (dropdown or tappable list), or
  - scans a PIC badge — a QR/barcode printed on an ID badge that encodes their `code` — using the same camera/scanner input already used for lot and part QRs
- The server resolves the submitted `code` (or selected `id`) against the `pics` table and rejects the request if it isn't a known, active PIC. The client never sends a free-text name directly into `prod_pic_name`/`qa_pic_name` — those are always looked up server-side from the `pics` table, then snapshotted onto the record.
- Selecting/scanning a PIC happens once per scan session (e.g. once per shift or once per lot), not once per field, to keep the flow fast.

Trade-off to flag explicitly: this is weaker accountability than real login. Anyone standing at the station can select or scan someone else's PIC badge — there's no password or possession-plus-knowledge check. It's fast and matches how many factory floors already do operator ID badge scans, but if the business needs cryptographic proof of identity (e.g. for compliance audits), PLAN.md's real login is the safer choice. Optional middle ground: add a short PIN per PIC (checked server-side, not a full auth system) if some friction against impersonation is wanted without building full login.

Managing the `pics` list:
- Simplest: seed/manage `pics` rows directly (admin CLI script or a minimal admin page) since there's no user self-registration.
- Print each active PIC's `code` as a badge QR once the table is seeded.

## 4. Backend API

Main routes:

- `POST /api/production-scan`
  - input: `lotId`, `parts[]` (3 or more), `picCode` (from selection or badge scan), optional station info
  - resolve `picCode` -> active `pics` row; reject if unknown or inactive
  - reject if `lotId` already exists unless a future rework flow explicitly allows replacement
  - create `lots` row with `prod_pic_id`/`prod_pic_name` snapshotted from the resolved PIC
  - create one `lot_items` row per part
  - write audit event

- `POST /api/qa-lookup`
  - input: `lotId`
  - returns only enough info to confirm the lot exists and the expected part count
  - must not return stored production values to the client
  - does not require a PIC yet — PIC is resolved at verify time

- `POST /api/qa-verify`
  - input: `lotId`, `parts[]`, `picCode`, optional station info
  - resolve `picCode` -> active `pics` row; reject if unknown or inactive
  - fetch lot and `lot_items` by `lotId`; fail if not found
  - compare submitted parts against stored production values for that lot
  - create one `qa_verifications` record for the attempt, with `qa_pic_id`/`qa_pic_name` snapshotted
  - create one `qa_verification_items` record per scanned part
  - set verification result to `matched` if all scanned parts match, otherwise `unmatched`
  - update the lot's `latest_qa_result` and `latest_qa_timestamp`
  - write audit event
  - return the match or unmatch result, plus failed slots if useful for display

- `GET /api/pics`
  - returns the active PIC list for the selection UI (id/code/name only)

Possible future routes:

- `GET /api/qa-history/:lotId`
- `POST /api/admin/reopen-lot`
- `POST /api/admin/pics` — manage the PIC list, if a UI for this is wanted later instead of seeding directly

Implementation notes:

- Validate part count, empty values, duplicates, and allowed payload shape server-side.
- Validate `picCode` against the `pics` table server-side on every submission — never trust a client-supplied name or id directly.
- Use a database transaction for QA verification so result summary and detail rows stay consistent.
- Prevent accidental duplicate submissions from scanner retries, flaky connections, or repeated taps (same conditional-update idea as PLAN.md).
- Keep QA blind by never exposing stored production values in QA responses.

## 5. Matching rules

Same as PLAN.md — QA scans a lot QR first, the system loads the saved part records for that lot, and each scanned part is checked against the saved parts for that lot. Matching rule (order-sensitive vs. set-match) and unit-testing the comparator directly are unchanged; identity method doesn't affect this section.

## 6. Frontend

Pages:

- `/production`
- `/qa`

Shared behavior:

- first step on either page: select or scan PIC, before any lot/part scanning starts
- one input per scan step
- auto-focus next field after successful scan
- support HID USB or Bluetooth scanners that type text plus Enter
- provide manual entry fallback (including manual PIC selection if badge scanning fails)
- show large, clear status messages for production-floor use

Scan types:

- `PIC badge` — optional, only if badges are printed; otherwise a simple tap-to-select list
- `Lot QR` — larger code, usually easier to scan from a short distance
- `Part QR` — smaller codes, usually require closer framing, better focus, and better lighting

Camera scanning:

- use `navigator.mediaDevices.getUserMedia()` in the browser
- use a browser QR library such as `html5-qrcode`
- open camera in an overlay or dedicated scan panel
- decode into the same input fields used by scanner-gun entry
- stop camera stream cleanly after each successful scan or when the user closes the scanner
- for small part QRs, use a tighter scan box and guidance text such as "Move closer to scan part QR"

Practical scanning note:

- 1 large lot QR is usually easy for camera scanning
- smaller part QRs may be the real usability risk
- test with the real printed labels, real working distance, and real devices early
- keep scanner-gun input as a strong fallback if small QRs are difficult on camera

QA UX:

- flow: select/scan PIC, scan lot QR, then scan each part QR
- do not reveal stored production values
- display:
  - lot found / not found
  - MATCH
  - UNMATCH
- after result is shown, save the verification automatically to history

## 7. Traceability and history

Same intent as PLAN.md, with the caveat from §3: the trail is tied to whichever PIC was selected/scanned, which is a claim rather than a cryptographically verified identity.

- Every QA verification attempt creates a saved record.
- Each record stores the resolved PIC id and name (snapshotted at submission time), lot ID, scanned part values, match result, verification timestamp, and optional station information.
- Keep every verification attempt instead of overwriting the previous one; use the latest result for quick reporting, full history for traceability.

## 8. Security and access control

- No login, so identity is a selection/scan claim, not a verified credential — see §3 trade-off.
- To compensate, treat network-level access control as more important than in PLAN.md: keep the app on an internal network / VPN, or otherwise restrict who can reach the API at all, since there's no per-user auth layer doing that job.
- Validate all request payloads server-side, including `picCode` against the active `pics` table.
- Never trust client-reported identity or status.
- Rate-limit sensitive endpoints.
- Keep secrets only in environment variables, never in frontend code.
- If admin routes (`/api/admin/*`) are added later, protect those with at least a shared admin secret or basic auth, even if the operator-facing routes stay login-free.

## 9. Deployment

Same as PLAN.md, minus authentication provider setup:

- Push code through GitHub as usual.
- Connect the GitHub repo to Vercel.
- Provision Turso database and run schema migrations, including seeding the initial `pics` list.
- Set Vercel environment variables for database and app configuration.
- Use Vercel preview deployments for testing before promoting to production.
- Test on:
  - desktop with scanner gun
  - Android phone camera
  - iPhone camera
  - tablet if used on the floor

Vercel notes:

- frontend pages and API routes can live in the same app
- camera access works because the deployed app is served over HTTPS
- database writes should stay in server routes only

## 10. End-to-end test cases

- Production: select/scan a valid PIC, scan a brand-new lot -> saved with correct part count and correct PIC snapshot
- Production: submit with an unknown or inactive `picCode` -> rejected
- QA: valid PIC, scan matching parts -> UI shows MATCH and verification history is saved with correct PIC snapshot
- QA: valid PIC, scan wrong part(s) -> UI shows UNMATCH and verification history is saved
- QA: unknown or inactive `picCode` -> rejected
- QA scans unknown lot -> rejected
- QA scans the same lot again later -> allowed if repeat verification remains enabled, new history record created
- duplicate production submission for same lot -> rejected unless a future reset flow exists
- poor camera conditions -> manual entry fallback works for PIC selection, lot, and part fields alike
- lot with more than 3 parts -> production and QA both handle the variable count correctly

## 11. Open items to confirm before build

- PIC identification method: badge QR scan, tap-to-select list, or both?
- Is a short PIN per PIC worth the extra friction, or is selection/scan alone acceptable given the factory-floor trust model?
- Who manages the `pics` list (add/deactivate people) — a person with direct DB/script access, or a minimal admin UI?
- Will stations mainly use scanner guns, cameras, or both?
- Are the small part QRs reliably scannable on the actual floor devices?
- Is offline handling needed, or can the app require live internet access at all times?
- Is network-level restriction (VPN/internal-only) actually in place, given there's no per-user auth to fall back on?

## 12. Recommended build sequence

1. Create schema and migrations in Turso, including `pics`.
2. Seed the initial PIC list.
3. Build PIC selection/scan UI component (reused on both `/production` and `/qa`).
4. Build production scan API and UI for variable part counts.
5. Build QA lookup and verification flow.
6. Save QA verification history with resolved PIC identity.
7. Test with real scanner devices and real sample labels.
8. Deploy production environment and run a floor pilot.
