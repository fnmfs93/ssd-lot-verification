import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "@/lib/auth/constants";
import {
  createSessionRecord,
  deleteSessionByToken,
  getSessionByToken,
} from "@/lib/db/queries";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
};

export async function createSession(userId: string, userName: string) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await createSessionRecord({ token, userId, userName, expiresAt });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function getSessionToken() {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = await getSessionToken();

  if (!token) {
    return null;
  }

  const session = await getSessionByToken(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await deleteSessionByToken(token);
    await clearSessionCookie();
    return null;
  }

  return {
    id: session.userId,
    name: session.userName,
    email: session.userEmail,
  };
}
