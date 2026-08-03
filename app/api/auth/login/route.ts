import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getUserByEmail, verifyPassword } from "@/lib/db/queries";

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid email and password." },
      { status: 400 },
    );
  }

  const user = await getUserByEmail(parsed.data.email);

  if (!user) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const ok = await verifyPassword(
    parsed.data.password,
    user.passwordHash,
    user.passwordSalt,
  );

  if (!ok) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const session = await createSession(user.id, user.name);
  await setSessionCookie(session.token, session.expiresAt);

  return NextResponse.json({ ok: true });
}
