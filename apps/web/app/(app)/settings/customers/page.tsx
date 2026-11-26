"use client";
import { useState } from "react";
import { TAG_COLORS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Grip, useDragOrder } from "@/components/drag-order";
import { SettingsTabs } from "@/components/settings-tabs";
import { TagChip, useTags, type Tag } from "@/components/customers";
import { AutoSendCard, EstimateDepositCard, LateFeesCard } from "@/components/billing-rules";
import { CardOnFileCard } from "@/components/waitlist";

/** Customer settings (admins in Customers & billing): the tag list and the cancellation reasons. */
export default function CustomerSettings() {
  const { can } = useAuth();
  return (
    <>
      <SettingsTabs />
      <PageHead title="Customers & billing" sub="Invoice numbering and terms, late fees, auto-sending, estimate deposits, card on file, tags and cancellation reasons." />
      {can("admin", "customers") ? <><BillingCard /><LateFeesCard /><AutoSendCard /><EstimateDepositCard /><CardRule /><TagsCard /><ReasonsCard /></> : <p className="muted">Only admins in Customers &amp; billing can change these.</p>}
    </>
  );
}

function CardRule() {
  const settings = useApi<{ requireCardOnFile?: boolean }>("/invoices/settings");
  if (!settings.data) return null;
  return <CardOnFileCard value={!!settings.data.requireCardOnFile} onSaved={(v) => settings.setData({ ...settings.data, requireCardOnFile: v })} />;
}

