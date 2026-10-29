"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { ErrorBox, formValues } from "@/components/ui";

export default function Signup() {
  const { signIn } = useAuth();
  const router = useRouter();
  const { busy, error, run } = useAction();

  return (
    <div className="authwrap">
      <div className="card authcard">
        <h1>Create your company</h1>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            run(async () => {
              const { token } = await api("/auth/signup", { body });
              await signIn(token);
              router.replace("/");
            });
          }}
        >
          <label>Company name<input name="companyName" required /></label>
          <div className="formgrid">
            <label>First name<input name="firstName" required /></label>
            <label>Last name<input name="lastName" required /></label>
          </div>
          <label>Email<input name="email" type="email" required /></label>
          <label>Password<input name="password" type="password" minLength={8} required /></label>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy}>Create account</button>
        </form>
        <p className="muted">Already have an account? <Link href="/login">Sign in</Link></p>
      </div>
    </div>
  );
}
