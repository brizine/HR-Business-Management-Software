import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError, type ZodType, type z } from "zod";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(what = "Record"): never {
  throw new HttpError(404, `${what} not found`);
}

export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Validation failed", issues: err.issues });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    // Postgres unique violation
    if ((err as { code?: string }).code === "23505") {
      return reply.status(409).send({ error: "A record with that value already exists" });
    }
    return reply.status(status).send({ error: status >= 500 ? "Internal server error" : err.message });
  });
}
