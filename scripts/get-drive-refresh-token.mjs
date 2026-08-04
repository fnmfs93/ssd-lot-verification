import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const ENV_PATH = new URL("../.env.local", import.meta.url);
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";

function readEnvLocal() {
  if (!existsSync(ENV_PATH)) {
    return {};
  }

  const lines = readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  const values = {};

  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      values[match[1]] = match[2];
    }
  }

  return values;
}

function upsertEnvLocal(key, value) {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const pattern = new RegExp(`^${key}=`);
  const index = lines.findIndex((line) => pattern.test(line));
  const entry = `${key}=${value}`;

  if (index >= 0) {
    lines[index] = entry;
  } else {
    if (lines.length && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines[lines.length - 1] = entry;
  }

  writeFileSync(ENV_PATH, lines.join("\n"));
}

const env = readEnvLocal();
const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.local. Add them first, then re-run.",
  );
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\nOpen this URL and approve access with the Google account that owns the Drive folder:\n");
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect back to ${REDIRECT_URI} ...\n`);

try {
  execSync(`start "" "${authUrl.toString()}"`, { shell: "cmd.exe" });
} catch {
  // Ignore — user can open the printed URL manually.
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);

  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Authorization failed: ${error}`);
    console.error(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing authorization code.");
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    const payload = await tokenResponse.json();

    if (!tokenResponse.ok || !payload.refresh_token) {
      throw new Error(payload.error_description ?? payload.error ?? "No refresh_token returned. Try again with prompt=consent (already set) after revoking prior access at https://myaccount.google.com/permissions.");
    }

    upsertEnvLocal("GOOGLE_DRIVE_REFRESH_TOKEN", payload.refresh_token);

    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Success — refresh token saved to .env.local. You can close this tab.");

    console.log("Saved GOOGLE_DRIVE_REFRESH_TOKEN to .env.local.");
    console.log("Now add GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_DRIVE_REFRESH_TOKEN to Vercel's project environment variables too.");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err.message ?? err));
    console.error("Token exchange failed:", err.message ?? err);
  } finally {
    server.close();
  }
});

server.listen(PORT);
