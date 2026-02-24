import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

type RespondError = (
  reply: FastifyReply,
  status: number,
  message: string,
  opts?: { code?: string; recoverable?: boolean; meta?: unknown }
) => unknown;

export interface ParseOrReplyOptions {
  code?: string;
  recoverable?: boolean;
}

export function parseOrReply<TSchema extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: TSchema,
  payload: unknown,
  message: string,
  respondError: RespondError,
  options: ParseOrReplyOptions = {}
): z.infer<TSchema> | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    respondError(reply, 400, message, {
      code: options.code ?? 'BAD_REQUEST',
      recoverable: options.recoverable ?? true,
      meta: parsed.error.issues
    });
    return null;
  }
  return parsed.data;
}

