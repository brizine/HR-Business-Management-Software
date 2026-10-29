import type { FastifyReply, FastifyRequest } from "fastify";
import { hasRole, type Role } from "@crewdesk/shared";
import { HttpError } from "./errors";

export interface AuthUser {
  sub: string;
  companyId: string;
  role: Role;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, "Not signed in");
  }
}

/** preHandler that rejects users below `min`. Must run after `authenticate`. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest) => {
    if (!hasRole(req.user.role, min)) throw new HttpError(403, "You do not have permission to do that");
  };
}

export function isManager(req: FastifyRequest) {
  return hasRole(req.user.role, "manager");
}
