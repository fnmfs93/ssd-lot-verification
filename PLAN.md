# Plan: Label-to-Part QR Verification System (Node.js + Turso + Vercel)

**Purpose**: QA verifies whether one or more part QR codes belong to an A4 label. QA first captures or uploads the label image, the system extracts all `2D Code` values from that label, and QA then scans part QR codes one by one. Each scanned part is compared against the extracted label code list and shown as **MATCH** or **UNMATCH**. Every verification is saved with traceable QA user history.

**Stack**: Node.js web app + Turso (LibSQL) + GitHub + Vercel. The app is web-based so QA can use camera capture, QR scanning, and authenticated traceability from phones, tablets, or desktop stations.

## 1. Project setup

- Create a Node.js app repo in GitHub.
- Use a full-stack web setup that supports:
  - server routes
  - browser camera access
  - file upload
  - authentication
- Configure environment variables for:
  - `TURSO_DATABASE_URL`
  - `TURSO_AUTH_TOKEN`
  - authentication secrets and provider settings
  - app base URL
- Deploy the app to Vercel over HTTPS so camera APIs work reliably on phones, tablets, and desktop browsers.

## 2. Core business flow

The process is QA-only. Production does not need to scan or register anything in this version.

Flow:

1. QA signs in.
2. QA takes a photo of the A4 label or uploads an image/PDF of the label.
3. The system extracts all `2D Code` values from the label.
4. QA reviews the extracted code list on screen.
5. QA scans one part QR code.
6. The system compares the scanned QR value against the extracted label code list.
7. The screen shows `MATCH` if the value exists in the label list, otherwise `UNMATCH`.
8. QA can continue scanning more part QR codes against the same label without re-uploading the label.
9. Each scanned part result is saved as a traceable verification record tied to the authenticated QA user.

## 3. Data model - Turso

The number of valid part codes is not fixed. It depends entirely on the label content.

- `label_sessions`
  - `id`
  - `session_key` (unique ID for the active verification session)
  - `qa_user_id`
  - `qa_user_name`
  - `qa_station`
  - `source_type` (`camera`, `upload`)
  - `label_image_url` or stored file reference
  - `ocr_status` (`pending`, `processed`, `failed`)
  - `created_at`
  - `updated_at`

- `label_codes`
  - `id`
  - `label_session_id` (FK)
  - `code_value`
  - `row_index` (optional, useful if preserving table row order)

- `part_verifications`
  - `id`
  - `label_session_id` (FK)
  - `qa_user_id`
  - `qa_user_name`
  - `scanned_qr_value`
  - `result` (`matched`, `unmatched`)
  - `matched_label_code` (nullable, stores exact matched code if found)
  - `verified_at`

- `audit_log` (recommended)
  - append-only event trail for label upload, OCR completion, part verification, OCR failure, and reprocessing actions

Supporting note:

- A single `label_session` represents one uploaded/captured A4 label and its extracted code list.
- Many `part_verifications` can be created against the same `label_session`.

Migration tooling:

- Pick a concrete migration approach up front instead of ad-hoc SQL.
- Drizzle is a good fit because it works well with Turso/LibSQL and gives type-safe schema access.

## 4. Authentication and user identity

Real authentication is required.

- QA users must sign in.
- The system records the authenticated QA user automatically for every label session and every part verification.
- This gives reliable traceability of who performed each verification and when.

Recommended direction:

- Use simple internal authentication suitable for factory use.
- Keep the post-login flow fast so verification remains the main interaction.
- Store both stable user ID and display name in verification records.

## 5. OCR and extraction logic

The main challenge in this system is not QR comparison. It is extracting the `2D Code` values reliably from the A4 label image.

Expected label behavior:

- Label format is consistent or mostly consistent.
- The system only needs the `2D Code` column from the table.
- The part QR value is expected to match a `2D Code` value exactly.

Recommended extraction flow:

1. Capture or upload the label image.
2. Preprocess the image if needed:
  - crop margins
  - improve contrast
  - deskew slight tilt
3. Run OCR on the label.
4. Extract only the `2D Code` values from the relevant table area.
5. Normalize values:
  - trim whitespace
  - uppercase if needed
6. Save the extracted code list to `label_codes`.
7. Show the extracted codes to QA for visibility.

Important note:

- OCR accuracy will depend on photo quality, glare, blur, angle, and print clarity.
- Because the label is A4 and structured, this is feasible, but real sample testing is essential.

## 6. Backend API

Main routes:

- `POST /api/label-session`
  - input: label image upload or captured image, optional station info
  - authenticated QA user is taken from the session
  - create `label_sessions` row
  - store uploaded image reference
  - run OCR and extract `2D Code` values
  - create `label_codes` rows
  - return extracted code list and session key

- `GET /api/label-session/:sessionKey`
  - returns current extracted code list and OCR status for the active session

- `POST /api/part-verify`
  - input: `sessionKey`, `scannedQrValue`
  - authenticated QA user is taken from the session
  - load extracted `label_codes` for the session
  - compare the scanned QR value against the extracted code list
  - create one `part_verifications` record
  - return `MATCH` or `UNMATCH`

