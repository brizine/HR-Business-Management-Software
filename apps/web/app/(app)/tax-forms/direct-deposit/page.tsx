"use client";
import { useRouter } from "next/navigation";
import { ATTESTATIONS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { Section, SignatureBlock, readForm } from "@/components/tax-form-bits";

export default function DirectDepositForm() {
  const { me } = useAuth();
  const router = useRouter();
  const prefill = useApi("/tax-forms/prefill/direct_deposit");
  const { busy, error, run } = useAction();
  if (prefill.loading || !me) return null;
  const d = prefill.data ?? {};

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      run(async () => { await api("/tax-forms/direct-deposit", { body: readForm(e.currentTarget) }); router.push("/tax-forms?saved=dd"); });
    }}>
      <PageHead title="Direct deposit" sub="Your routing and account numbers are on your checks or in your bank's app. Changes apply from the next payroll HR runs after they enter them." />
      <Section title="Bank account">
        <div className="formgrid">
          <label>Bank name<input name="bankName" defaultValue={d.bankName} required /></label>
          <label>Account type
            <select name="accountType" defaultValue={d.accountType ?? "checking"}><option value="checking">Checking</option><option value="savings">Savings</option></select>
          </label>
          <label>Routing number (9 digits)<input name="routingNumber" defaultValue={d.routingNumber} required inputMode="numeric" maxLength={9} autoComplete="off" /></label>
          <label>Account number<input name="accountNumber" required inputMode="numeric" autoComplete="off" /></label>
          <label>Account number again<input name="accountNumberConfirm" required inputMode="numeric" autoComplete="off" onPaste={(e) => e.preventDefault()} /></label>
        </div>
      </Section>
      <SignatureBlock statement={ATTESTATIONS.directDeposit} defaultName={`${me.user.firstName} ${me.user.lastName}`} busy={busy} error={error} />
    </form>
  );
}
