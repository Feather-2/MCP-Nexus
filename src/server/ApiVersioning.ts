import type { FastifyInstance } from 'fastify';

export function setupApiVersioningCollector(
  server: FastifyInstance,
  apiVersion: string,
  target: Array<Record<string, unknown>>
): void {
  server.addHook('onRoute', (opts) => {
    const url = (opts as unknown as Record<string, unknown>)?.url;
    if (typeof url !== 'string') return;
    if (!url.startsWith('/api/')) return;
    if (url.startsWith(`/api/${apiVersion}/`)) return;
    if (((opts as unknown as Record<string, unknown>).config as Record<string, unknown>)?.__apiVersionAlias) return;
    target.push({ ...(opts as unknown as Record<string, unknown>) });
  });
}

export function registerApiVersionAliases(
  server: FastifyInstance,
  apiVersion: string,
  routesToAlias: Array<Record<string, unknown>>
): void {
  for (const opts of routesToAlias) {
    try {
      const url = (opts as Record<string, unknown>)?.url;
      if (typeof url !== 'string') continue;
      const aliasedUrl = `/api/${apiVersion}${url.slice('/api'.length)}`;
      const routeOpts = opts as Record<string, unknown>;
      server.route({
        ...routeOpts,
        url: aliasedUrl,
        config: { ...(routeOpts.config as Record<string, unknown> || {}), __apiVersionAlias: true }
      } as unknown as Parameters<FastifyInstance['route']>[0]);
    } catch {
      /* best-effort: ignore duplicate route errors in tests */
    }
  }
}

