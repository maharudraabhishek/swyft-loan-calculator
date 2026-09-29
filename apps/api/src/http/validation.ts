import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Principal } from '../db/database.js';
import { unauthenticated, validationFailed } from './errors.js';

/** Parses untrusted input; failures become 400 with per-field messages, never raw values. */
export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : 'body';
    fields[key] ??=
      issue.code === 'unrecognized_keys' ? 'Unexpected field' : issue.message;
  }
  throw validationFailed(fields);
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** The authenticated principal; protected routes are unreachable without one. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthenticated();
  return request.principal;
}
