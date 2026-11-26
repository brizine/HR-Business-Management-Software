import type { FastifyPluginAsync } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { companies, employees } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { sha256 } from "../lib/crypto";
import { HttpError, parse } from "../lib/errors";

/**
 * Help assistant: answers questions about using Crewdesk from docs/help-guide.md, using Claude.
 * Needs ANTHROPIC_API_KEY on the server. The guide goes in a cached system block, so each
 * question only pays full price for the question, the person's details and the answer.
 */

export const HELP_MODEL = "claude-opus-5-5";

/** The parts of the Anthropic client this route uses (swapped out in tests). */
export interface HelpClient {
  beta: { messages: { create: (body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.Messages.BetaMessage> } };
}
let client: HelpClient | null | undefined;
export function setHelpClient(c: HelpClient | null) {
  client = c;
}
function helpClient(): HelpClient | null {
  if (client === undefined) client = process.env.ANTHROPIC_API_KEY ? (new Anthropic() as unknown as HelpClient) : null;
  return client;
}

/** docs/help-guide.md, found by walking up from this file (works from src/ and from the built dist/). */
let guide: string | null = null;
export function standardGuide() {
  if (guide) return guide;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const file = resolve(dir, "docs/help-guide.md");
    if (existsSync(file)) return (guide = readFileSync(file, "utf8"));
    dir = dirname(dir);
  }
  throw new HttpError(503, "The help guide is missing from this install");
}

const INSTRUCTIONS = `You are the help assistant inside Crewdesk, the HR, scheduling, time clock and fleet software this company uses. Answer questions about how to use Crewdesk, using the user guide below as your source.

- Give short, practical answers: which menu or page, which button, in what order. Use the exact names of menus and buttons from the guide. Numbered steps for anything with more than one step.
- If the guide doesn't cover something, say you're not sure Crewdesk does that and suggest asking the company's Crewdesk admin. Never invent features, menus or buttons.
- Mind the person's role (given below): if something needs a role they don't have, say who can do it.
- You can't see or change the company's data, and you can't do things for them in Crewdesk. For questions about specific people, pay or records, tell them where to look.
- Stay on Crewdesk and the work it supports (HR, schedules, time, fleet). Politely decline unrelated requests.
- Plain text with simple Markdown (numbered lists, **bold** for menu and button names). No headings, no tables.
- When your answer draws on the guide, finish with one last line that starts with "Sources:" and lists the exact titles of the guide sections you used (the lines that start with "## "), most useful first, separated by " | ". At most three. Leave the line out when you didn't use the guide (a greeting, a request you declined).`;

