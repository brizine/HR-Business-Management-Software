"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { ErrorBox, formValues } from "@/components/ui";

export default function Login() {
  const { signIn } = useAuth();
  const router = useRouter();
  const { busy, error, run } = useAction();

  return (
    <div className="authwrap">
      <div className="card authcard">
        <h1>Sign in to Crewdesk</h1>
        <p className="muted">HR, time, and fleet maintenance in one place.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            run(async () => {
              const { token } = await api("/auth/login", { body });
              await signIn(token);
              router.replace("/dashboard");
            });
          }}
        >
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="muted">New business? <Link href="/signup">Create an account</Link></p>
      </div>
    </div>
  );
}
