import type { FastifyRequest } from 'fastify';

export function extractBearerToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return undefined;
}

export function extractApiKey(request: FastifyRequest): string | undefined {
  return (
    (request.headers['x-api-key'] as string) ||
    (request.headers['x-api-token'] as string) ||
    (request.headers['apikey'] as string) ||
    undefined
  );
}
