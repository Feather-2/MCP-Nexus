import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerGuiAssetsRoutes, resolveGuiStaticRoot } from '../../server/GuiAssetsRoutes.js';

describe('GuiAssetsRoutes', () => {
  it('resolveGuiStaticRoot picks first existing candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pbmcp-gui-root-'));
    const missingA = join(root, 'missing-a');
    const existing = join(root, 'existing');
    const missingB = join(root, 'missing-b');
    await mkdir(existing, { recursive: true });

    try {
      const resolved = resolveGuiStaticRoot('/unused', [missingA, existing, missingB]);
      expect(resolved).toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 503 for SPA route when index.html is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pbmcp-gui-missing-'));
    const app = Fastify({ logger: false });

    try {
      registerGuiAssetsRoutes(app, { moduleDir: '/unused', candidates: [root] });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('GUI assets not found');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves index.html for root when assets exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pbmcp-gui-ok-'));
    const app = Fastify({ logger: false });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf-8');

    try {
      registerGuiAssetsRoutes(app, { moduleDir: '/unused', candidates: [root] });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<title>ok</title>');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

