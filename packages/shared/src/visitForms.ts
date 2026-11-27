import { z } from "zod";
import { designId } from "./emailDesign";

/**
 * Resources → Visit Forms, like Homeworks: a form the crew fills in on a work order (a service
 * checklist, a quality check, notes on conditions), built from sections of short text, long text,
 * checkbox and dropdown questions, with a signature box if wanted. A form is picked on the work
 * orders it's for (or attached to every new one), each work order gets its own copy, and the
 * crew submits it from the work order.
 */

/** Homeworks' four (short text, long text, checkbox, dropdown), then Crewdesk's own. */
export const FORM_FIELD_TYPES = ["text", "textarea", "checkbox", "dropdown", "yesno", "number", "date", "photo", "signature"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
/** Homeworks' names for its four, as its builder's "Add:" row has them. */
export const FORM_FIELD_LABELS: Record<FormFieldType, string> = {
  text: "Short Text Field", textarea: "Long Text Field", checkbox: "CheckBox", dropdown: "DropDown",
  yesno: "Yes / No", number: "Number", date: "Date", photo: "Photo", signature: "Signature",
};
/** What each kind's label box asks for in the builder (Homeworks' wording for its four). */
export const FORM_FIELD_HINTS: Record<FormFieldType, string> = {
  text: "Question", textarea: "Long Question", checkbox: "Checkbox section name", dropdown: "Ask Question",
  yesno: "Yes / No question", number: "Number question", date: "Date question", photo: "What to photograph", signature: "Who signs (for example Customer signature)",
};
/** Questions answered by picking from choices (each choice can raise a flag for the office). */
export const hasChoices = (t: FormFieldType) => t === "checkbox" || t === "dropdown" || t === "yesno";
export const YES_NO: { id: "yes" | "no"; label: string }[] = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
/** Photos one question can take. */
export const FORM_PHOTOS_MAX = 12;

export const FORM_NAME_MAX = 150;
export const FORM_LABEL_MAX = 300;
export const FORM_SECTIONS_MAX = 30;
export const FORM_FIELDS_MAX = 60;
export const FORM_OPTIONS_MAX = 60;
/** Forms on one work order. */
export const VISIT_FORMS_MAX = 20;

/**
 * One choice. Picking it can raise a flag for the office: `tagId` puts that tag on the customer
 * and the work order (so a "tag added" automation can follow), `todo` makes an office to-do.
 */
export interface FormOption { id: string; label: string; tagId?: string | null; todo?: boolean }
export interface FormField { id: string; type: FormFieldType; label: string; options: FormOption[]; required?: boolean }
export interface FormSection { id: string; name: string; fields: FormField[] }
/**
 * What a form asks: its sections, and whether it ends with a signature (under that label).
 * `mustSubmit`: the work order can't be marked Completed until this form is in.
 * `emailCopy`: the customer is emailed a copy (a PDF) once the work order is completed.
 */
export interface FormDef {
  sections: FormSection[]; signature: boolean; signatureLabel: string;
  signatureRequired?: boolean; mustSubmit?: boolean; emailCopy?: boolean;
}

/** A signature as it was drawn: the box it was drawn in, and its strokes as "M x y L x y …". */
export interface FormSignature { w: number; h: number; d: string }
/**
 * One answer: the words, number or date typed, the option picked ("yes" / "no" for a yes-no
 * question); for checkboxes the ids of the ones ticked; for a photo question the ids of its photos
 * (they're among the work order's photos).
 */
export type FormAnswer = string | string[];
export type FormAnswers = Record<string, FormAnswer>;
/** The signatures on signature questions, by question. */
export type FormSignatures = Record<string, FormSignature>;
/** One thing that changed when a submitted form was updated. */
export interface FormChange { label: string; from: string; to: string }

/** Homeworks refuses HTML anywhere in a form, with this message. */
export const FORM_HTML_MESSAGE = "HTML is not allowed in Visit Form. Please remove any HTML before submitting.";
export const containsHtml = (s: string) => /<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/i.test(s);

const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const plain = (max: number) => z.string().trim().max(max).refine((s) => !containsHtml(s), FORM_HTML_MESSAGE);
const optionSchema = z.object({
  id: key, label: plain(FORM_LABEL_MAX),
  tagId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable()).optional(), todo: z.boolean().optional(),
});
const fieldSchema = z.object({
  id: key, type: z.enum(FORM_FIELD_TYPES), label: plain(FORM_LABEL_MAX),
  options: z.array(optionSchema).max(FORM_OPTIONS_MAX).default([]),
  required: z.boolean().optional(),
});
const sectionSchema = z.object({ id: key, name: plain(FORM_LABEL_MAX).default(""), fields: z.array(fieldSchema).max(FORM_FIELDS_MAX).default([]) });