- `GET /api/verification-history/:sessionKey`
  - returns prior scanned parts and results for the current label session

Possible future routes:

- `POST /api/label-session/:sessionKey/reprocess`
  - re-run OCR if the extracted code list is wrong or incomplete

Implementation notes:

- Validate file type, file size, and image presence server-side.
- Validate QR input server-side.
- Prevent duplicate double-submit if the same scan fires twice quickly.
- Keep comparison logic exact: the scanned part QR value must exactly equal one extracted `2D Code` value.

## 7. Matching rules

The matching rule is exact string comparison.

- Extract all `2D Code` values from the label.
- Scan a part QR code.
- Compare the scanned QR value directly against the extracted label code list.
- If the exact value exists in the list, result is `MATCH`.
- If it does not exist, result is `UNMATCH`.

Important clarification:

- There is no fixed number of parts.
- The label defines the valid code list.
- QA can scan multiple part QRs against the same label session.

## 8. Frontend

Pages:

- `/qa`

Shared behavior:

- authenticated QA user lands on the verification page after sign-in
- clear step-by-step flow
- large buttons for:
  - capture label
  - upload label
  - scan part QR
- show extracted label codes in a readable list or table
- show prior scanned part results for the current label session

Step-by-step QA UX:

1. Sign in.
2. Capture a photo of the A4 label or upload the label image/PDF.
3. Wait for OCR extraction.
4. Review extracted `2D Code` list.
5. Scan the first part QR.
6. See `MATCH` or `UNMATCH`.
7. Continue scanning more part QRs against the same label.
8. Start a new label session when changing to a different label.

Camera and scanning:

- use `navigator.mediaDevices.getUserMedia()` for label capture and QR scanning
- use a browser QR library such as `html5-qrcode` for part scanning
- allow file upload as a fallback if live camera capture is difficult
- stop camera streams cleanly after capture/scan

Practical note:

- Part QR scanning should be reliable if the QR print is clear.
- Label OCR is the more fragile part and must be tested with real labels and real lighting.

## 9. Traceability and history

QA verification must be traceable.

- Every label upload/capture is tied to the authenticated QA user.
- Every part verification is tied to the authenticated QA user.
- Every scanned part result is saved individually.

Each verification record should store:

- label session reference
- scanned QR value
- result (`matched` or `unmatched`)
- matched label code if found
- verification timestamp
- QA user identity

Recommended behavior:

- Keep full scan history for every label session.
- Allow repeated scans of different parts against the same label.
- Optionally flag duplicate scans of the same matched code if that matters operationally later.

## 10. Security and access control

- Require authentication for QA users.
- Validate all request payloads server-side.
- Never trust client-reported identity or OCR result.
- Rate-limit sensitive endpoints.
- Assume the app is internet-reachable on Vercel unless it is intentionally placed behind a VPN or access control layer.
- Keep secrets only in environment variables, never in frontend code.

## 11. Deployment

- Push code through GitHub as usual.
- Connect the GitHub repo to Vercel.
- Provision Turso database and run schema migrations.
- Set Vercel environment variables for database, authentication, and app configuration.
- Use Vercel preview deployments for testing before promoting to production.
- Test on:
  - phone camera for label capture
  - desktop or mobile QR scanning
  - actual production-floor lighting conditions
  - real A4 label samples

Vercel notes:

- frontend pages and API routes can live in the same app
- camera access works because the deployed app is served over HTTPS
- OCR and database writes should stay in server routes only

## 12. End-to-end test cases

- QA uploads a clean label image -> OCR extracts the correct `2D Code` list
- QA captures a label photo from camera -> OCR extracts the correct `2D Code` list
- QA scans a part QR that exists in the extracted label list -> UI shows MATCH and history is saved
- QA scans a part QR that does not exist in the extracted label list -> UI shows UNMATCH and history is saved
- QA scans multiple part QRs against the same label -> each result is saved separately
- OCR fails or extracts incomplete codes -> system shows failure or allows reprocess/new photo
- duplicate rapid scan -> system avoids accidental duplicate records if needed
- poor lighting/glare -> verify acceptable OCR performance on target devices

## 13. Open items to confirm before build

- Will QA mostly capture the label live with camera, or upload an existing image/PDF?
- Should the original label image be stored for audit/reference?
- Should duplicate scans of the same part under one label be allowed, warned, or blocked?
- Are all labels formatted consistently enough for reliable `2D Code` extraction?
- Is offline handling needed, or can the app require live internet access at all times?

## 14. Recommended build sequence

1. Create schema and migrations in Turso.
2. Add authentication.
3. Build label upload/camera capture flow.
4. Build OCR extraction and `2D Code` parsing.
5. Build part QR scan and exact match verification flow.
6. Save verification history with authenticated QA user identity.
7. Test with real label samples and real floor devices.
8. Deploy production environment and run a floor pilot.
