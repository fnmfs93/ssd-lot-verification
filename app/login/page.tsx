import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth/session";

export default async function LoginPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/qa");
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">Version 1</div>
        <h1>Label to Part Verification</h1>
        <p>
          QA signs in, uploads a label photo, reviews the extracted codes, and
          then verifies part QR values one by one against that label.
        </p>
      </section>

      <div className="grid">
        <div className="card">
          <h2>QA Sign-In</h2>
          <p className="muted">
            This starter uses internal email and password authentication backed
            by the app database so each verification stays traceable.
          </p>
          <LoginForm />
        </div>

        <div className="stack">
          <section className="card">
            <h3>What v1 includes</h3>
            <p className="muted">
              Label session creation, OCR extraction seam, repeated part
              verification, and saved QA history.
            </p>
          </section>

          <section className="card">
            <h3>Google Drive note</h3>
            <p className="muted">
              Image storage is wired through a storage adapter. It defaults to a
              stub mode until Google Drive credentials are configured.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
