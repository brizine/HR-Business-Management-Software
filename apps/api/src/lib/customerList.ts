import { sql, type SQL } from "drizzle-orm";
import { filterField, type CustomerFilter } from "@crewdesk/shared";

/**
 * SQL for the Customers list: the worked-out columns (balance, credit, last and next service…) and
 * each filter rule. Values are always bound as parameters; field keys come from a fixed list.
 */

// Written out: inside a correlated subquery the outer table needs its full name.
const C = sql.raw(`"customers"."id"`);
const firstProp = (col: string) => sql.raw(`(select p.${col} from property_assignments pa join properties p on p.id = pa.property_id
  where pa.customer_id = "customers"."id" and pa.end_date is null order by pa.role, pa.created_at limit 1)`);

export function listColumns(today: string, yearStart: string) {
  return {
    properties: sql<number>`(select count(*)::int from property_assignments pa where pa.customer_id = ${C} and pa.end_date is null)`,
    address: sql<string | null>`(select p.street || coalesce(', ' || p.city, '') from property_assignments pa join properties p on p.id = pa.property_id
      where pa.customer_id = ${C} and pa.end_date is null order by pa.role, pa.created_at limit 1)`,
    city: sql<string | null>`${firstProp("city")}`,
    zip: sql<string | null>`${firstProp("zip")}`,
    balance: sql<number>`(select coalesce(sum(i.total_cents - i.paid_cents - i.credited_cents), 0)::int from invoices i where i.customer_id = ${C} and i.status in ('sent', 'partial'))`,
    overdue: sql<number>`(select coalesce(sum(i.total_cents - i.paid_cents - i.credited_cents), 0)::int from invoices i where i.customer_id = ${C} and i.status in ('sent', 'partial') and i.due_date < ${today}::date)`,
    credit: sql<number>`(select coalesce(sum(cc.amount_cents - cc.applied_cents), 0)::int from customer_credits cc where cc.customer_id = ${C} and cc.status <> 'void')`,
    prepaid: sql<number>`(select coalesce(sum(greatest(0, pp.amount_cents - pp.applied_cents - pp.refunded_cents)), 0)::int from prepayments pp where pp.customer_id = ${C} and pp.status = 'open')`,
    revenue: sql<number>`(select coalesce(sum(i.total_cents), 0)::int from invoices i where i.customer_id = ${C} and i.status <> 'void' and i.number is not null and i.issue_date >= ${yearStart}::date)`,
    lastService: sql<string | null>`(select max(v.date)::text from visits v where v.customer_id = ${C} and v.status = 'completed')`,
    nextService: sql<string | null>`(select min(v.date)::text from visits v where v.customer_id = ${C} and v.status in ('open', 'on_site') and v.date >= ${today}::date)`,
    /** What open estimates (pending or changes requested) come to. */
    openEstimates: sql<number>`(select coalesce(sum(e.total_cents), 0)::int from estimates e where e.customer_id = ${C} and e.status in ('sent', 'changes'))`,
    /** The default card or bank account on file, e.g. "visa 4242" / "ach Arvest Bank 6789" (labelled in the browser). */
    onFile: sql<string | null>`(select m.type || '|' || coalesce(m.brand, '') || '|' || coalesce(m.bank_name, '') || '|' || coalesce(m.account_type, '') || '|' || coalesce(m.last4, '')
      from customer_payment_methods m where m.customer_id = ${C} order by m.is_default desc, m.created_at limit 1)`,
  };
}
export type ListColumns = ReturnType<typeof listColumns>;

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]).slice(0, 50);
const num = (v: unknown) => Number(v);
const cents = (v: unknown) => Math.round(Number(v) * 100);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const like = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function textOp(x: SQL, op: string, v: unknown): SQL | null {
  const s = String(v ?? "").trim();
  if (op === "blank") return sql`coalesce(${x}, '') = ''`;
  if (op === "notblank") return sql`coalesce(${x}, '') <> ''`;
  if (!s) return null;
  if (op === "contains") return sql`${x} ilike ${`%${like(s)}%`}`;
  if (op === "starts") return sql`${x} ilike ${`${like(s)}%`}`;
  if (op === "equals") return sql`lower(${x}) = lower(${s})`;
  return null;
}
function numOp(x: SQL, op: string, v: unknown, v2: unknown, conv: (v: unknown) => number = num): SQL | null {
  const a = conv(v), b = conv(v2);
  if (!Number.isFinite(a)) return null;
  if (op === "gt") return sql`${x} > ${a}`;
  if (op === "lt") return sql`${x} < ${a}`;
  if (op === "eq") return sql`${x} = ${a}`;
  if (op === "between" && Number.isFinite(b)) return sql`${x} between ${Math.min(a, b)} and ${Math.max(a, b)}`;
  return null;
}
function dateOp(x: SQL, op: string, v: unknown, v2: unknown): SQL | null {
  if (op === "never") return sql`${x} is null`;
  if (!isDay(v)) return null;
  if (op === "after") return sql`${x} >= ${v}::date`;
  if (op === "before") return sql`${x} <= ${v}::date`;
  if (op === "between" && isDay(v2)) return sql`${x} between ${v < v2 ? v : v2}::date and ${v < v2 ? v2 : v}::date`;
  return null;
}
const inList = (x: SQL, vals: string[]) => sql`${x} in (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;
const uuidArray = (ids: string[]) => sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`;

