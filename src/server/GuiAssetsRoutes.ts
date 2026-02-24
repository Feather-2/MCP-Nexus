import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

const GUI_MISSING_MESSAGE = 'GUI assets not found. Please build GUI into dist-gui or gui/dist.';

export interface GuiAssetsOptions {
  moduleDir: string;
  candidates?: string[];
}

export function resolveGuiStaticRoot(moduleDir: string, candidates?: string[]): string {
  const roots = candidates ?? [
    resolve(process.cwd(), 'dist-gui'),
    resolve(process.cwd(), 'gui', 'dist'),
    resolve(moduleDir, '../..', 'gui', 'dist')
  ];
  return roots.find((p) => existsSync(p)) || roots[0]!;
}

export function registerGuiAssetsRoutes(server: FastifyInstance, options: GuiAssetsOptions): void {
  const staticRoot = resolveGuiStaticRoot(options.moduleDir, options.candidates);

  server.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/static/',
    decorateReply: true
  });

  server.register(fastifyStatic, {
    root: join(staticRoot, 'assets'),
    prefix: '/assets/',
    decorateReply: false
  });

  const serveIndex = async (_request: FastifyRequest, reply: FastifyReply) => {
    const indexPath = join(staticRoot, 'index.html');
    if (!existsSync(indexPath)) {
      return reply.code(503).type('text/plain').send(GUI_MISSING_MESSAGE);
    }
    return reply.type('text/html').sendFile('index.html', staticRoot);
  };

  server.get('/', serveIndex);
  const spaRoutes = ['/dashboard*', '/services*', '/templates*', '/auth*', '/monitoring*', '/settings*', '/deployment*', '/performance*'];
  for (const route of spaRoutes) {
    server.get(route, serveIndex);
  }
}

