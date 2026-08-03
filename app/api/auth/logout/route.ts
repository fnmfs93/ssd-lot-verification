import { NextResponse } from "next/server";
import { clearSessionCookie, getSessionToken } from "@/lib/auth/session";
import { deleteSessionByToken } from "@/lib/db/queries";

export async function POST() {
  const token = await getSessionToken();

  if (token) {
    await deleteSessionByToken(token);
  }

  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
