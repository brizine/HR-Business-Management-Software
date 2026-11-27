"use client";
import { useState, type ReactNode } from "react";
import { CONTACT_PHONES, FORMS_OF_CONTACT, FORM_OF_CONTACT_LABELS, contactChannel, contactName, formatPhone, formatPhoneTyping, type FormOfContact } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Icon } from "./icons";
import { useMenus } from "./menu-select";
import { ErrorBox } from "./ui";

/**
 * Contacts on a property who aren't customers: a tenant, an on-site manager, a neighbor with the
 * key. They have no account and get no invoices; they're who the office or the crew reaches about
 * the address, and the ticked ones get the property's service notifications. The form follows
 * Service Autopilot's Add Contact. "Moved out" keeps them in the property's history.
 */

export interface PropertyContact {
  id: string; name: string; firstName: string | null; lastName: string | null; nickname: string | null; relation: string; email: string | null;
  homePhone: string | null; workPhone: string | null; cellPhone: string | null; otherPhone: string | null; fax: string | null; phone: string | null;
  formOfContact: FormOfContact | null; birthday: string | null; notes: string | null; notify: boolean; textOptOutAt: string | null;
  startDate: string | null; endDate: string | null;
}

const phone = (v: string | null | undefined) => (v ? formatPhone(v) : "");
/** A birthday without the weekday: "March 4, 1988". */
const birthdayText = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** How a ticked contact's notifications reach them, in words. */
export function notifyHow(c: { email?: string | null; cellPhone?: string | null; homePhone?: string | null; workPhone?: string | null; otherPhone?: string | null; formOfContact?: string | null; textOptOutAt?: string | null }) {
  const ch = contactChannel(c);
  if (!ch) return null;
  if (ch === "email") return `by email to ${c.email}`;
  if (ch === "text") return c.textOptOutAt ? "by text, but they replied STOP" : `by text to ${phone(c.cellPhone)}`;
  return "by a phone call from the office";
}