/** One filter rule as SQL (null when it doesn't make sense, so it's skipped). */
export function filterSql(r: CustomerFilter, cols: ListColumns, custom: { id: string; name: string; type: string; options: string[] }[]): SQL | null {
  const field = filterField(r.f, custom);
  if (!field) return null;
  const vals = list(r.v);
  if (r.f.startsWith("cf:")) {
    const id = r.f.slice(3);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const x = sql`("customers"."custom" ->> ${id})`;
    switch (field.kind) {
      case "text": return textOp(x, r.op, r.v);
      case "enum": return vals.length ? (r.op === "isnot" ? sql`(${x} is null or not ${inList(x, vals)})` : inList(x, vals)) : null;
      case "bool": return r.op === "yes" ? sql`${x} = 'true'` : sql`coalesce(${x}, 'false') <> 'true'`;
      case "number": return numOp(sql`(case when ${x} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${x})::numeric end)`, r.op, r.v, r.v2);
      case "date": return dateOp(sql`(case when ${x} ~ '^\\d{4}-\\d{2}-\\d{2}$' then (${x})::date end)`, r.op, r.v, r.v2);
      default: return null;
    }
  }
  switch (r.f) {
    case "name": {
      const s = String(r.v ?? "").trim();
      const full = sql`(coalesce("customers"."company_name", '') || ' ' || coalesce("customers"."first_name", '') || ' ' || coalesce("customers"."last_name", ''))`;
      if (r.op === "starts" && s) {
        const p = `${like(s)}%`;
        return sql`("customers"."company_name" ilike ${p} or "customers"."first_name" ilike ${p} or "customers"."last_name" ilike ${p} or (coalesce("customers"."first_name", '') || ' ' || coalesce("customers"."last_name", '')) ilike ${p})`;
      }
      if (r.op === "equals" && s) return sql`(lower("customers"."company_name") = lower(${s}) or lower(trim(coalesce("customers"."first_name", '') || ' ' || coalesce("customers"."last_name", ''))) = lower(${s}))`;
      return textOp(full, r.op, r.v);
    }
    case "email": return textOp(sql`"customers"."email"`, r.op, r.v);
    case "phone": {
      if (r.op === "blank" || r.op === "notblank") return textOp(sql`"customers"."phone"`, r.op, null);
      const digits = String(r.v ?? "").replace(/\D/g, "");
      if (!digits) return null;
      const both = sql`(regexp_replace(coalesce("customers"."phone", ''), '\\D', '', 'g') || ' ' || regexp_replace(coalesce("customers"."alt_phone", ''), '\\D', '', 'g'))`;
      return r.op === "starts" ? sql`(regexp_replace(coalesce("customers"."phone", ''), '\\D', '', 'g') like ${`${digits}%`})` : sql`${both} like ${`%${digits}%`}`;
    }
    case "address": {
      if (r.op === "blank") return sql`${cols.properties} = 0`;
      if (r.op === "notblank") return sql`${cols.properties} > 0`;
      const m = textOp(sql`(p.street || ' ' || coalesce(p.city, ''))`, r.op === "equals" ? "contains" : r.op, r.v);
      return m ? sql`exists (select 1 from property_assignments pa join properties p on p.id = pa.property_id where pa.customer_id = ${C} and pa.end_date is null and ${m})` : null;
    }
    case "city":
    case "zip": {
      const col = r.f === "city" ? "city" : "zip";
      const billing = sql.raw(`"customers"."billing_${col}"`);
      if (r.op === "blank" || r.op === "notblank") return textOp(sql`coalesce(${cols[col]}, ${billing})`, r.op, null);
      const m = textOp(sql.raw(`p.${col}`), r.op, r.v);
      const b = textOp(billing, r.op, r.v);
      return m && b ? sql`(exists (select 1 from property_assignments pa join properties p on p.id = pa.property_id where pa.customer_id = ${C} and pa.end_date is null and ${m}) or ${b})` : null;
    }
    case "number": return numOp(sql`"customers"."number"`, r.op, r.v, r.v2);
    case "properties": return numOp(cols.properties, r.op, r.v, r.v2);
    case "status":
    case "kind":
    case "source": {
      if (!vals.length) return null;
      const x = sql.raw(`"customers"."${r.f}"`);
      return r.op === "isnot" ? sql`(${x} is null or not ${inList(x, vals)})` : inList(x, vals);
    }
    case "estimate": {
      if (!vals.length) return null;
      const statuses = vals.filter((v) => ["sent", "accepted", "declined", "changes"].includes(v));
      const parts = [
        ...(statuses.length ? [sql`exists (select 1 from estimates e where e.customer_id = ${C} and e.status in (${sql.join(statuses.map((v) => sql`${v}`), sql`, `)})${r.from ? sql` and e.issue_date >= ${r.from}::date` : sql``}${r.to ? sql` and e.issue_date <= ${r.to}::date` : sql``})`] : []),
        ...(vals.includes("none") ? [sql`not exists (select 1 from estimates e where e.customer_id = ${C} and e.status <> 'draft')`] : []),
      ];
      if (!parts.length) return null;
      const has = sql`(${sql.join(parts, sql` or `)})`;
      return r.op === "isnot" ? sql`not ${has}` : has;
    }
    case "paymentOnFile": {
      if (!vals.length) return null;
      const kinds = vals.filter((v) => v === "card" || v === "ach");
      const parts = [
        ...(kinds.length ? [sql`exists (select 1 from customer_payment_methods m where m.customer_id = ${C} and m.type in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}))`] : []),
        ...(vals.includes("none") ? [sql`not exists (select 1 from customer_payment_methods m where m.customer_id = ${C})`] : []),
      ];
      if (!parts.length) return null;
      const has = sql`(${sql.join(parts, sql` or `)})`;
      return r.op === "isnot" ? sql`not ${has}` : has;
    }
    case "autopay": return r.op === "yes" ? sql`"customers"."autopay"` : sql`not "customers"."autopay"`;
    case "delivery": {
      if (!vals.length) return null;
      const has = sql`"customers"."delivery" && array[${sql.join(vals.map((v) => sql`${v}`), sql`, `)}]::text[]`;
      return r.op === "isnot" ? sql`not (${has})` : has;
    }
    case "tags": {
      const ids = vals.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
      if (!ids.length) return null;
      if (r.op === "all") return sql`"customers"."tag_ids" @> ${uuidArray(ids)}`;
      if (r.op === "none") return sql`not ("customers"."tag_ids" && ${uuidArray(ids)})`;
      return sql`"customers"."tag_ids" && ${uuidArray(ids)}`;
    }
    case "since": return dateOp(sql`("customers"."created_at")::date`, r.op === "never" ? "" : r.op, r.v, r.v2);
    case "balance": return numOp(cols.balance, r.op, r.v, r.v2, cents);
    case "credit": return numOp(cols.credit, r.op, r.v, r.v2, cents);
    case "prepaid": return numOp(cols.prepaid, r.op, r.v, r.v2, cents);
    case "revenue": return numOp(cols.revenue, r.op, r.v, r.v2, cents);
    case "overdue": return r.op === "yes" ? sql`${cols.overdue} > 0` : sql`${cols.overdue} = 0`;
    case "taxExempt": return r.op === "yes" ? sql`"customers"."tax_exempt"` : sql`not "customers"."tax_exempt"`;
    case "emailOptOut": return r.op === "yes" ? sql`"customers"."email_opt_out_at" is not null` : sql`"customers"."email_opt_out_at" is null`;
    case "po": return r.op === "yes" ? sql`"customers"."po_required"` : sql`not "customers"."po_required"`;
    case "lastService": return dateOp(sql`(${cols.lastService})::date`, r.op, r.v, r.v2);
    case "nextService": return r.op === "yes" ? sql`${cols.nextService} is not null` : sql`${cols.nextService} is null`;
    case "service": {
      const ids = vals.filter((v) => /^[0-9a-f-]{36}$/i.test(v));
      const svc = (col: SQL) => (ids.length ? sql` and ${col} = any(${uuidArray(ids)})` : sql``);
      const range = (col: SQL) => sql`${isDay(r.from) ? sql` and ${col} >= ${r.from}::date` : sql``}${isDay(r.to) ? sql` and ${col} <= ${r.to}::date` : sql``}`;
      const visitWith = (statuses: string) => sql`exists (select 1 from visits v join visit_lines vl on vl.visit_id = v.id where v.customer_id = ${C} and v.status in (${sql.raw(statuses)})${svc(sql`vl.service_type_id`)}${range(sql`v.date`)})`;
      const invoiced = sql`exists (select 1 from invoices i join invoice_lines il on il.invoice_id = i.id where i.customer_id = ${C} and i.status <> 'void' and i.number is not null${svc(sql`il.service_type_id`)}${range(sql`i.issue_date`)})`;
      if (r.op === "completed") return visitWith("'completed'");
      if (r.op === "scheduled") return visitWith("'open', 'on_site'");
      if (r.op === "invoiced") return invoiced;
      if (r.op === "never") return sql`not ${visitWith("'completed', 'open', 'on_site'")} and not ${invoiced}`;
      return null;
    }
  }
  return null;
}

/** What a sortable column sorts by. */
export function sortSql(key: string, cols: ListColumns): SQL | null {
  switch (key) {
    case "number": return sql`"customers"."number"`;
    case "name": return sql`lower(coalesce("customers"."company_name", "customers"."last_name", "customers"."first_name", ''))`;
    case "type": return sql`"customers"."kind"`;
    case "status": return sql`"customers"."status"`;
    case "openEstimates": return cols.openEstimates;
    case "source": return sql`"customers"."source"`;
    case "since": return sql`"customers"."created_at"`;
    case "email": return sql`lower("customers"."email")`;
    case "address": return sql`lower(${cols.address})`;
    case "city": return sql`lower(${cols.city})`;
    case "zip": return cols.zip;
    case "properties": case "balance": case "overdue": case "credit": case "prepaid": case "revenue": case "lastService": case "nextService": return cols[key];
    default: return null;
  }
}
