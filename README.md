# Label Verification v1

This repo now contains a greenfield starter for the QA-only label workflow:

- QA signs in
- QA uploads a label photo or captures the label live with camera
- the server OCRs the label and extracts 11-character codes
- QA verifies many part QR values against the same label session
- each verification is saved with user traceability

## Stack

- Next.js
- Turso + Drizzle
- Tesseract.js + Sharp for first-pass OCR
- Google Drive storage adapter for original label images

## Current assumptions

- Version 1 supports image upload and live camera capture for labels
- QR values are compared by exact string match
- extracted label codes are matched with a layout-tolerant `11`-character pattern
- Google Drive storage defaults to `stub` mode until credentials are configured

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables:

```bash
cp .env.example .env.local
```

3. Create the database schema:

```bash
npm run db:push
```

4. Generate a password hash for the first QA user:

```bash
npm run hash-password -- "ChangeMe123!"
```

5. Insert a user into Turso using the returned `salt` and `hash`.

Example SQL:

```sql
insert into users (id, email, name, password_hash, password_salt)
values (
  'qa-user-1',
  'qa@example.com',
  'QA User',
  'HEX_HASH_HERE',
  'HEX_SALT_HERE'
);
```

6. Start the app:

```bash
npm run dev
```

## Google Drive storage

For now the app uses `GOOGLE_DRIVE_MODE=stub` by default so the verification flow can be built and tested without storage credentials.

To switch on real Drive upload:

- set `GOOGLE_DRIVE_MODE=google-drive`
- set `GOOGLE_DRIVE_FOLDER_ID`
- choose one auth method:
  - preferred for Vercel: `GOOGLE_DRIVE_CLIENT_EMAIL` + `GOOGLE_DRIVE_PRIVATE_KEY`
  - temporary/manual: `GOOGLE_DRIVE_ACCESS_TOKEN`

Recommended production approach:

1. Create a Google Cloud service account.
2. Enable the Google Drive API.
3. Create a JSON key for the service account.
4. Share the destination Drive folder with the service account email.
5. Put these values into Vercel environment variables:
   - `GOOGLE_DRIVE_MODE=google-drive`
   - `GOOGLE_DRIVE_FOLDER_ID=...`
   - `GOOGLE_DRIVE_CLIENT_EMAIL=...`
   - `GOOGLE_DRIVE_PRIVATE_KEY=...`

Important:

- When storing `GOOGLE_DRIVE_PRIVATE_KEY` in `.env.local` or Vercel, preserve line breaks by replacing them with `\n` if needed.
- The service account must have access to the exact Drive folder you want the app to upload into.

## Vercel deployment

Set these environment variables in Vercel before deploying:

- `APP_URL`
- `AUTH_SECRET`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `GOOGLE_DRIVE_MODE`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_DRIVE_CLIENT_EMAIL`
- `GOOGLE_DRIVE_PRIVATE_KEY`

Notes:

- The label upload/OCR route is configured for Node.js runtime and a longer max duration because OCR can take longer than a lightweight API call.
- After adding or changing environment variables in Vercel, redeploy the project so the new values are available.

## Important v1 gaps

- OCR tuning is first-pass only and needs testing with real labels
- duplicate-scan handling is minimal
- there is no admin history page yet
