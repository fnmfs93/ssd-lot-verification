import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getUserByEmail, verifyPassword } from "@/lib/db/queries";

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

/**
 * Plain-HTML-form login endpoint — a fallback for browsers that don't run
 * the app's JavaScript (seen on an industrial Android handheld's built-in
 * browser, which silently failed to intercept the form's onSubmit and fell
 * through to a native submit). A native <form method="post"> to this route
 * works with zero JS: the browser sends email/password as a normal POST
 * body, and a 303 redirect + Set-Cookie is something every HTTP client
 * follows correctly on its own, no client-side script involved.
 */
export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  const loginUrl = new URL("/login", request.url);

  const parsed = schema.safeParse({
    email: formData?.get("email"),
    password: formData?.get("password"),
  });

  if (!parsed.success) {
    loginUrl.searchParams.set("error", "Enter a valid email and password.");
    return NextResponse.redirect(loginUrl, 303);
  }

  const user = await getUserByEmail(parsed.data.email);

  if (!user) {
    loginUrl.searchParams.set("error", "Invalid email or password.");
    return NextResponse.redirect(loginUrl, 303);
  }

  const ok = await verifyPassword(
    parsed.data.password,
    user.passwordHash,
    user.passwordSalt,
  );

  if (!ok) {
    loginUrl.searchParams.set("error", "Invalid email or password.");
    return NextResponse.redirect(loginUrl, 303);
  }

  const session = await createSession(user.id, user.name);
  await setSessionCookie(session.token, session.expiresAt);

  return NextResponse.redirect(new URL("/qa", request.url), 303);
}
