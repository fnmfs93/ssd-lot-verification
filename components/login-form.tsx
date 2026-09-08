"use client";

import { FormEvent, useState } from "react";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
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
      // Explicit rather than relying on the "same-origin" default — some
      // older/non-standard mobile browsers (seen on an industrial Android
      // handheld) default fetch() credentials to "omit" instead, which
      // silently drops the Set-Cookie response, making login look like it
      // succeeds but never actually persisting the session.
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

    // A full navigation rather than router.push()'s client-side RSC fetch —
    // more robust on non-standard browsers where the soft-navigation fetch
    // might not share the same cookie jar as a real page load.
    window.location.assign("/qa");
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
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
