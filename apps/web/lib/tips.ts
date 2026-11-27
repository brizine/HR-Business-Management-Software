import { TIPS_BY_CLASS, TIPS_BY_LABEL, TIPS_BY_PAGE, TIPS_BY_PATTERN, TIPS_NAV, TIPS_TABS } from "./tip-words";

/**
 * Hover descriptions: point at a button anywhere in Crewdesk and a short line says what it does.
 * A button's description comes from the first of these that has one:
 *   1. the button itself (`title` or `data-tip` in the code): the most specific;
 *   2. the kind of control it is: a page in the menu (TIPS_NAV), a tab that is a link to another
 *      page or view (TIPS_TABS, by where it goes), a column heading that sorts, a label that fits
 *      a pattern (TIPS_BY_PATTERN: "…: on or off"), a known class (TIPS_BY_CLASS: a to-do's row,
 *      a tag, a column to add);
 *   3. the page's own list (TIPS_BY_PAGE, by the first part of the address: "dispatch", "customers"…);
 *   4. the list for a label wherever it appears (TIPS_BY_LABEL: "Save", "Export"…);
 *   5. for plain action buttons only, the rules below, which read the label ("Add customer",
 *      "Delete view"…) and say it in a sentence. Rows of data never get these: a template called
 *      "New invoice" is not a button that adds an invoice.
 * The lists are in tip-words.ts. To describe a button better, give it a `title`, or add its label there.
 */

/** What the page knows about a button, gathered by components/tips.tsx. */
export type TipFacts = {
  /** The words on it, its `aria-label`, and anything written for it (`title` / `data-tip`). */
  text: string; aria: string; written: string;
  /** Its classes, and the page's address. */
  classes: string[]; path: string;
  /** A page in the left menu or the Operations | Team switch; a column heading that sorts; a plain action button. */
  nav: boolean; sort: boolean; action: boolean;
  /** A tab in a strip of links (Customers | Properties | Bulk emails), and where a link goes. */
  tab?: boolean; href?: string;
};

