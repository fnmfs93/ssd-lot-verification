import { createSign } from "node:crypto";

type StoreLabelImageInput = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

type StoredFile = {
  storageMode: "stub" | "google-drive";
  fileRef: string;
};

export async function storeLabelImage(
  input: StoreLabelImageInput,
): Promise<StoredFile> {
  const mode = process.env.GOOGLE_DRIVE_MODE ?? "stub";

  if (mode !== "google-drive") {
    return {
      storageMode: "stub",
      fileRef: `stub://${Date.now()}-${sanitizeFileName(input.fileName)}`,
    };
  }

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const accessToken =
    process.env.GOOGLE_DRIVE_ACCESS_TOKEN ??
    (await getServiceAccountAccessToken().catch(() => null));

  if (!folderId || !accessToken) {
    throw new Error(
      "Google Drive mode is enabled, but GOOGLE_DRIVE_FOLDER_ID and either a direct access token or service account credentials are required.",
    );
  }

  const metadata = {
    name: sanitizeFileName(input.fileName),
    parents: [folderId],
  };

  const boundary = `lot-verification-${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
    ),
    input.buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Drive upload failed: ${message}`);
  }

  const payload = (await response.json()) as { id: string };

  return {
    storageMode: "google-drive",
    fileRef: payload.id,
  };
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function getServiceAccountAccessToken() {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.GOOGLE_DRIVE_PRIVATE_KEY);

  if (!clientEmail || !privateKey) {
    return null;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 3600;
  const header = base64UrlEncode(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/drive.file",
      aud: "https://oauth2.googleapis.com/token",
      exp: expiresAt,
      iat: issuedAt,
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  const assertion = `${unsignedToken}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google OAuth token exchange failed: ${message}`);
  }

  const payloadJson = (await response.json()) as { access_token?: string };

  if (!payloadJson.access_token) {
    throw new Error("Google OAuth token exchange returned no access token.");
  }

  return payloadJson.access_token;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value: string | undefined) {
  if (!value) {
    return null;
  }

  return value.replace(/\\n/g, "\n");
}
