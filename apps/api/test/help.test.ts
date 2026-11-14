/** Help assistant: answers from the user guide with Claude (the API is faked here). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { HELP_MODEL, setHelpClient } from "../src/routes/help";

let app: FastifyInstance;
let token = "";
const sent: any[] = [];
let reply: any = { stop_reason: "end_turn", content: [{ type: "text", text: "Go to **Schedule** and click **+ Add shift**." }] };

async function call(method: string, url: string, payload?: unknown, auth = true) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: auth ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Help Co", firstName: "Hana", lastName: "Owner", email: `help-${Date.now()}@test.dev`, password: "password123" } });
  token = signup.json().token;
});
afterAll(async () => {
  setHelpClient(null);
  await app.close();
  await pool.end();
});

describe("help assistant", () => {
  it("says when it isn't set up (no API key), and needs a sign-in", async () => {
    setHelpClient(null);
    expect((await call("GET", "/help/status")).body).toEqual({ available: false });
    const res = await call("POST", "/help/ask", { messages: [{ role: "user", content: "How do I add a shift?" }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect((await call("POST", "/help/ask", { messages: [{ role: "user", content: "hi" }] }, false)).status).toBe(401);
  });

  it("answers from the guide, with the person's role, the guide cached, and fallbacks on", async () => {
    setHelpClient({ beta: { messages: { create: async (body) => (sent.push(body), reply) } } });
    expect((await call("GET", "/help/status")).body).toEqual({ available: true });
    const res = await call("POST", "/help/ask", { messages: [
      { role: "user", content: "How do I add a shift?" },
      { role: "assistant", content: "Which week?" },
      { role: "user", content: "This week" },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Go to **Schedule** and click **+ Add shift**.");
    const body = sent.at(-1);
    expect(body.model).toBe(HELP_MODEL);
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toContain("server-side-fallback-2026-07-01");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.messages).toHaveLength(3);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[0].text).toContain("<crewdesk_user_guide>");
    expect(body.system[0].text).toContain("## Schedule");
    expect(body.system[1].text).toContain("role owner");
    expect(body.system[1].text).not.toContain("Help Co\n"); // per-person details stay out of the cached block
  });

  it("checks the conversation, and handles a declined answer", async () => {
    expect((await call("POST", "/help/ask", { messages: [] })).status).toBe(400);
    expect((await call("POST", "/help/ask", { messages: [{ role: "assistant", content: "Hi" }] })).status).toBe(400);
    expect((await call("POST", "/help/ask", { messages: [{ role: "user", content: "x".repeat(4001) }] })).status).toBe(400);
    reply = { stop_reason: "refusal", content: [] };
    expect((await call("POST", "/help/ask", { messages: [{ role: "user", content: "something odd" }] })).body.answer).toMatch(/can't help with that/);
  });
});