export const formDefSchema = z.object({
  sections: z.array(sectionSchema).max(FORM_SECTIONS_MAX).default([]),
  signature: z.boolean().default(false),
  signatureLabel: plain(FORM_LABEL_MAX).default("Signature"),
  signatureRequired: z.boolean().optional(),
  mustSubmit: z.boolean().optional(),
  emailCopy: z.boolean().optional(),
});

export const visitFormSchema = z.object({
  name: z.string().trim().min(1, "Please enter a form name").max(FORM_NAME_MAX).refine((s) => !containsHtml(s), FORM_HTML_MESSAGE),
  def: formDefSchema,
  /** Homeworks' "Automatically attach to New Visit event". */
  autoAttach: z.boolean().default(false),
  /** Price-list services: a new work order with any of them gets this form. */
  serviceTypeIds: z.array(z.string().uuid()).max(200).default([]),
}).superRefine((f, ctx) => {
  const def = cleanFormDef(f.def);
  if (!def.signature && !def.sections.some((s) => s.fields.length)) ctx.addIssue({ code: "custom", path: ["def"], message: "Add at least one field to the form" });
  // Sections and questions each have their own id; a question's choices differ from each other.
  const ids = [...def.sections.map((s) => s.id), ...def.sections.flatMap((s) => s.fields.map((x) => x.id))];
  const twice = new Set(ids).size !== ids.length || formFields(def).some((x) => new Set(x.options.map((o) => o.id)).size !== x.options.length);
  if (twice) ctx.addIssue({ code: "custom", path: ["def"], message: "Two parts of this form share an id; add them again" });
});
export type VisitFormInput = z.infer<typeof visitFormSchema>;

export const newFormOption = (label = ""): FormOption => ({ id: designId(), label });
export const newFormField = (type: FormFieldType): FormField => ({
  id: designId(), type, label: "",
  options: type === "yesno" ? YES_NO.map((o) => ({ ...o })) : type === "checkbox" || type === "dropdown" ? [newFormOption()] : [],
});
export const newFormSection = (): FormSection => ({ id: designId(), name: "", fields: [] });
/** A new form, as Homeworks starts one: a single empty section. */
export const emptyFormDef = (): FormDef => ({ sections: [newFormSection()], signature: false, signatureLabel: "Signature" });

/**
 * A form as it's kept: questions left without a label, options left empty and sections left with
 * nothing in them are dropped; text questions carry no options.
 */
export function cleanFormDef(def: FormDef): FormDef {
  const flags = (o: FormOption) => ({ ...(o.tagId ? { tagId: o.tagId } : {}), ...(o.todo ? { todo: true } : {}) });
  const options = (f: FormField): FormOption[] =>
    f.type === "yesno" ? YES_NO.map((yn) => ({ ...yn, ...flags(f.options.find((o) => o.id === yn.id) ?? yn) }))
    : hasChoices(f.type) ? f.options.map((o) => ({ id: o.id, label: o.label.trim(), ...flags(o) })).filter((o) => o.label) : [];
  const sections = def.sections.map((s) => ({
    id: s.id, name: s.name.trim(),
    fields: s.fields.map((f) => ({ id: f.id, type: f.type, label: f.label.trim(), options: options(f), ...(f.required ? { required: true } : {}) }))
      // A yes-no question always has its two choices, so it needs its question to count.
      .filter((f) => f.label || (f.type !== "yesno" && f.options.length)),
  })).filter((s) => s.name || s.fields.length);
  return {
    sections, signature: !!def.signature, signatureLabel: def.signatureLabel?.trim() || "Signature",
    ...(def.signature && def.signatureRequired ? { signatureRequired: true } : {}), ...(def.mustSubmit ? { mustSubmit: true } : {}), ...(def.emailCopy ? { emailCopy: true } : {}),
  };
}

export const formFields = (def: FormDef) => def.sections.flatMap((s) => s.fields);
export const formFieldCount = (def: FormDef) => formFields(def).length + (def.signature ? 1 : 0);
/** The tags a form's flags use (to check they're the company's). */
export const formTagIds = (def: FormDef) => [...new Set(formFields(def).flatMap((f) => f.options.map((o) => o.tagId).filter((t): t is string => !!t)))];

