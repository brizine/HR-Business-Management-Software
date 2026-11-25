import { z } from "zod";
import { designId } from "./emailDesign";

/**
 * Marketing → Visit Forms, like Homeworks: a form the crew fills in on a work order (a service
 * checklist, a quality check, notes on conditions), built from sections of short text, long text,
 * checkbox and dropdown questions, with a signature box if wanted. A form is picked on the work
 * orders it's for (or attached to every new one), each work order gets its own copy, and the
 * crew submits it from the work order.
 */

export const FORM_FIELD_TYPES = ["text", "textarea", "checkbox", "dropdown"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
/** Homeworks' names for them, as its builder's "Add:" row has them. */
export const FORM_FIELD_LABELS: Record<FormFieldType, string> = { text: "Short Text Field", textarea: "Long Text Field", checkbox: "CheckBox", dropdown: "DropDown" };
/** What each kind's label box asks for in the builder (Homeworks' wording). */
export const FORM_FIELD_HINTS: Record<FormFieldType, string> = { text: "Question", textarea: "Long Question", checkbox: "Checkbox section name", dropdown: "Ask Question" };

export const FORM_NAME_MAX = 150;
export const FORM_LABEL_MAX = 300;
export const FORM_SECTIONS_MAX = 30;
export const FORM_FIELDS_MAX = 60;
export const FORM_OPTIONS_MAX = 60;
/** Forms on one work order. */
export const VISIT_FORMS_MAX = 20;

export interface FormOption { id: string; label: string }
export interface FormField { id: string; type: FormFieldType; label: string; options: FormOption[] }
export interface FormSection { id: string; name: string; fields: FormField[] }
/** What a form asks: its sections, and whether it ends with a signature (under that label). */
export interface FormDef { sections: FormSection[]; signature: boolean; signatureLabel: string }

/** A signature as it was drawn: the box it was drawn in, and its strokes as "M x y L x y …". */
export interface FormSignature { w: number; h: number; d: string }
/** One answer: the words typed or the option picked; for checkboxes, the ids of the ones ticked. */
export type FormAnswer = string | string[];
export type FormAnswers = Record<string, FormAnswer>;

/** Homeworks refuses HTML anywhere in a form, with this message. */
export const FORM_HTML_MESSAGE = "HTML is not allowed in Visit Form. Please remove any HTML before submitting.";
export const containsHtml = (s: string) => /<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/i.test(s);

const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const plain = (max: number) => z.string().trim().max(max).refine((s) => !containsHtml(s), FORM_HTML_MESSAGE);
const optionSchema = z.object({ id: key, label: plain(FORM_LABEL_MAX) });
const fieldSchema = z.object({
  id: key, type: z.enum(FORM_FIELD_TYPES), label: plain(FORM_LABEL_MAX),
  options: z.array(optionSchema).max(FORM_OPTIONS_MAX).default([]),
});
const sectionSchema = z.object({ id: key, name: plain(FORM_LABEL_MAX).default(""), fields: z.array(fieldSchema).max(FORM_FIELDS_MAX).default([]) });

export const formDefSchema = z.object({
  sections: z.array(sectionSchema).max(FORM_SECTIONS_MAX).default([]),
  signature: z.boolean().default(false),
  signatureLabel: plain(FORM_LABEL_MAX).default("Signature"),
});

export const visitFormSchema = z.object({
  name: z.string().trim().min(1, "Please enter a form name").max(FORM_NAME_MAX).refine((s) => !containsHtml(s), FORM_HTML_MESSAGE),
  def: formDefSchema,
  /** Homeworks' "Automatically attach to New Visit event". */
  autoAttach: z.boolean().default(false),
}).superRefine((f, ctx) => {
  const def = cleanFormDef(f.def);
  if (!def.signature && !def.sections.some((s) => s.fields.length)) ctx.addIssue({ code: "custom", path: ["def"], message: "Add at least one field to the form" });
  const ids = [...def.sections.map((s) => s.id), ...def.sections.flatMap((s) => s.fields.flatMap((x) => [x.id, ...x.options.map((o) => o.id)]))];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["def"], message: "Two parts of this form share an id; add them again" });
});
export type VisitFormInput = z.infer<typeof visitFormSchema>;

