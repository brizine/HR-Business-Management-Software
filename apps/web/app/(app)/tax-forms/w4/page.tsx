"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ATTESTATIONS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { PageHead } from "@/components/ui";
import { AddressFields, Section, SignatureBlock, readForm } from "@/components/tax-form-bits";

export default function W4Form() {
  const { me } = useAuth();
  const router = useRouter();
  const prefill = useApi("/tax-forms/prefill/w4");
  const settings = useApi("/tax-forms/settings");
  const formRef = useRef<HTMLFormElement>(null);
  const [kids, setKids] = useState(0);
  const [others, setOthers] = useState(0);
  const { busy, error, run } = useAction();
  if (prefill.loading || !settings.data || !me) return null;
  const d = prefill.data ?? { firstName: me.user.firstName, lastName: me.user.lastName };
  const amt = settings.data.w4Amounts;

  return (
    <form ref={formRef} onSubmit={(e) => {
      e.preventDefault();
      const v = readForm(e.currentTarget);
      run(async () => { await api("/tax-forms/w4", { body: v }); router.push("/tax-forms?saved=w4"); });
    }}>
      <PageHead title="Form W-4: Employee's Withholding Certificate"
        sub={<>Tells us how much federal income tax to withhold from your pay. Not sure? The IRS <a href="https://www.irs.gov/individuals/tax-withholding-estimator" target="_blank" rel="noreferrer">Tax Withholding Estimator</a> and the <a href="https://www.irs.gov/forms-pubs/about-form-w-4" target="_blank" rel="noreferrer">W-4 instructions</a> can help.</>} />
      <Section title="Step 1: Your information">
        <div className="formgrid">
          <label>First name<input name="firstName" defaultValue={d.firstName} required /></label>
          <label>Middle initial<input name="middleInitial" defaultValue={d.middleInitial} maxLength={1} /></label>
          <label>Last name<input name="lastName" defaultValue={d.lastName} required /></label>
          <label>Social Security number<input name="ssn" required inputMode="numeric" autoComplete="off" placeholder="123-45-6789" /></label>
        </div>
        <AddressFields d={d} />
        <div className="stack">
          <span className="muted" style={{ fontSize: 12 }}>Filing status</span>
          <label className="check"><input type="radio" name="filingStatus" value="single" defaultChecked={!d.filingStatus || d.filingStatus === "single"} /> Single or Married filing separately</label>
          <label className="check"><input type="radio" name="filingStatus" value="married_jointly" defaultChecked={d.filingStatus === "married_jointly"} /> Married filing jointly or Qualifying surviving spouse</label>
          <label className="check"><input type="radio" name="filingStatus" value="head_of_household" defaultChecked={d.filingStatus === "head_of_household"} /> Head of household</label>
        </div>
      </Section>
      <Section title="Step 2: Multiple jobs or spouse works" hint="Only if you hold more than one job at a time, or you're married filing jointly and your spouse also works. Check the box if there are only two jobs total; otherwise see the W-4 instructions.">
        <label className="check"><input type="checkbox" name="multipleJobs" defaultChecked={d.multipleJobs} /> There are only two jobs total (Step 2(c))</label>
      </Section>
      <Section title="Step 3: Dependents and other credits" hint={`If your total income will be $200,000 or less ($400,000 if married filing jointly). Amounts per the ${amt.year} Form W-4: $${amt.perChildUnder17.toLocaleString()} per child under 17, $${amt.perOtherDependent} per other dependent.`}>
        <div className="formgrid">
          <label>Children under 17 (count)<input type="number" min={0} value={kids} onChange={(e) => setKids(Number(e.target.value))} /></label>
          <label>Other dependents (count)<input type="number" min={0} value={others} onChange={(e) => setOthers(Number(e.target.value))} /></label>
          <div style={{ alignSelf: "end" }}>
            <button type="button" className="btn" onClick={() => {
              const f = formRef.current!;
              (f.elements.namedItem("childrenAmount") as HTMLInputElement).value = String(kids * amt.perChildUnder17);
              (f.elements.namedItem("otherDependentsAmount") as HTMLInputElement).value = String(others * amt.perOtherDependent);
            }}>Calculate amounts</button>
          </div>
        </div>
        <div className="formgrid">
          <label>Qualifying children amount ($)<input name="childrenAmount" type="number" min={0} step="1" defaultValue={d.childrenAmount ?? 0} /></label>
          <label>Other dependents amount ($)<input name="otherDependentsAmount" type="number" min={0} step="1" defaultValue={d.otherDependentsAmount ?? 0} /></label>
        </div>
      </Section>
      <Section title="Step 4 (optional): Other adjustments">
        <div className="formgrid">
          <label>4(a) Other income, yearly ($)<input name="otherIncome" type="number" min={0} defaultValue={d.otherIncome ?? 0} /></label>
          <label>4(b) Deductions, yearly ($)<input name="deductions" type="number" min={0} defaultValue={d.deductions ?? 0} /></label>
          <label>4(c) Extra withholding each pay period ($)<input name="extraWithholding" type="number" min={0} step="0.01" defaultValue={d.extraWithholding ?? 0} /></label>
        </div>
        <label className="check"><input type="checkbox" name="exempt" defaultChecked={d.exempt} /> Claim exemption from withholding (only if you owed no federal income tax last year and expect to owe none this year; it expires February 15 next year)</label>
      </Section>
      <SignatureBlock statement={ATTESTATIONS.w4} defaultName={`${me.user.firstName} ${me.user.lastName}`} busy={busy} error={error} />
    </form>
  );
}