/** A button's label as the lists spell it: lower case, numbers as "#", no arrows, dots or counts on the ends. */
export function tipLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim()
    .replace(/\d[\d,./:%]*/g, "#")
    .replace(/^[^\p{L}\p{N}#]+/u, "").replace(/[^\p{L}\p{N}#)]+$/u, "")
    .replace(/\s*[(]?#[)]?$/, "")
    .toLowerCase().slice(0, 80);
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+ [A-Z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
/** "customer" → "a new customer"; "an invoice" stays; plurals and "the …" are left alone. */
const aNew = (thing: string) => {
  const t = lower(thing.replace(/^(a|an|the|new)\s+/i, ""));
  return /s$/.test(t) && !/ss$/.test(t) ? `new ${t}` : `a new ${t}`;
};
// "the view", but "line 1", "all customers" and "your changes" as they are.
const the = (thing: string) => (/^(the|this|that|these|those|all|every|my|your|a|an|it|them|#|\d)\b/i.test(thing) || /\d$/.test(thing) ? lower(thing) : `the ${lower(thing)}`);

/**
 * What a label says, as a sentence, for action buttons nobody has described. Only the verbs that
 * turn into a sentence reliably; anything else needs its own words in tip-words.ts.
 */
const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(?:add|new|create) (.+)$/i, (m) => `Add ${aNew(m[1])}`],
  [/^save (.+)$/i, (m) => `Save ${the(m[1])}`],
  [/^edit (.+)$/i, (m) => `Change ${the(m[1])}`],
  [/^delete (.+)$/i, (m) => `Delete ${the(m[1])} for good`],
  [/^remove (.+)$/i, (m) => `Take ${the(m[1])} off`],
  [/^export (.+)$/i, (m) => `Download ${the(m[1])} as a file`],
  [/^download (.+)$/i, (m) => `Save ${the(m[1])} to your computer`],
  [/^print (.+)$/i, (m) => `Print ${the(m[1])}`],
  [/^copy (.+)$/i, (m) => `Copy ${the(m[1])}`],
  [/^clear (.+)$/i, (m) => `Clear ${the(m[1])}`],
  [/^back to (.+)$/i, (m) => `Go back to ${m[1]}`],
];
/** A label the rules can be trusted with: a few plain words, nothing dressed up. */
const plainLabel = (label: string) => label.split(" ").length <= 5 && !/[:(){}\[\]/|·•]|\d{3,}/.test(label);

/** The page lists a button could be in, nearest first: "/settings/company-info" → "settings/company-info", "settings". */
const pageKeys = (path: string) => {
  const parts = path.split("?")[0].split("/").filter(Boolean).filter((p) => !/^[0-9a-f-]{20,}$/i.test(p) && !/^\d+$/.test(p));
  return [parts.slice(0, 2).join("/"), parts[0] ?? ""].filter((k, i, all) => k && all.indexOf(k) === i);
};
/** Where a link goes, as TIPS_TABS spells it: the page, and which of its tabs ("/automations?tab=review"). */
export function tabKey(href: string): string {
  const [path, query = ""] = href.replace(/^https?:\/\/[^/]+/, "").split("#")[0].split("?");
  const tab = new URLSearchParams(query).get("tab");
  const page = path.split("/").map((p) => (/^[0-9a-f-]{20,}$/i.test(p) || /^\d+$/.test(p) ? ":id" : p)).join("/").replace(/\/$/, "") || "/";
  return tab ? `${page}?tab=${tab}` : page;
}
const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, "") === b.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The description for a button from the lists alone (no rules, no fall-backs): its page's list, a pattern, then the label list. */
export function listedTip(rawLabel: string, path: string): string | null {
  const label = tipLabel(rawLabel);
  if (!label) return null;
  for (const page of pageKeys(path)) {
    const tip = TIPS_BY_PAGE[page]?.[label];
    if (tip) return tip;
  }
  return patternTip(rawLabel) ?? TIPS_BY_LABEL[label] ?? null;
}
/** The description for a label that follows a known pattern ("…: on or off"). */
export function patternTip(rawLabel: string): string | null {
  const label = tipLabel(rawLabel);
  for (const [pattern, tip] of TIPS_BY_PATTERN) if (pattern.test(label)) return tip;
  return null;
}

const tidy = (label: string) => label.replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}#]+/u, "").replace(/[^\p{L}\p{N})]+$/u, "");

/**
 * The description to show for a button, or null when there is nothing to add to what it says.
 */
export function describe(f: TipFacts): string | null {
  const useful = (tip: string | null | undefined) => (tip && !same(tip, f.text) ? tip : null);
  // Something written for this very button wins.
  if (useful(f.written)) return f.written;
  const names = [...new Set([f.aria, f.text].filter(Boolean))];
  // The menu's pages have their own list, so a tab that shares a page's name isn't described as that page.
  if (f.nav) return useful(names.map((n) => TIPS_NAV[tipLabel(n)]).find(Boolean));
  // A tab that is a link is described by where it goes: its name is often on something else on the
  // page too (the Customers tab, and the Customers chip that filters the list).
  if (f.tab) return useful(TIPS_TABS[tabKey(f.href ?? "")] ?? names.map((n) => TIPS_NAV[tipLabel(n)]).find(Boolean));
  // What kind of control it is comes before what it says: a column heading called "Customer"
  // sorts by customer, whatever a button called "Customer" does on the same page.
  if (f.sort && f.text) return `Sort by ${lower(tidy(f.text)) || "this column"}; click again to turn the order around`;
  for (const name of names) { const tip = useful(patternTip(name)); if (tip) return tip; }
  for (const c of f.classes) if (TIPS_BY_CLASS[c]) return TIPS_BY_CLASS[c];
  for (const name of names) {
    const tip = useful(listedTip(name, f.path));
    if (tip) return tip;
  }
  if (f.action) {
    for (const name of names) {
      const clean = tidy(name);
      if (!plainLabel(clean)) continue;
      for (const [pattern, say] of RULES) {
        const m = clean.match(pattern);
        if (m) { const tip = useful(say(m)); if (tip && !same(tip, clean)) return tip; break; }
      }
    }
  }
  // A button that is only a picture at least says its name.
  if (f.aria && (!f.text || f.text.length <= 2) && !same(f.aria, f.text)) return f.aria;
  return null;
}