export const newFormOption = (label = ""): FormOption => ({ id: designId(), label });
export const newFormField = (type: FormFieldType): FormField => ({ id: designId(), type, label: "", options: type === "checkbox" || type === "dropdown" ? [newFormOption()] : [] });
export const newFormSection = (): FormSection => ({ id: designId(), name: "", fields: [] });
/** A new form, as Homeworks starts one: a single empty section. */
export const emptyFormDef = (): FormDef => ({ sections: [newFormSection()], signature: false, signatureLabel: "Signature" });

/**
 * A form as it's kept: questions left without a label, options left empty and sections left with
 * nothing in them are dropped; text questions carry no options.
 */
export function cleanFormDef(def: FormDef): FormDef {
  const sections = def.sections.map((s) => ({
    id: s.id, name: s.name.trim(),
    fields: s.fields.map((f) => ({
      id: f.id, type: f.type, label: f.label.trim(),
      options: f.type === "checkbox" || f.type === "dropdown" ? f.options.map((o) => ({ id: o.id, label: o.label.trim() })).filter((o) => o.label) : [],
    })).filter((f) => f.label || f.options.length),
  })).filter((s) => s.name || s.fields.length);
  return { sections, signature: !!def.signature, signatureLabel: def.signatureLabel?.trim() || "Signature" };
}

export const formFields = (def: FormDef) => def.sections.flatMap((s) => s.fields);
export const formFieldCount = (def: FormDef) => formFields(def).length + (def.signature ? 1 : 0);

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
});
export type FormAnswersInput = z.infer<typeof formAnswersSchema>;

/**
 * Answers checked against the form they're for: questions that aren't on it are dropped, a
 * dropdown's answer must be one of its options, and ticks must be its own checkboxes.
 */
export function cleanFormAnswers(def: FormDef, answers: FormAnswers): FormAnswers {
  const out: FormAnswers = {};
  for (const f of formFields(def)) {
    const a = answers[f.id];
    if (f.type === "checkbox") {
      const ticked = (Array.isArray(a) ? a : []).filter((id) => f.options.some((o) => o.id === id));
      if (ticked.length) out[f.id] = [...new Set(ticked)];
    } else if (f.type === "dropdown") {
      if (typeof a === "string" && f.options.some((o) => o.id === a)) out[f.id] = a;
    } else if (typeof a === "string" && a.trim()) out[f.id] = a.trim();
  }
  return out;
}

/** An answer in words: what was typed, the option picked, or the boxes ticked. */
export function formAnswerText(f: FormField, a: FormAnswer | undefined): string {
  if (f.type === "checkbox") return (Array.isArray(a) ? a : []).map((id) => f.options.find((o) => o.id === id)?.label).filter(Boolean).join(", ");
  if (f.type === "dropdown") return f.options.find((o) => o.id === a)?.label ?? "";
  return typeof a === "string" ? a : "";
}

/** A submitted form as rows to read or print: each section's questions with their answers. */
export function formAnswerRows(def: FormDef, answers: FormAnswers | null | undefined): { section: string; rows: { label: string; value: string; type: FormFieldType; options?: { label: string; ticked: boolean }[] }[] }[] {
  return def.sections.map((s) => ({
    section: s.name,
    rows: s.fields.map((f) => ({
      label: f.label, type: f.type, value: formAnswerText(f, answers?.[f.id]),
      ...(f.type === "checkbox" ? { options: f.options.map((o) => ({ label: o.label, ticked: Array.isArray(answers?.[f.id]) && (answers![f.id] as string[]).includes(o.id) })) } : {}),
    })),
  }));
}

/** A copy's name, as copies are named elsewhere in Crewdesk ("Copy - Lawn Checklist"). */
export const formCopyName = (name: string, taken: string[]) => {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  let next = `Copy - ${name}`.slice(0, FORM_NAME_MAX);
  for (let n = 2; lower.has(next.toLowerCase()); n++) next = `Copy ${n} - ${name}`.slice(0, FORM_NAME_MAX);
  return next;
};