/** The manual's section titles (its "## " headings). */
export const guideSections = (markdown: string) => [...markdown.matchAll(/^## +(.+?)\s*$/gm)].map((m) => m[1]);

/**
 * The assistant ends an answer with "Sources: A | B": the manual sections it used. They come off
 * the answer and go back as a list, so the Help window can show them as links into the User
 * Manual. Only real section titles count; anything else on that line is dropped.
 */
export function splitSources(text: string, titles: string[]): { answer: string; sources: string[] } {
  const lines = text.trimEnd().split("\n");
  let at = lines.length - 1;
  while (at >= 0 && !/^\s*\**sources\**\s*:/i.test(lines[at])) at--;
  // The line counts only at the end of the answer (a "Sources:" mid-answer is just words).
  if (at < 0 || lines.slice(at + 1).some((l) => l.trim())) return { answer: text.trim(), sources: [] };
  const byName = new Map(titles.map((t) => [t.toLowerCase(), t]));
  const named = lines[at].replace(/^\s*\**sources\**\s*:\**/i, "").split(/\s*\|\s*|\s*;\s*/).map((x) => x.replace(/^[\s"'`#*-]+|[\s"'`*.]+$/g, "").toLowerCase());
  const sources = [...new Set(named.map((n) => byName.get(n)).filter((t): t is string => !!t))].slice(0, 3);
  return { answer: lines.slice(0, at).join("\n").trim(), sources };
}

const messageSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m.length > 0 && m[m.length - 1].role === "user", "The last message must be a question"),
});

/** The company's manual: its own edited copy if it has one, otherwise the standard one. */
async function companyGuide(companyId: string) {
  const [c] = await db.select({ guide: companies.helpGuide, base: companies.helpGuideBase }).from(companies).where(eq(companies.id, companyId));
  const standard = standardGuide();
  return {
    markdown: c?.guide ?? standard,
    custom: !!c?.guide,
    // The standard manual changed (e.g. new features) since the company last saved its copy.
    standardChanged: !!c?.guide && c.base !== sha256(standard),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Whether the assistant is set up (the page shows a note if not). */
  app.get("/status", async () => ({ available: !!helpClient() }));

  /** The user manual itself (Markdown), for the browsable copy on the Help page. Works without an API key. */
  app.get("/guide", async (req) => companyGuide(req.user.companyId));

  /** The standard manual, to compare with or start over from (Layout Editor). */
  app.get("/guide/standard", { preHandler: requireRole("owner", "company") }, async () => ({ markdown: standardGuide() }));

  /** The owner edits the company's manual in the Layout Editor; blank goes back to the standard one. */
  app.put("/guide", { preHandler: requireRole("owner", "company") }, async (req) => {
    const { markdown } = parse(z.object({ markdown: z.string().max(200_000).nullable() }), req.body);
    const text = markdown?.trim() ? markdown.replace(/\r\n/g, "\n") : null;
    await db.update(companies).set({ helpGuide: text, helpGuideBase: text ? sha256(standardGuide()) : null }).where(eq(companies.id, req.user.companyId));
    return companyGuide(req.user.companyId);
  });

  app.post("/ask", { config: { rateLimit: { max: Number(process.env.HELP_RATE_LIMIT ?? 60), timeWindow: "1 hour" } } }, async (req) => {
    const { messages } = parse(messageSchema, req.body);
    const ai = helpClient();
    if (!ai) throw new HttpError(503, "The help assistant isn't set up yet. An admin needs to add an Anthropic API key (ANTHROPIC_API_KEY) to the server's settings.");

    const [me] = await db.select({ firstName: employees.firstName, role: employees.role, title: employees.title }).from(employees).where(eq(employees.id, req.user.sub));
    const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, req.user.companyId));
    const areas = Object.entries(req.user.areas ?? {}).map(([area, level]) => `${area}: ${level}`).join(", ");
    const who = `The person asking: ${me?.firstName ?? "an employee"}, role ${req.user.role}${me?.title ? `, job title ${me.title}` : ""}, at ${company?.name ?? "their company"}.${areas ? ` Their access by area: ${areas}.` : ""}`;

    const manual = (await companyGuide(req.user.companyId)).markdown;
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await ai.beta.messages.create({
        model: HELP_MODEL,
        max_tokens: 4000,
        // Quick answers: thinking stays on (it can't be turned off on this model), at low effort.
        output_config: { effort: "low" },
        // If the model declines for safety reasons, the API retries on a suitable fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: `${INSTRUCTIONS}\n\n<crewdesk_user_guide>\n${manual}\n</crewdesk_user_guide>`, cache_control: { type: "ephemeral" } },
          { type: "text", text: who },
        ],
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new HttpError(503, "The help assistant's API key was refused. An admin should check ANTHROPIC_API_KEY in the server's settings.");
      }
      if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, "The help assistant is busy. Try again in a minute.");
      if (e instanceof Anthropic.APIError) {
        req.log.error({ status: e.status, message: e.message }, "help assistant request failed");
        throw new HttpError(503, "The help assistant couldn't answer just now. Try again in a minute.");
      }
      throw e;
    }

    if (response.stop_reason === "refusal") {
      return { answer: "Sorry, I can't help with that one. Try asking about how to do something in Crewdesk.", sources: [] };
    }
    const { answer, sources } = splitSources(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n"), guideSections(manual));
    return { answer: answer || "Sorry, I don't have an answer for that. Try rephrasing, or ask your Crewdesk admin.", sources };
  });
};

export default routes;
