import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

let cachedDb: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (cachedDb) {
    return cachedDb;
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is not configured.");
  }

  cachedDb = drizzle({
    client: createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    }),
  });

  return cachedDb;
}