/** A signature's strokes: only moves and lines, in numbers (nothing else can ride along). */
export const signatureSchema = z.object({
  w: z.number().min(20).max(4000), h: z.number().min(20).max(4000),
  d: z.string().max(120_000).regex(/^(?:[ML] ?-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? ?)*$/, "That signature can't be read; clear it and sign again"),
});
/** Strokes (each a run of points) as the path a signature is kept as; a tap leaves a dot. */
export function signaturePath(strokes: { x: number; y: number }[][]): string {
  const n = (v: number) => String(Math.round(v * 10) / 10);
  return strokes.filter((s) => s.length).map((s) => {
    const pts = s.length === 1 ? [s[0], { x: s[0].x + 0.6, y: s[0].y + 0.6 }] : s;
    return pts.map((p, i) => `${i ? "L" : "M"}${n(p.x)} ${n(p.y)}`).join(" ");
  }).join(" ");
}
/** The strokes back from a kept path (the phone draws them as dots; it has no SVG). */
export function signatureStrokes(d: string): { x: number; y: number }[][] {
  const strokes: { x: number; y: number }[][] = [];
  for (const m of d.matchAll(/([ML]) ?(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) {
    if (m[1] === "M") strokes.push([]);
    strokes[strokes.length - 1]?.push({ x: Number(m[2]), y: Number(m[3]) });
  }
  return strokes;
}
export const isSigned = (s: FormSignature | null | undefined): s is FormSignature => !!s && s.d.trim().length > 0;

export const formAnswersSchema = z.object({
  answers: z.record(key, z.union([z.string().max(10_000), z.array(key).max(FORM_OPTIONS_MAX)])).default({}),
  signature: signatureSchema.nullable().optional(),
  /** The signatures on signature questions, by question. */
  signatures: z.record(key, signatureSchema.nullable()).default({}),
});
export type FormAnswersInput = z.infer<typeof formAnswersSchema>;

const isNumber = (s: string) => /^-?\d{1,12}(\.\d{1,6})?$/.test(s);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Answers checked against the form they're for: questions that aren't on it are dropped, a
 * dropdown's answer must be one of its options, ticks must be its own checkboxes, a number must
 * be a number and a date a date. With `photoIds`, a photo answer keeps only those photos (the
 * work order's own).
 */
export function cleanFormAnswers(def: FormDef, answers: FormAnswers, photoIds?: Set<string>): FormAnswers {
  const out: FormAnswers = {};
  for (const f of formFields(def)) {
    const a = answers[f.id];
    if (f.type === "signature") continue;
    if (f.type === "checkbox") {
      const ticked = (Array.isArray(a) ? a : []).filter((id) => f.options.some((o) => o.id === id));
      if (ticked.length) out[f.id] = [...new Set(ticked)];
    } else if (f.type === "photo") {
      const photos = [...new Set(Array.isArray(a) ? a : [])].filter((id) => !photoIds || photoIds.has(id)).slice(0, FORM_PHOTOS_MAX);
      if (photos.length) out[f.id] = photos;
    } else if (f.type === "dropdown" || f.type === "yesno") {
      if (typeof a === "string" && f.options.some((o) => o.id === a)) out[f.id] = a;
    } else if (typeof a === "string" && a.trim()) {
      const t = a.trim();
      if (f.type === "number" ? isNumber(t.replace(/,/g, "")) : f.type === "date" ? isDay(t) : true) out[f.id] = f.type === "number" ? t.replace(/,/g, "") : t;
    }
  }
  return out;
}
/** The signatures that belong to the form's signature questions (and are really signed). */
export function cleanFormSignatures(def: FormDef, signatures: Record<string, FormSignature | null | undefined>): FormSignatures {
  const out: FormSignatures = {};
  for (const f of formFields(def)) { const s = signatures[f.id]; if (f.type === "signature" && isSigned(s)) out[f.id] = s; }
  return out;
}

const answered = (f: FormField, a: FormAnswer | undefined, sig: FormSignature | null | undefined) =>
  f.type === "signature" ? isSigned(sig) : Array.isArray(a) ? a.length > 0 : typeof a === "string" && a.trim().length > 0;
/** The required questions still unanswered (their labels), to say what's missing. */
export function missingRequired(def: FormDef, answers: FormAnswers, signature: FormSignature | null | undefined, signatures: Record<string, FormSignature | null | undefined> = {}): string[] {
  const missing = formFields(def).filter((f) => f.required && !answered(f, answers[f.id], signatures[f.id])).map((f) => f.label || FORM_FIELD_LABELS[f.type]);
  if (def.signature && def.signatureRequired && !isSigned(signature)) missing.push(def.signatureLabel || "Signature");
  return missing;
}

const dayText = (d: string) => (isDay(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : d);
/** An answer in words: what was typed, the option picked, the boxes ticked, or how many photos. */
export function formAnswerText(f: FormField, a: FormAnswer | undefined, sig?: FormSignature | null): string {
  if (f.type === "signature") return isSigned(sig) ? "Signed" : "";
  if (f.type === "checkbox") return (Array.isArray(a) ? a : []).map((id) => f.options.find((o) => o.id === id)?.label).filter(Boolean).join(", ");
  if (f.type === "photo") { const n = Array.isArray(a) ? a.length : 0; return n ? `${n} photo${n === 1 ? "" : "s"}` : ""; }
  if (f.type === "dropdown" || f.type === "yesno") return f.options.find((o) => o.id === a)?.label ?? "";
  if (f.type === "date") return typeof a === "string" ? dayText(a) : "";
  return typeof a === "string" ? a : "";
}

/** A submitted form as rows to read or print: each section's questions with their answers. */
export function formAnswerRows(def: FormDef, answers: FormAnswers | null | undefined, signatures: FormSignatures | null | undefined = {}): {
  section: string;
  rows: { id: string; label: string; value: string; type: FormFieldType; required: boolean; options?: { label: string; ticked: boolean }[]; photos?: string[]; signature?: FormSignature | null }[];
}[] {
  return def.sections.map((s) => ({
    section: s.name,
    rows: s.fields.map((f) => ({
      id: f.id, label: f.label, type: f.type, required: !!f.required, value: formAnswerText(f, answers?.[f.id], signatures?.[f.id]),
      ...(f.type === "checkbox" ? { options: f.options.map((o) => ({ label: o.label, ticked: Array.isArray(answers?.[f.id]) && (answers![f.id] as string[]).includes(o.id) })) } : {}),
      ...(f.type === "photo" ? { photos: Array.isArray(answers?.[f.id]) ? (answers![f.id] as string[]) : [] } : {}),
      ...(f.type === "signature" ? { signature: signatures?.[f.id] ?? null } : {}),
    })),
  }));
}

/** What changed between two versions of a submitted form, in words (for its history). */
export function formChanges(def: FormDef, before: { answers: FormAnswers; signature?: FormSignature | null; signatures?: FormSignatures | null }, after: { answers: FormAnswers; signature?: FormSignature | null; signatures?: FormSignatures | null }): FormChange[] {
  const out: FormChange[] = [];
  const sig = (s: FormSignature | null | undefined) => (isSigned(s) ? s.d : "");
  for (const f of formFields(def)) {
    if (f.type === "signature") {
      const a = sig(before.signatures?.[f.id]), b = sig(after.signatures?.[f.id]);
      if (a !== b) out.push({ label: f.label || "Signature", from: a ? "Signed" : "", to: b ? (a ? "Signed again" : "Signed") : "" });
      continue;
    }
    const a = formAnswerText(f, before.answers[f.id]), b = formAnswerText(f, after.answers[f.id]);
    const same = f.type === "photo" ? JSON.stringify([...(before.answers[f.id] ?? [])].sort()) === JSON.stringify([...(after.answers[f.id] ?? [])].sort()) : a === b;
    if (!same) out.push({ label: f.label || FORM_FIELD_LABELS[f.type], from: a, to: b });
  }
  if (def.signature && sig(before.signature) !== sig(after.signature)) {
    out.push({ label: def.signatureLabel || "Signature", from: sig(before.signature) ? "Signed" : "", to: sig(after.signature) ? (sig(before.signature) ? "Signed again" : "Signed") : "" });
  }
  return out;
}

/** The picked choices that raise a flag for the office (a tag, a to-do, or both). */
export function flaggedAnswers(def: FormDef, answers: FormAnswers): { optionId: string; question: string; answer: string; tagId: string | null; todo: boolean }[] {
  const out: { optionId: string; question: string; answer: string; tagId: string | null; todo: boolean }[] = [];
  for (const f of formFields(def)) {
    if (!hasChoices(f.type)) continue;
    const a = answers[f.id];
    const picked = Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
    for (const o of f.options) if (picked.includes(o.id) && (o.tagId || o.todo)) out.push({ optionId: `${f.id}:${o.id}`, question: f.label, answer: o.label, tagId: o.tagId ?? null, todo: !!o.todo });
  }
  return out;
}
export const formHasFlags = (def: FormDef) => formFields(def).some((f) => f.options.some((o) => o.tagId || o.todo));

/** A copy's name, as copies are named elsewhere in Crewdesk ("Copy - Lawn Checklist"). */
export const formCopyName = (name: string, taken: string[]) => {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  let next = `Copy - ${name}`.slice(0, FORM_NAME_MAX);
  for (let n = 2; lower.has(next.toLowerCase()); n++) next = `Copy ${n} - ${name}`.slice(0, FORM_NAME_MAX);
  return next;
};
