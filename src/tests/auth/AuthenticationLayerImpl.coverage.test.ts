import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthenticationLayerImpl } from '../../auth/AuthenticationLayerImpl.js';
import type { Logger } from '../../types/index.js';

function makeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('AuthenticationLayerImpl – extended coverage', () => {
  let auth: AuthenticationLayerImpl;

  beforeEach(() => {
    auth = new AuthenticationLayerImpl({ authMode: 'local-trusted' } as any, makeLogger());
  });

  it('listApiKeys returns created keys', async () => {
    const key = await auth.createApiKey('test-key', ['read']);
    const keys = auth.listApiKeys();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.some(k => k.name === 'test-key')).toBe(true);
  });

  it('deleteApiKey removes key and returns true', async () => {
    const key = await auth.createApiKey('del-key', ['read']);
    const deleted = await auth.deleteApiKey(key);
    expect(deleted).toBe(true);
  });

  it('deleteApiKey returns false for missing key', async () => {
    const deleted = await auth.deleteApiKey('nonexistent');
    expect(deleted).toBe(false);
  });

  it('listTokens returns generated tokens', async () => {
    await auth.generateToken('user1', ['admin'], 1);
    const tokens = auth.listTokens();
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.some(t => t.userId === 'user1')).toBe(true);
    expect(tokens[0].token).toContain('...');
  });

  it('exportApiKeys and importApiKeys round-trip', async () => {
    await auth.createApiKey('roundtrip', ['write']);
    const exported = auth.exportApiKeys();
    expect(exported.length).toBeGreaterThanOrEqual(1);

    const auth2 = new AuthenticationLayerImpl({ authMode: 'local-trusted' } as any, makeLogger());
    auth2.importApiKeys(exported);
    expect(auth2.listApiKeys().length).toBeGreaterThanOrEqual(1);
  });

  it('importTokens imports tokens', () => {
    const auth2 = new AuthenticationLayerImpl({ authMode: 'local-trusted' } as any, makeLogger());
    auth2.importTokens([{
      token: 'test-token-123',
      userId: 'u1',
      permissions: ['read'],
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    }]);
    expect(auth2.listTokens().length).toBeGreaterThanOrEqual(1);
  });

  it('getActiveTokenCount and getActiveApiKeyCount', async () => {
    await auth.generateToken('u', ['r'], 1);
    await auth.createApiKey('k', ['r']);
    expect(auth.getActiveTokenCount()).toBeGreaterThanOrEqual(1);
    expect(auth.getActiveApiKeyCount()).toBeGreaterThanOrEqual(1);
  });
});
