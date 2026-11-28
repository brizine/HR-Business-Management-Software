"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BALANCE_PLACES, BALANCE_PLACE_LABELS, COLUMN_LOCKED, CUSTOM_FIELD_TARGET_LABELS, DETAIL_HELP, INVOICE_LAYOUT_TAGS, LAYOUT_FONTS, LAYOUT_FONT_LABELS, LAYOUT_INK, LAYOUT_SIZES, LAYOUT_SIZE_LABELS,
  LOGO_PLACES, LOGO_PLACE_LABELS, MAX_DETAILS, MAX_TEXT_BLOCKS, NOTE_PLACES, NOTE_PLACE_LABELS, SECTION_NAMES, STUB_INCHES, TABLE_HEADS, TABLE_HEAD_LABELS, TEXT_ALIGNS,
  TOTAL_NAMES, cleanInvoiceLayout, formatMoney, isFieldKey, newTextBlock, sameLayout, totalHideable, unknownLayoutTags,
  type CustomFieldTarget, type InvoiceLayout, type LayoutTextBlock,
} from "@crewdesk/shared";
import { api, apiBlob, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Grip, useDragOrder } from "./drag-order";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

/**
 * The invoice layout editor: what the invoice shows, what it's called, the order of its middle
 * sections and how it looks, on the left; the real PDF on the right, redrawn as things change.
 * Work is kept as a draft that nothing uses until Publish. The two address blocks and the stub
 * can't be moved: they're where the #10 double-window envelope and the fold need them.
 */

type Version = { id: string; publishedAt: string; by: string | null };
type Field = { key: string; name: string; appliesTo: CustomFieldTarget };
type State = {
  published: InvoiceLayout; draft: InvoiceLayout | null; draftAt: string | null; draftBy: string | null;
  everPublished: boolean; publishedAt: string | null; publishedBy: string | null; versions: Version[]; fields: Field[];
};
type InvoiceRow = { id: string; number: number | null; customerName: string; totalCents: number };

const ALIGN_LABELS: Record<(typeof TEXT_ALIGNS)[number], string> = { left: "Left", center: "Centered", right: "Right" };

/** A list whose rows can be dragged into order. */
function DragList<T>({ items, keyOf, nameOf, onOrder, children }: { items: T[]; keyOf: (x: T) => string; nameOf: (x: T) => string; onOrder: (keys: string[]) => void; children: (x: T) => ReactNode }) {
  const drag = useDragOrder(items.map(keyOf), (next) => onOrder(next));
  return (
    <ul className="plain-list inv-rows" ref={drag.box}>
      {drag.sorted(items, keyOf).map((x) => (
        <li key={keyOf(x)} {...drag.row(keyOf(x), "inv-row")}>
          <Grip drag={drag} id={keyOf(x)} name={nameOf(x)} />
          {children(x)}
        </li>
      ))}
    </ul>
  );
}

/** One group of settings, folded away until it's wanted. */
function Section({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="card inv-sec" open={open}>
      <summary>{title}{hint && <span className="muted"> {hint}</span>}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}

const Check = ({ label, checked, onChange, disabled, title }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string }) => (
  <label className="check" title={title}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}</label>
);
const Pick = <T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void }) => (
  <label>{label}<select value={value} onChange={(e) => onChange(e.target.value as T)}>{options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}</select></label>
);

