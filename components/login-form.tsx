"use client";

import { FormEvent, useState } from "react";

/**
 * Submits to /api/auth/login-form with method="post" by default — a plain
 * HTML form that works with zero JavaScript (server validates, sets the
 * session cookie, and 303-redirects to /qa or back to /login?error=...).
 *
 * This matters because at least one real device in the field (an industrial
 * Android handheld's built-in browser) doesn't run this page's JS at all —
 * its onSubmit never fired, so the form fell through to a native GET
 * submit, which put the password in the URL and lost the login entirely.
 * The onSubmit handler below is a progressive enhancement on top of that:
 * when JS does run, it intercepts the native submit and does a nicer
 * same-page JSON round-trip instead.
 *
 * The password field is deliberately left unmasked (type="text") rather
 * than a maskable type="password" with a JS-driven show/hide toggle — on
 * that same non-JS browser a toggle button can never respond (there's no
 * way to swap an input's type via CSS alone), so it'd be dead UI exactly
 * where it's needed most. This is a single shared internal QA credential
 * on a dedicated handheld, not a public account, so trading masking away
 * for "guaranteed to work everywhere" is the right call here.
 */
export function LoginForm({ serverError }: { serverError?: string }) {
  const [error, setError] = useState<string | null>(serverError ?? null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsPending(true);

    const formData = new FormData(event.currentTarget);
    const payload = {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
    };

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    });

    const data = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    if (!response.ok) {
      setError(data?.error ?? "Unable to sign in.");
      setIsPending(false);
      return;
    }

    window.location.assign("/qa");
  }

  return (
    <form
      method="post"
      action="/api/auth/login-form"
      onSubmit={handleSubmit}
    >
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="text"
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="button-row">
        <button className="button" type="submit" disabled={isPending}>
          {isPending ? "Signing in..." : "Sign In"}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
