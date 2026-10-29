import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { count, eq } from "drizzle-orm";
import { loginSchema, signupSchema } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees } from "../db/schema";
import { authenticate } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { publicEmployee } from "./employees";

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Creates a company and its owner account. A self-hosted install serves one
   * business, so after the first company exists sign-up closes unless
   * ALLOW_SIGNUP=true (e.g. if you run Crewdesk for several companies).
   */
  app.post("/signup", async (req) => {
    const body = parse(signupSchema, req.body);
    if (process.env.ALLOW_SIGNUP !== "true") {
      const [{ n }] = await db.select({ n: count() }).from(companies);
      if (n > 0) throw new HttpError(403, "Sign-ups are closed. Ask your company's Crewdesk admin to add you.");
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const { company, owner } = await db.transaction(async (tx) => {
      const [company] = await tx.insert(companies).values({ name: body.companyName }).returning();
      const [owner] = await tx
        .insert(employees)
        .values({
          companyId: company.id,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email.toLowerCase(),
          passwordHash,
          role: "owner",
          payType: "salary",
        })
        .returning();
      return { company, owner };
    });
    const token = app.jwt.sign({ sub: owner.id, companyId: company.id, role: "owner" });
    return { token, user: publicEmployee(owner), company };
  });

  app.post("/login", async (req) => {
    const body = parse(loginSchema, req.body);
    const [user] = await db.select().from(employees).where(eq(employees.email, body.email.toLowerCase()));
    if (!user?.passwordHash || user.status === "terminated" || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw new HttpError(401, "Invalid email or password");
    }
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    const token = app.jwt.sign({ sub: user.id, companyId: user.companyId, role: user.role as never });
    return { token, user: publicEmployee(user), company };
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    if (!user) throw new HttpError(401, "Account no longer exists");
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    return { user: publicEmployee(user), company };
  });
};

export default routes;