function TagsCard() {
  const { tags, reload } = useTags();
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  const [merging, setMerging] = useState<Tag | null>(null);
  const action = useAction();
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Tags</h2>
        <button className="btn primary" onClick={() => setEditing("new")}>Add tag</button>
      </div>
      <p className="muted">Staff pick from this list, so the same thing isn&apos;t tagged three ways. Archiving hides a tag from new use but keeps it where it is.</p>
      {editing && <TagForm tag={editing === "new" ? null : editing} onDone={() => { setEditing(null); reload(); }} />}
      {merging && (
        <form className="card inset row" onSubmit={(e) => {
          e.preventDefault();
          const intoId = (new FormData(e.currentTarget).get("into") as string) || "";
          action.run(async () => { await api(`/crm/tags/${merging.id}/merge`, { body: { intoId } }); setMerging(null); reload(); });
        }}>
          <span>Merge <TagChip tag={merging} /> into</span>
          <select name="into" required>{tags.filter((t) => t.id !== merging.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <button className="btn primary" disabled={action.busy}>Merge</button>
          <button type="button" className="btn" onClick={() => setMerging(null)}>Cancel</button>
        </form>
      )}
      <ErrorBox error={action.error} />
      {tags.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Tag</th><th>Description</th><th>Customers</th><th>Properties</th><th /></tr></thead>
            <tbody>{tags.map((t) => (
              <tr key={t.id} style={t.archived ? { opacity: 0.6 } : undefined}>
                <td><TagChip tag={t} />{t.archived && <span className="muted"> archived</span>}</td>
                <td>{t.description ?? ""}</td>
                <td>{t.customers}</td>
                <td>{t.properties}</td>
                <td className="row">
                  <button className="btn" onClick={() => setEditing(t)}>Edit</button>
                  <button className="btn" onClick={() => setMerging(t)}>Merge…</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No tags yet. Try &quot;Commercial&quot;, &quot;HOA&quot;, &quot;Dog in yard&quot;, &quot;Gate code needed&quot;, &quot;VIP&quot;.</Empty>}
    </div>
  );
}

function TagForm({ tag, onDone }: { tag: Tag | null; onDone: () => void }) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? "gray");
  const [description, setDescription] = useState(tag?.description ?? "");
  const [archived, setArchived] = useState(tag?.archived ?? false);
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" onSubmit={(e) => {
      e.preventDefault();
      const body = { name, color, archived, ...(description.trim() ? { description } : {}) };
      run(async () => { await api(tag ? `/crm/tags/${tag.id}` : "/crm/tags", { method: tag ? "PUT" : "POST", body }); onDone(); });
    }}>
      <div className="formgrid">
        <label>Name<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Color
          <select value={color} onChange={(e) => setColor(e.target.value)}>{TAG_COLORS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select>
        </label>
        <label>Description<input maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
      <div className="row">Preview: <TagChip tag={{ name: name || "Tag", color }} />{tag && <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>}</div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function ReasonsCard() {
  const reasons = useApi<any[]>("/crm/cancel-reasons");
  const [editing, setEditing] = useState<any | "new" | null>(null);
  const action = useAction();
  const list = reasons.data ?? [];
  const drag = useDragOrder(list.map((r) => r.id), (ids) => action.run(async () => { reasons.setData(await api("/crm/cancel-reasons-order", { method: "PUT", body: { ids } })); }), { busy: action.busy });
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Cancellation reasons</h2>
        <button className="btn primary" onClick={() => setEditing("new")}>Add reason</button>
      </div>
      <p className="muted">The drop-down shown when a customer or property is cancelled. Retired reasons stay on past cancellations.</p>
      {editing && <ReasonForm reason={editing === "new" ? null : editing} onDone={() => { setEditing(null); reasons.reload(); }} />}
      <ErrorBox error={action.error} />
      <ol className="plain-list drag-list" ref={drag.box}>
        {drag.sorted(list, (r) => r.id).map((r) => (
          <li key={r.id} {...drag.row(r.id, "row")} style={{ opacity: r.retired ? 0.6 : 1 }}>
            <Grip drag={drag} id={r.id} name={r.label} />
            <span style={{ flex: 1 }}><strong>{r.label}</strong> <span className="muted">{r.initiatedBy === "company" ? "our decision" : "customer's decision"}{r.commentRequired ? " · comment required" : ""}{r.retired ? " · retired" : ""}</span></span>
            <span className="row">
              <button className="btn" onClick={() => setEditing(r)}>Edit</button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReasonForm({ reason, onDone }: { reason: any | null; onDone: () => void }) {
  const [label, setLabel] = useState(reason?.label ?? "");
  const [initiatedBy, setInitiatedBy] = useState(reason?.initiatedBy ?? "customer");
  const [commentRequired, setCommentRequired] = useState(!!reason?.commentRequired);
  const [retired, setRetired] = useState(!!reason?.retired);
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => { await api(reason ? `/crm/cancel-reasons/${reason.id}` : "/crm/cancel-reasons", { method: reason ? "PUT" : "POST", body: { label, initiatedBy, commentRequired, retired } }); onDone(); });
    }}>
      <div className="formgrid">
        <label>Reason<input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label>Whose decision
          <select value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value)}>
            <option value="customer">The customer&apos;s</option>
            <option value="company">Ours (e.g. non-payment)</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={commentRequired} onChange={(e) => setCommentRequired(e.target.checked)} /> Comment required</label>
        {reason && <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Retired</label>}
      </div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** Invoice numbering, terms, the "payable to" name and the printed footer. */
function BillingCard() {
  const saved = useApi<{ nextInvoiceNumber: number; termsDays: number; footer: string; payableTo: string; autoApplyCredits: boolean; taxEnabled: boolean; taxName: string; defaultTaxRate: number }>("/invoices/settings");
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  const [taxOn, setTaxOn] = useState<boolean | null>(null);
  if (!saved.data) return null;
  const s = saved.data;
  const tax = taxOn ?? s.taxEnabled;
  return (
    <form className="card stack" onChange={() => setDone(false)} onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const body = {
        nextInvoiceNumber: Number(f.get("next")), termsDays: Number(f.get("terms")), footer: String(f.get("footer") ?? ""), payableTo: String(f.get("payable") ?? ""), autoApplyCredits: f.get("autoCredits") === "on",
        taxEnabled: f.get("taxOn") === "on", taxName: String(f.get("taxName") ?? "").trim() || "Sales tax", defaultTaxRate: Number(f.get("taxRate") ?? 0) || 0,
      };
      run(async () => { saved.setData(await api("/invoices/settings", { method: "PUT", body })); setDone(true); });
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Invoices</h2>
      <div className="formgrid">
        <label>Next invoice number<input name="next" type="number" min={1} defaultValue={s.nextInvoiceNumber} /><span className="muted" style={{ fontSize: 12 }}>At switch-over, set this to follow Service Autopilot's last number.</span></label>
        <label>Usual terms
          <select name="terms" defaultValue={String(s.termsDays)}>
            {[0, 7, 10, 15, 30].map((d) => <option key={d} value={d}>{d === 0 ? "Due on receipt" : `Net ${d} (due in ${d} days)`}</option>)}
          </select>
        </label>
        <label>Make checks payable to<input name="payable" defaultValue={s.payableTo} placeholder="Your company name" /></label>
      </div>
      <label>Footer on every invoice<textarea name="footer" rows={2} defaultValue={s.footer} placeholder="Thank you! All program applications are guaranteed…" /></label>
      <label className="check"><input type="checkbox" name="autoCredits" defaultChecked={s.autoApplyCredits !== false} /> Use a customer&apos;s credit on their invoices automatically when the invoices are sent</label>
      <fieldset className="cf-box">
        <legend>Sales tax</legend>
        <label className="check"><input type="checkbox" name="taxOn" checked={tax} onChange={(e) => setTaxOn(e.target.checked)} /> Charge sales tax</label>
        {tax ? (
          <>
            <div className="formgrid">
              <label>Call it<input name="taxName" maxLength={40} defaultValue={s.taxName || "Sales tax"} placeholder="Sales tax" /></label>
              <label>Default tax rate (%)<input name="taxRate" inputMode="decimal" defaultValue={s.defaultTaxRate || ""} placeholder="8.625" /></label>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Lines for items marked <strong>This is taxable</strong> on the price list get this rate, unless the property or the customer has its own rate.
              Tax-exempt customers pay none. Each line&apos;s rate can be changed on the work order or invoice. For Bigcapital, turn on Sales Tax there too.
            </p>
          </>
        ) : (
          <>
            <input type="hidden" name="taxName" value={s.taxName || "Sales tax"} />
            <input type="hidden" name="taxRate" value={s.defaultTaxRate || 0} />
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Off: no tax on any work order or invoice. You can still mark price-list items taxable and customers exempt, ready for when it&apos;s on.</p>
          </>
        )}
      </fieldset>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button>{done && <span className="muted">Saved.</span>}</div>
    </form>
  );
}