/** One line of the form: the label at the left, the box at the right (as in Service Autopilot). */
function Line({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <><label htmlFor={id}>{label}</label><div>{children}</div></>;
}

/** Add Contact, or change one: a window laid out like Service Autopilot's, plus the notifications tick. */
export function ContactForm({ propertyId, contact: c, onDone }: { propertyId: string; contact?: PropertyContact; onDone: (saved: boolean) => void }) {
  const types = useMenus().contactTypes;
  const [f, setF] = useState({
    firstName: c?.firstName ?? "", lastName: c?.lastName ?? "", nickname: c?.nickname ?? "", relation: c?.relation ?? types[0] ?? "Tenant", email: c?.email ?? "",
    homePhone: phone(c?.homePhone), workPhone: phone(c?.workPhone), cellPhone: phone(c?.cellPhone), otherPhone: phone(c?.otherPhone), fax: phone(c?.fax),
    formOfContact: (c?.formOfContact ?? "") as FormOfContact | "", birthday: c?.birthday ?? "", notes: c?.notes ?? "", startDate: c?.startDate ?? "",
  });
  const [notify, setNotify] = useState(c?.notify ?? false);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const setPhone = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((cur) => ({ ...cur, [k]: formatPhoneTyping(e.target.value) }));
  const named = !!(f.firstName.trim() || f.lastName.trim());
  const how = notifyHow({ ...f, textOptOutAt: c && phone(c.cellPhone) === f.cellPhone ? c.textOptOutAt : null });
  const typeOptions = types.includes(f.relation) || !f.relation ? types : [...types, f.relation];
  // The form of contact has to be something they have.
  const anyPhone = [f.cellPhone, f.homePhone, f.workPhone, f.otherPhone].some((v) => v.trim());
  const formProblem = f.formOfContact === "text" && !f.cellPhone.trim() ? "Enter their cell phone to reach them by text."
    : f.formOfContact === "email" && !f.email.trim() ? "Enter their email address to reach them by email."
    : f.formOfContact === "call" && !anyPhone ? "Enter a phone number to reach them by phone." : null;
  const title = c ? `Change ${c.name}` : "Add Contact";
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}>
      <form className="cal-modal card stack contact-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await api(c ? `/properties/${propertyId}/contacts/${c.id}` : `/properties/${propertyId}/contacts`, { method: c ? "PUT" : "POST", body: { ...f, notify } });
          onDone(true);
        });
      }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" className="btn sm" onClick={() => onDone(false)} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        {!c && <p className="muted" style={{ margin: 0 }}>Someone to reach about this address who isn&apos;t a customer, such as a tenant. They don&apos;t get invoices and don&apos;t need an account.</p>}
        <div className="contact-form">
          <Line label="First Name" id="pc-first"><input id="pc-first" autoFocus maxLength={80} value={f.firstName} onChange={set("firstName")} /></Line>
          <Line label="Last Name" id="pc-last"><input id="pc-last" maxLength={80} value={f.lastName} onChange={set("lastName")} /></Line>
          <Line label="Nickname" id="pc-nick"><input id="pc-nick" maxLength={80} value={f.nickname} onChange={set("nickname")} /></Line>
          <Line label="Contact Type" id="pc-type">
            <select id="pc-type" value={f.relation} onChange={set("relation")}>
              {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Line>
          <Line label="Email" id="pc-email"><input id="pc-email" type="email" maxLength={254} value={f.email} onChange={set("email")} /></Line>
          <Line label="Home Phone" id="pc-home"><input id="pc-home" type="tel" inputMode="tel" value={f.homePhone} onChange={setPhone("homePhone")} /></Line>
          <Line label="Work Phone" id="pc-work"><input id="pc-work" type="tel" inputMode="tel" value={f.workPhone} onChange={setPhone("workPhone")} /></Line>
          <Line label="Cell Phone" id="pc-cell"><input id="pc-cell" type="tel" inputMode="tel" value={f.cellPhone} onChange={setPhone("cellPhone")} /></Line>
          <Line label="Other Phone" id="pc-other"><input id="pc-other" type="tel" inputMode="tel" value={f.otherPhone} onChange={setPhone("otherPhone")} /></Line>
          <Line label="FAX" id="pc-fax"><input id="pc-fax" type="tel" inputMode="tel" value={f.fax} onChange={setPhone("fax")} /></Line>
          <Line label="Form of Contact" id="pc-form">
            <select id="pc-form" value={f.formOfContact} onChange={set("formOfContact")} title="How they'd rather be reached. Their service notifications go this way too.">
              <option value="">Select</option>
              {FORMS_OF_CONTACT.map((k) => <option key={k} value={k}>{FORM_OF_CONTACT_LABELS[k]}</option>)}
            </select>
            {formProblem && <div className="warn-text" role="alert" style={{ fontSize: 13, marginTop: 4 }}>{formProblem}</div>}
          </Line>
          <Line label="Birthday" id="pc-bday"><input id="pc-bday" type="date" value={f.birthday} onChange={set("birthday")} /></Line>
          <Line label="Moved In" id="pc-start"><input id="pc-start" type="date" value={f.startDate} onChange={set("startDate")} title="Optional: when they moved in or started here" /></Line>
          <Line label="Notes" id="pc-notes"><textarea id="pc-notes" rows={2} maxLength={1000} value={f.notes} onChange={set("notes")} placeholder="Works nights, text first. The crew sees this on the work order." /></Line>
        </div>
        <div className="contact-notify">
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Receive service notifications for this property</label>
          <div className="muted" style={{ fontSize: 13 }}>
            {notify
              ? how ? `They'll hear when a visit here is scheduled or moved, and after a chemical application: ${how}.` : "Enter an email address or a phone number so they can be reached."
              : "When ticked, they hear when a visit here is scheduled or moved, and after a chemical application. They never get invoices."}
          </div>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy || !named || !!formProblem || (notify && !how)}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" className="btn" onClick={() => onDone(false)}>Cancel</button>
          {!named && <span className="muted" style={{ fontSize: 13 }}>Enter a first or last name.</span>}
        </div>
      </form>
    </div>
  );
}