/** A box of wording with the fill-ins an invoice can fill ("Thank you, {{CUSTOMER_FIRST_NAME}}!"). */
function FillInText({ label, value, onChange, onDone, rows = 3, max, placeholder }: { label: string; value: string; onChange: (v: string) => void; onDone: () => void; rows?: number; max: number; placeholder?: string }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const insert = (tag: string) => {
    const el = box.current;
    const at = el ? el.selectionStart ?? value.length : value.length, end = el ? el.selectionEnd ?? at : at;
    onChange(`${value.slice(0, at)}{{${tag}}}${value.slice(end)}`.slice(0, max));
    el?.focus();
  };
  const groups = [...new Set(INVOICE_LAYOUT_TAGS.map((t) => t.group))];
  return (
    <div className="inv-fill">
      <label>{label}<textarea ref={box} rows={rows} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onDone} placeholder={placeholder} /></label>
      <select className="inv-fillin" value="" aria-label={`Insert a fill-in into ${label.toLowerCase()}`} title="Put a fill-in where the cursor is. It becomes the customer's name, the invoice number and so on when the invoice is made." onChange={(e) => { if (e.target.value) insert(e.target.value); }}>
        <option value="">Insert a fill-in…</option>
        {groups.map((g) => <optgroup key={g} label={g}>{INVOICE_LAYOUT_TAGS.filter((t) => t.group === g).map((t) => <option key={t.tag} value={t.tag}>{t.label}</option>)}</optgroup>)}
      </select>
    </div>
  );
}

