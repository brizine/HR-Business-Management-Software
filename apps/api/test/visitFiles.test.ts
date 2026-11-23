/** Work order tags (the company tag list) and photos / documents: who adds, sees, captions and removes them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@vfiles.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const boundary = "----wo";
const upload = (who: string, visitId: string, type = "image/png", caption?: string, name = "front-yard.png") => app.inject({
  method: "POST", url: `/visits/${visitId}/files`,
  payload: Buffer.concat([
    ...(caption ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`)] : []),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]),
  headers: { authorization: `Bearer ${T[who]}`, "content-type": `multipart/form-data; boundary=${boundary}` },
});

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Files Co", firstName: "Fi", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"], ["other", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  ID.callback = (await call("POST", "/crm/tags", "owner", { name: "Callback", color: "red" })).body.id;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("work order tags", () => {
  it("tags come from the company list, filter the list and reach the calendar", async () => {
    const order = { title: "Re-spray weeds", customerId: ID.jane, propertyId: ID.janeProp, date: today, assigneeIds: [ID.tech], tagIds: [ID.callback] };
    const r = await call("POST", "/visits", "office", order);
    expect(r.body.tagIds).toEqual([ID.callback]);
    // The crew sees the tag's name (they can't open the tag list).
    expect((await call("GET", `/visits/${r.body.id}`, "tech")).body.tags).toEqual([{ id: ID.callback, name: "Callback", color: "red" }]);
    ID.wo = r.body.id;
    const plain = (await call("POST", "/visits", "office", { ...order, title: "Regular round", tagIds: [] })).body;
    expect((await call("GET", `/visits?tagId=${ID.callback}`, "office")).body.items.map((v: any) => v.id)).toEqual([ID.wo]);
    expect((await call("POST", "/visits", "office", { ...order, tagIds: ["00000000-0000-4000-8000-000000000000"] })).body.error).toMatch(/tags doesn't exist/);
    const events = (await call("GET", `/events?from=${today}&to=${today}`, "office")).body.events;
    expect(events.find((e: any) => e.id === ID.wo).tagIds).toContain(ID.callback);
    expect(events.find((e: any) => e.id === plain.id).tagIds).not.toContain(ID.callback);
  });
});

describe("work order photos and documents", () => {
  it("the crew adds a photo with a caption; others on the team can't", async () => {
    const up = await upload("tech", ID.wo, "image/png", "Weeds along the fence before spraying");
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ fileName: "front-yard.png", contentType: "image/png", caption: "Weeds along the fence before spraying", uploadedById: ID.tech, sizeBytes: png.length });
    ID.file = up.json().id;
    expect((await upload("other", ID.wo)).statusCode).toBe(404);
    expect((await upload("tech", ID.wo, "text/plain", undefined, "notes.txt")).json().error).toMatch(/Upload a photo/);
    // The office adds a PDF.
    expect((await upload("office", ID.wo, "application/pdf", undefined, "Service agreement.pdf")).statusCode).toBe(200);
  });

  it("everyone who can see the work order sees its files; counts show on the work order and calendar", async () => {
    const list = await call("GET", `/visits/${ID.wo}/files`, "tech");
    expect(list.body.map((f: any) => [f.fileName, f.uploadedBy])).toEqual([["front-yard.png", "tech Person"], ["Service agreement.pdf", "office Person"]]);
    const bytes = await app.inject({ method: "GET", url: `/visits/${ID.wo}/files/${ID.file}`, headers: { authorization: `Bearer ${T.office}` } });
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/visits/${ID.wo}/files/${ID.file}`, headers: { authorization: `Bearer ${T.other}` } })).statusCode).toBe(404);
    expect((await call("GET", `/visits/${ID.wo}`, "office")).body.fileCount).toBe(2);
    expect((await call("GET", `/events?from=${today}&to=${today}`, "office")).body.events.find((e: any) => e.id === ID.wo).mediaCount).toBe(2);
  });

  it("captions can change; whoever added a file (or a manager) removes it", async () => {
    expect((await call("PATCH", `/visits/${ID.wo}/files/${ID.file}`, "tech", { caption: "Before" })).body.caption).toBe("Before");
    const pdf = (await call("GET", `/visits/${ID.wo}/files`, "office")).body.find((f: any) => f.contentType === "application/pdf");
    expect((await call("DELETE", `/visits/${ID.wo}/files/${pdf.id}`, "tech")).status).toBe(403);
    expect((await call("DELETE", `/visits/${ID.wo}/files/${ID.file}`, "tech")).status).toBe(200);
    expect((await call("DELETE", `/visits/${ID.wo}/files/${pdf.id}`, "office")).status).toBe(200);
    expect((await call("GET", `/visits/${ID.wo}/files`, "office")).body).toEqual([]);
  });
});
