import type { FastifyRequest } from 'fastify';

function headerAsString(val: string | string[] | undefined): string | undefined {
  if (Array.isArray(val)) return val[0];
  return val;
}

export function extractBearerToken(request: FastifyRequest): string | undefined {
  const authHeader = headerAsString(request.headers.authorization);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    return token || undefined;
  }
  return undefined;
}

export function extractApiKey(request: FastifyRequest): string | undefined {
  return (
    headerAsString(request.headers['x-api-key']) ||
    headerAsString(request.headers['x-api-token']) ||
    headerAsString(request.headers['apikey']) ||
    undefined
  );
}