export function InvoiceLayoutEditor() {
  const saved = useApi<State>("/invoice-layout");
  const recent = useApi<{ rows: InvoiceRow[] }>("/invoices?status=all&limit=12");
  const [layout, setLayoutState] = useState<InvoiceLayout | null>(null);
  const [previewWith, setPreviewWith] = useState("");
  const [pdf, setPdf] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<"" | "saving" | "saved" | "failed">("");
  const [history, setHistory] = useState(false);
  const act = useAction();
  /** What the server last heard, so the same work isn't saved twice. */
  const lastSaved = useRef("");
  /** A draft save on its way, so Publish and Discard can wait for it instead of being overtaken by it. */
  const saving = useRef<Promise<unknown> | null>(null);
  const seq = useRef(0);

  // Open with the draft if there is one, else what's published.
  useEffect(() => {
    if (!saved.data || layout) return;
    const first = cleanInvoiceLayout(saved.data.draft ?? saved.data.published);
    lastSaved.current = JSON.stringify(first);
    setLayoutState(first);
  }, [saved.data, layout]);

  // The preview: the real PDF, redrawn a moment after the last change.
  useEffect(() => {
    if (!layout) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setDrawing(true);
      try {
        const { blob } = await apiBlob("/invoice-layout/preview", { layout, invoiceId: previewWith || null });
        if (mine !== seq.current) return;
        setPdf((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
        setPreviewError(null);
      } catch (e) {
        if (mine === seq.current) setPreviewError((e as Error).message);
      } finally {
        if (mine === seq.current) setDrawing(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [layout, previewWith]);

  // The draft: kept on the server a little after the typing stops, so nothing is lost by leaving the page.
  useEffect(() => {
    if (!layout) return;
    const text = JSON.stringify(layout);
    if (text === lastSaved.current) return;
    const t = setTimeout(() => {
      setDraftNote("saving");
      saving.current = api<State>("/invoice-layout/draft", { method: "PUT", body: { layout } }).then((next) => {
        lastSaved.current = text;
        saved.setData(next);
        setDraftNote("saved");
      }, () => setDraftNote("failed"));
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  if (saved.error) return <ErrorBox error={saved.error} />;
  if (!saved.data || !layout) return <p className="muted">Loading…</p>;
  const s = saved.data, l = layout;
  const changed = !sameLayout(l, s.published);
  const set = (next: InvoiceLayout) => setLayoutState(cleanInvoiceLayout(next));
  /** Loads a layout into the editor, as work in progress. */
  const open = (next: InvoiceLayout) => { set(next); setHistory(false); };

  const publish = () => act.run(async () => {
    await saving.current;
    const next = await api<State>("/invoice-layout/publish", { body: { layout: l } });
    lastSaved.current = JSON.stringify(cleanInvoiceLayout(next.published));
    saved.setData(next);
    setLayoutState(cleanInvoiceLayout(next.published));
    setDraftNote("");
  });
  const discard = () => confirm("Throw away the changes that aren't on invoices yet?") && act.run(async () => {
    await saving.current;
    const next = await api<State>("/invoice-layout/draft", { method: "DELETE" });
    lastSaved.current = JSON.stringify(cleanInvoiceLayout(next.published));
    saved.setData(next);
    setLayoutState(cleanInvoiceLayout(next.published));
    setDraftNote("");
  });
  const startOver = () => confirm("Go back to Crewdesk's own layout? Your footer and \"payable to\" are kept. Nothing changes on invoices until you publish.") &&
    open({ ...cleanInvoiceLayout({}), footer: { ...cleanInvoiceLayout({}).footer, text: l.footer.text }, stub: { ...cleanInvoiceLayout({}).stub, payableTo: l.stub.payableTo } });
  const restore = (v: Version) => act.run(async () => open((await api<{ layout: InvoiceLayout }>(`/invoice-layout/versions/${v.id}`)).layout));

  const fieldName = (key: string) => s.fields.find((f) => f.key === key);
  const unused = s.fields.filter((f) => !l.header.details.some((d) => d.key === f.key));
  const badTags = unknownLayoutTags(l);
  const blockName = (b: LayoutTextBlock) => `Text: ${b.text.trim().split("\n")[0].slice(0, 36) || "(empty)"}`;
  // Words are kept as typed while they're being typed (tidying then would eat the space after a word); they're tidied on leaving the box.
  const setBlock = (id: string, patch: Partial<LayoutTextBlock>) => setLayoutState({ ...l, blocks: l.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const numbers = l.table.columns.filter((c) => c.key !== "description");
  const description = l.table.columns.find((c) => c.key === "description")!;

  return (
    // One box to the page-layout editor: the settings and the preview stay side by side.
    <div className="inv-editor" data-lkeep>
      <div className="inv-settings stack">
        <div className="card stack inv-status" role="status">
          <div>
            {changed
              ? <><strong>You have changes that aren&apos;t on invoices yet.</strong> <span className="muted">{draftNote === "saving" ? "Saving the draft…" : draftNote === "failed" ? "The draft couldn't be saved; check your connection." : "They're kept as a draft until you publish."}</span></>
              : s.everPublished
                ? <>Invoices print in this layout. <span className="muted">Published {fmtDateTime(s.publishedAt)}{s.publishedBy ? ` by ${s.publishedBy}` : ""}.</span></>
                : <>Invoices print in Crewdesk&apos;s own layout. <span className="muted">Change anything below and the preview shows it; nothing reaches invoices until you publish.</span></>}
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={!changed || act.busy} onClick={publish} title="Every invoice prints in this layout from now on: new ones, and old ones when they're opened or sent again">{act.busy ? "Working…" : "Publish"}</button>
            {changed && <button type="button" className="btn" disabled={act.busy} onClick={discard} title="Go back to the layout invoices print in now">Discard changes</button>}
            {s.versions.length > 0 && <button type="button" className="btn" onClick={() => setHistory(!history)} aria-expanded={history} title="Layouts published before, to open again">History ({s.versions.length})</button>}
            <button type="button" className="btn" onClick={startOver} title="Crewdesk's own layout, as a starting point">Start over</button>
          </div>
          {history && (
            <ul className="plain-list">
              {s.versions.map((v, i) => (
                <li key={v.id}>
                  {v.by ? <>Published {fmtDateTime(v.publishedAt)} by {v.by}</> : <>Crewdesk&apos;s own layout, as invoices were before the first publish</>}{i === 0 && s.everPublished && <span className="badge ok" style={{ marginLeft: 6 }}>on invoices now</span>}
                  {" "}<button type="button" className="linkbtn" disabled={act.busy} onClick={() => restore(v)} title="Open this layout in the editor. Invoices don't change until you publish it.">Open</button>
                </li>
              ))}
            </ul>
          )}
          <ErrorBox error={act.error} />
        </div>

        <Section title="Look" open>
          <div className="formgrid">
            <label>Accent color
              <span className="row">
                <input type="color" value={l.page.accent} onChange={(e) => set({ ...l, page: { ...l.page, accent: e.target.value } })} aria-label="Accent color" style={{ width: 54, padding: 2 }} />
                {l.page.accent !== LAYOUT_INK && <button type="button" className="linkbtn" onClick={() => set({ ...l, page: { ...l.page, accent: LAYOUT_INK } })}>Back to black</button>}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>The title, the amount due and the table&apos;s heading bar.</span>
            </label>
            <Pick label="Typeface" value={l.page.font} options={LAYOUT_FONTS} labels={LAYOUT_FONT_LABELS} onChange={(font) => set({ ...l, page: { ...l.page, font } })} />
            <Pick label="Text size" value={l.page.size} options={LAYOUT_SIZES} labels={LAYOUT_SIZE_LABELS} onChange={(size) => set({ ...l, page: { ...l.page, size } })} />
          </div>
        </Section>

        <Section title="Top of the page" hint="your logo, your address and the title">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Your address and the customer&apos;s stay where a #10 double-window envelope shows them, so they can&apos;t be moved.</p>
          <Check label="Show your logo" checked={l.header.logo.show} onChange={(show) => set({ ...l, header: { ...l.header, logo: { ...l.header.logo, show } } })} />
          {l.header.logo.show && (
            <div className="formgrid">
              <Pick label="Logo size" value={l.header.logo.size} options={LAYOUT_SIZES} labels={LAYOUT_SIZE_LABELS} onChange={(size) => set({ ...l, header: { ...l.header, logo: { ...l.header.logo, size } } })} />
              <Pick label="Logo sits" value={l.header.logo.place} options={LOGO_PLACES} labels={LOGO_PLACE_LABELS} onChange={(place) => set({ ...l, header: { ...l.header, logo: { ...l.header.logo, place } } })} />
            </div>
          )}
          {l.header.logo.show && l.header.logo.place === "left" && l.header.logo.size === "large" && <p className="warn-text" style={{ margin: 0, fontSize: 13 }}>A large logo above your address can push the address below the envelope&apos;s window. Put it on the right, or check the preview against an envelope.</p>}
          <fieldset className="cf-box">
            <legend>Your lines at the top left <span className="muted">(your name always shows)</span></legend>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {(["address", "phone", "email", "website"] as const).map((k) => (
                <Check key={k} label={k.charAt(0).toUpperCase() + k.slice(1)} checked={l.header.company[k]} onChange={(v) => set({ ...l, header: { ...l.header, company: { ...l.header.company, [k]: v } } })} />
              ))}
            </div>
          </fieldset>
          <label>Title<input maxLength={30} value={l.header.title} onChange={(e) => setLayoutState({ ...l, header: { ...l.header, title: e.target.value } })} onBlur={() => set(l)} placeholder="INVOICE" /></label>
        </Section>

        <Section title="Details" hint="the facts at the top right">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Tick what shows, rename it, and drag to put it in order. A detail with nothing to show is left off that invoice.</p>
          <DragList items={l.header.details} keyOf={(d) => d.key} nameOf={(d) => d.label} onOrder={(keys) => set({ ...l, header: { ...l.header, details: keys.map((k) => l.header.details.find((d) => d.key === k)!) } })}>
            {(d) => {
              const f = isFieldKey(d.key) ? fieldName(d.key) : null;
              const what = f ? `Your custom field "${f.name}" (${CUSTOM_FIELD_TARGET_LABELS[f.appliesTo].toLowerCase()})` : (DETAIL_HELP as Record<string, string>)[d.key] ?? "";
              const change = (patch: Partial<typeof d>) => setLayoutState({ ...l, header: { ...l.header, details: l.header.details.map((x) => (x.key === d.key ? { ...x, ...patch } : x)) } });
              return (
                <>
                  <input type="checkbox" checked={d.show} onChange={(e) => change({ show: e.target.checked })} aria-label={`Show ${d.label}`} title={what} />
                  <input value={d.label} maxLength={40} onChange={(e) => change({ label: e.target.value })} onBlur={() => set(l)} aria-label={`Label for ${d.label}`} title={what} />
                  {f ? <button type="button" className="btn sm" title="Take this field off the invoice" aria-label={`Remove ${d.label}`} onClick={() => set({ ...l, header: { ...l.header, details: l.header.details.filter((x) => x.key !== d.key) } })}><Icon name="close" size={12} /></button> : <span className="inv-pad" />}
                </>
              );
            }}
          </DragList>
          {unused.length > 0 && l.header.details.length < MAX_DETAILS && (
            <label>Add one of your custom fields
              <select value="" onChange={(e) => { const f = s.fields.find((x) => x.key === e.target.value); if (f) set({ ...l, header: { ...l.header, details: [...l.header.details, { key: f.key, label: f.name, show: true }] } }); }}>
                <option value="">Choose a field…</option>
                {(["invoice", "customer", "property"] as const).map((t) => {
                  const mine = unused.filter((f) => f.appliesTo === t);
                  return mine.length ? <optgroup key={t} label={CUSTOM_FIELD_TARGET_LABELS[t]}>{mine.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}</optgroup> : null;
                })}
              </select>
            </label>
          )}
          <div className="row inv-line">
            <Check label="Show the amount due, called" checked={l.header.amountDue.show} onChange={(show) => set({ ...l, header: { ...l.header, amountDue: { ...l.header.amountDue, show } } })} />
            <input value={l.header.amountDue.label} maxLength={30} disabled={!l.header.amountDue.show} aria-label="Label for the amount due" onChange={(e) => setLayoutState({ ...l, header: { ...l.header, amountDue: { ...l.header.amountDue, label: e.target.value } } })} onBlur={() => set(l)} />
          </div>
        </Section>

        <Section title="The lines" hint="what was done, and its columns">
          <div className="row inv-line">
            <Check label="Show the service address, called" checked={l.serviceAddress.show} onChange={(show) => set({ ...l, serviceAddress: { ...l.serviceAddress, show } })} />
            <input value={l.serviceAddress.label} maxLength={40} disabled={!l.serviceAddress.show} aria-label="Label for the service address" onChange={(e) => setLayoutState({ ...l, serviceAddress: { ...l.serviceAddress, label: e.target.value } })} onBlur={() => set(l)} />
          </div>
          <fieldset className="cf-box">
            <legend>Columns <span className="muted">(the description always comes first)</span></legend>
            <div className="inv-row inv-fixed"><span className="inv-pad" /><input type="checkbox" checked disabled aria-label="The description always shows" />
              <input value={description.label} maxLength={24} aria-label="Heading for the description" onChange={(e) => setLayoutState({ ...l, table: { ...l.table, columns: l.table.columns.map((c) => (c.key === "description" ? { ...c, label: e.target.value } : c)) } })} onBlur={() => set(l)} />
            </div>
            <DragList items={numbers} keyOf={(c) => c.key} nameOf={(c) => c.label} onOrder={(keys) => set({ ...l, table: { ...l.table, columns: [description, ...keys.map((k) => numbers.find((c) => c.key === k)!)] } })}>
              {(c) => {
                const change = (patch: Partial<typeof c>) => setLayoutState({ ...l, table: { ...l.table, columns: l.table.columns.map((x) => (x.key === c.key ? { ...x, ...patch } : x)) } });
                const locked = COLUMN_LOCKED.includes(c.key);
                return (
                  <>
                    <input type="checkbox" checked={c.show} disabled={locked} onChange={(e) => change({ show: e.target.checked })} aria-label={`Show ${c.label}`} title={locked ? "The amount always shows" : c.key === "tax" ? "Shows only on invoices with a taxed line" : undefined} />
                    <input value={c.label} maxLength={24} onChange={(e) => change({ label: e.target.value })} onBlur={() => set(l)} aria-label={`Heading for ${c.label}`} />
                    {c.key === "tax" && <span className="muted" style={{ fontSize: 12 }}>only when a line is taxed</span>}
                  </>
                );
              }}
            </DragList>
          </fieldset>
          <div className="formgrid">
            <Pick label="Headings" value={l.table.head} options={TABLE_HEADS} labels={TABLE_HEAD_LABELS} onChange={(head) => set({ ...l, table: { ...l.table, head } })} />
          </div>
          <Check label="Shade every other line" checked={l.table.stripes} onChange={(stripes) => set({ ...l, table: { ...l.table, stripes } })} />
        </Section>

        <Section title="Totals">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>The discount, tax, credit and paid rows only show on invoices that have them. {l.totals.balance.show && l.totals.balance.place === "totals" ? "With the previous balance lines under the totals, Today's Amount takes the place of the Amount due row, and the Total row can be left off." : "The total and the amount due always show."}</p>
          <ul className="plain-list inv-rows">
            {l.totals.rows.map((r) => {
              const change = (patch: Partial<typeof r>) => setLayoutState({ ...l, totals: { ...l.totals, rows: l.totals.rows.map((x) => (x.key === r.key ? { ...x, ...patch } : x)) } });
              const hideable = totalHideable(l, r.key);
              return (
                <li key={r.key} className="inv-row">
                  <input type="checkbox" checked={r.show} disabled={!hideable} onChange={(e) => change({ show: e.target.checked })} aria-label={`Show ${TOTAL_NAMES[r.key]}`}
                    title={r.key === "total" ? (hideable ? "Today's Amount below says what the invoice comes to, so this row can go" : "Always shows, unless the previous balance lines are under the totals") : r.key === "due" && l.totals.balance.show && l.totals.balance.place === "totals" ? "Today's Amount takes its place while the previous balance lines are under the totals" : hideable ? undefined : "Always shows when the invoice has it"} />
                  <span className="inv-name">{TOTAL_NAMES[r.key]}</span>
                  <input value={r.label} maxLength={40} onChange={(e) => change({ label: e.target.value })} onBlur={() => set(l)} aria-label={`Label for ${TOTAL_NAMES[r.key]}`} placeholder={r.key === "tax" ? "The tax's name in billing settings" : undefined} />
                </li>
              );
            })}
          </ul>
          <fieldset className="cf-box">
            <legend>Previous balance</legend>
            <Check label="Show the customer's previous balance, this invoice's amount and the total due" checked={l.totals.balance.show} onChange={(show) => set({ ...l, totals: { ...l.totals, balance: { ...l.totals.balance, show } } })} />
            {l.totals.balance.show ? (
              <>
                <ul className="plain-list inv-rows">
                  {([["previousLabel", "Owed from before"], ["todayLabel", "This invoice"], ["totalLabel", "The two together"]] as const).map(([k, name]) => (
                    <li key={k} className="inv-row">
                      <span className="inv-name wider">{name}</span>
                      <input value={l.totals.balance[k]} maxLength={40} aria-label={`Label for ${name.toLowerCase()}`} onChange={(e) => setLayoutState({ ...l, totals: { ...l.totals, balance: { ...l.totals.balance, [k]: e.target.value } } })} onBlur={() => set(l)} />
                    </li>
                  ))}
                </ul>
                <div className="formgrid"><Pick label="These lines print" value={l.totals.balance.place} options={BALANCE_PLACES} labels={BALANCE_PLACE_LABELS} onChange={(place) => set({ ...l, totals: { ...l.totals, balance: { ...l.totals.balance, place } } })} /></div>
                <Check label={l.totals.balance.place === "top" ? "The payment stub asks for the total due" : "The amount due at the top and on the payment stub is the total due"} checked={l.totals.balance.payTotal}
                  onChange={(payTotal) => set({ ...l, totals: { ...l.totals, balance: { ...l.totals.balance, payTotal } } })} title="Unticked, it's this invoice's amount alone" />
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  The previous balance is what the customer still owes on their earlier sent invoices when this one is printed, so it goes down as they pay.{" "}
                  {l.totals.balance.place === "top" ? "At the top right the three lines take the place of the amount due there; the totals under the lines stay the invoice's own." : "Under the totals they take the place of the Amount due row above."}
                </p>
              </>
            ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Adds three lines under the totals: what&apos;s still owed on earlier invoices, what this invoice comes to, and the two together.</p>}
          </fieldset>
        </Section>

        <Section title="Notes and footer">
          <Check label="Show the notes typed on the invoice" checked={l.notes.show} onChange={(show) => set({ ...l, notes: { ...l.notes, show } })} />
          {l.notes.show && (
            <div className="formgrid">
              <label>Heading above the notes <span className="muted">(optional)</span><input value={l.notes.label} maxLength={40} onChange={(e) => setLayoutState({ ...l, notes: { ...l.notes, label: e.target.value } })} onBlur={() => set(l)} placeholder="None" /></label>
              <Pick label="Notes sit" value={l.notes.place} options={NOTE_PLACES} labels={NOTE_PLACE_LABELS} onChange={(place) => set({ ...l, notes: { ...l.notes, place } })} />
            </div>
          )}
          <Check label="Show a footer on every invoice" checked={l.footer.show} onChange={(show) => set({ ...l, footer: { ...l.footer, show } })} />
          {l.footer.show && (
            <>
              <FillInText label="Footer" value={l.footer.text} max={1000} rows={3} onChange={(text) => setLayoutState({ ...l, footer: { ...l.footer, text } })} onDone={() => set(l)} placeholder="Thank you! All program applications are guaranteed…" />
              <div className="formgrid"><Pick label="Footer is" value={l.footer.align} options={TEXT_ALIGNS} labels={ALIGN_LABELS} onChange={(align) => set({ ...l, footer: { ...l.footer, align } })} /></div>
            </>
          )}
        </Section>

        <Section title="Your own text" hint={`blocks of wording, up to ${MAX_TEXT_BLOCKS}`}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>A guarantee, a seasonal offer, how to reach you. Place each one under Order of the page.</p>
          {l.blocks.map((b, i) => (
            <fieldset key={b.id} className="cf-box">
              <legend>Text block {i + 1}</legend>
              <FillInText label={`Wording of text block ${i + 1}`} value={b.text} max={1500} rows={3} onChange={(text) => setBlock(b.id, { text })} onDone={() => set(l)} />
              <div className="formgrid">
                <Pick label="Lined up" value={b.align} options={TEXT_ALIGNS} labels={ALIGN_LABELS} onChange={(align) => setBlock(b.id, { align })} />
                <Pick label="Size" value={b.size} options={LAYOUT_SIZES} labels={LAYOUT_SIZE_LABELS} onChange={(size) => setBlock(b.id, { size })} />
              </div>
              <div className="row">
                <Check label="Bold" checked={b.bold} onChange={(bold) => setBlock(b.id, { bold })} />
                <Check label="In a box" checked={b.box} onChange={(box) => setBlock(b.id, { box })} />
                <button type="button" className="btn" onClick={() => set({ ...l, blocks: l.blocks.filter((x) => x.id !== b.id) })}>Remove</button>
              </div>
            </fieldset>
          ))}
          {l.blocks.length < MAX_TEXT_BLOCKS && <div><button type="button" className="btn" onClick={() => set({ ...l, blocks: [...l.blocks, newTextBlock()] })}><Icon name="plus" size={14} /> Add a text block</button></div>}
        </Section>

        <Section title="Order of the page" hint="the middle sections, top to bottom">
          <DragList items={l.order} keyOf={(x) => x} nameOf={(x) => x} onOrder={(order) => set({ ...l, order })}>
            {(x) => {
              const block = x.startsWith("text:") ? l.blocks.find((b) => b.id === x.slice(5)) : null;
              return <span className="inv-name wide">{block ? blockName(block) : (SECTION_NAMES as Record<string, string>)[x] ?? x}</span>;
            }}
          </DragList>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>These sit between the addresses and the payment stub, and run onto more pages when they need to.</p>
        </Section>

        <Section title="Payment stub" hint="the tear-off part at the bottom">
          <Check label="Print the tear-off stub at the bottom of the first page" checked={l.stub.show} onChange={(show) => set({ ...l, stub: { ...l.stub, show } })} />
          {l.stub.show ? (
            <>
              <label>Tear-off line, in inches from the bottom of the page
                <input type="number" inputMode="decimal" min={STUB_INCHES.min} max={STUB_INCHES.max} step={0.01} value={l.stub.fromBottom} style={{ maxWidth: 140 }}
                  onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= STUB_INCHES.min && v <= STUB_INCHES.max) set({ ...l, stub: { ...l.stub, fromBottom: v } }); }} />
                <span className="muted" style={{ fontSize: 12 }}>Where your paper is perforated: {STUB_INCHES.usual} for a 3½ inch stub, {STUB_INCHES.thirds} for a page folded in thirds. A shorter stub leaves more room for the lines.</span>
              </label>
              <div className="formgrid">
                <label>Line above the stub<input value={l.stub.detach} maxLength={90} onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, detach: e.target.value } })} onBlur={() => set(l)} /></label>
                <label>&quot;Payable to&quot; wording<input value={l.stub.payableLabel} maxLength={40} onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, payableLabel: e.target.value } })} onBlur={() => set(l)} /></label>
                <label>Make checks payable to<input value={l.stub.payableTo} maxLength={160} onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, payableTo: e.target.value } })} onBlur={() => set(l)} placeholder="Your company's legal name" /></label>
                <label>&quot;Mail to&quot; wording<input value={l.stub.mailLabel} maxLength={40} onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, mailLabel: e.target.value } })} onBlur={() => set(l)} /></label>
              </div>
              <div className="row inv-line">
                <Check label="Say how to pay online, as" checked={l.stub.payOnline} onChange={(payOnline) => set({ ...l, stub: { ...l.stub, payOnline } })} title="Shows your portal's address when online payments are connected" />
                <input value={l.stub.payOnlineLabel} maxLength={60} disabled={!l.stub.payOnline} aria-label="Wording for paying online" onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, payOnlineLabel: e.target.value } })} onBlur={() => set(l)} />
              </div>
              <div className="row inv-line">
                <Check label="A line to write the amount on, called" checked={l.stub.enclosed} onChange={(enclosed) => set({ ...l, stub: { ...l.stub, enclosed } })} />
                <input value={l.stub.enclosedLabel} maxLength={40} disabled={!l.stub.enclosed} aria-label="Wording for the amount enclosed" onChange={(e) => setLayoutState({ ...l, stub: { ...l.stub, enclosedLabel: e.target.value } })} onBlur={() => set(l)} />
              </div>
            </>
          ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>Without it, the lines can use the whole first page.</p>}
        </Section>
      </div>

      <div className="inv-preview card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label className="inv-with">Preview with
            <select value={previewWith} onChange={(e) => setPreviewWith(e.target.value)}>
              <option value="">A sample invoice (uses every part of the page)</option>
              {(recent.data?.rows ?? []).map((i) => <option key={i.id} value={i.id}>{i.number != null ? `#${i.number}` : "Draft"} · {i.customerName} · {formatMoney(i.totalCents)}</option>)}
            </select>
          </label>
          <span className="row">
            <span className="muted" style={{ fontSize: 13 }} aria-live="polite">{drawing ? "Updating…" : ""}</span>
            {pdf && <a className="btn" href={pdf} target="_blank" rel="noreferrer" title="The preview on its own, to zoom in or print a test page for your envelope">Open in a new tab</a>}
          </span>
        </div>
        {badTags.length > 0 && <p className="warn-text" role="alert" style={{ margin: 0, fontSize: 13 }}>An invoice can&apos;t fill {badTags.map((t) => `{{${t}}}`).join(", ")}: {badTags.length === 1 ? "it" : "they"} will print as nothing. Pick from Insert a fill-in instead.</p>}
        <ErrorBox error={previewError} />
        {pdf ? <iframe className="inv-frame" title="Invoice preview" src={`${pdf}#toolbar=0&navpanes=0&view=FitH`} /> : <p className="muted">Drawing the preview…</p>}
      </div>
    </div>
  );
}