/** One contact in the People list: who they are, how to reach them, and Change / Moved out / Delete. */
export function ContactRow({ propertyId, contact: c, canEdit, onChanged }: { propertyId: string; contact: PropertyContact; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const numbers = [...CONTACT_PHONES.map(([k, label]) => [label, c[k]] as const), ["Fax", c.fax] as const].filter(([, v]) => v);
  const how = c.notify ? notifyHow(c) : null;
  return (
    <li>
      <span className="badge">{c.relation}</span>{" "}
      <strong>{contactName(c) || c.name}</strong>{c.nickname && c.nickname !== c.name && <span className="muted"> “{c.nickname}”</span>}{c.startDate && <span className="muted"> since {fmtDate(c.startDate)}</span>}
      {c.notify && <> <span className="badge ok" title={`Gets this property's service notifications${how ? ` ${how}` : ""}: when a visit is scheduled or moved, and after a chemical application`}>Service notifications</span></>}
      <div className="muted">
        {numbers.map(([label, v], i) => <span key={label}>{i > 0 && " · "}{label} {label === "Fax" ? formatPhone(v!) : <a href={`tel:${v}`}>{formatPhone(v!)}</a>}</span>)}
        {numbers.length > 0 && c.email && " · "}{c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
        {!numbers.length && !c.email && "No phone or email yet"}
      </div>
      {(c.formOfContact || c.birthday || how) && (
        <div className="muted">
          {[c.formOfContact && `Prefers: ${FORM_OF_CONTACT_LABELS[c.formOfContact].toLowerCase()}`, c.birthday && `Birthday: ${birthdayText(c.birthday)}`, how && `Notified ${how}`].filter(Boolean).join(" · ")}
        </div>
      )}
      {c.notes && <div style={{ whiteSpace: "pre-wrap" }}>{c.notes}</div>}
      {canEdit && (
        <div className="row" style={{ marginTop: 4 }}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>Change</button>
          <button type="button" className="btn" disabled={act.busy} title="They no longer live or work here. They stay in the property's history and stop getting its notifications." onClick={() => confirm(`${c.name} is no longer at this property?`) && act.run(async () => {
            await api(`/properties/${propertyId}/contacts/${c.id}/end`, { body: {} }); onChanged();
          })}>Moved out</button>
          <button type="button" className="btn" disabled={act.busy} title="Remove a contact added by mistake. Use Moved out to keep them in the history." onClick={() => confirm(`Delete ${c.name} from this property? Use Moved out instead to keep them in its history.`) && act.run(async () => {
            await api(`/properties/${propertyId}/contacts/${c.id}`, { method: "DELETE" }); onChanged();
          })}>Delete</button>
        </div>
      )}
      <ErrorBox error={act.error} />
      {editing && <ContactForm propertyId={propertyId} contact={c} onDone={(saved) => { setEditing(false); if (saved) onChanged(); }} />}
    </li>
  );
}

/** A past contact in the history: who, when, and Bring back. */
export function PastContact({ propertyId, contact: c, canEdit, onChanged }: { propertyId: string; contact: PropertyContact; canEdit: boolean; onChanged: () => void }) {
  const act = useAction();
  return (
    <li className="muted">
      {c.relation}: {c.name} · {c.startDate ? `${fmtDate(c.startDate)} – ` : "until "}{fmtDate(c.endDate)}{c.phone ? ` · ${formatPhone(c.phone)}` : ""}
      {canEdit && <> <button type="button" className="linkbtn" disabled={act.busy} title="Put them back on the property as a current contact" onClick={() => act.run(async () => { await api(`/properties/${propertyId}/contacts/${c.id}/end`, { body: { back: true } }); onChanged(); })}>Bring back</button></>}
      <ErrorBox error={act.error} />
    </li>
  );
}
