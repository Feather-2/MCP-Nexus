import os from 'os';
import path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import type { SkillCapabilities } from '../security/CapabilityManifest.js';
import { SkillAuthorization } from './SkillAuthorization.js';

describe('SkillAuthorization', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-skill-auth-'));
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('returns disabled state by default', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });

    const state = await authorization.getState('demo-skill');

    expect(state).toEqual({
      enabled: false,
      authorizedCapabilities: null
    });
  });

  it('authorizes with full capabilities when no capabilities payload is provided', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const state = await authorization.authorize('demo-skill', { userId: 'alice' });

    expect(state).toEqual({
      enabled: true,
      authorizedCapabilities: null,
      authorizedAt: 1_700_000_000_000,
      authorizedBy: 'alice'
    });
  });

  it('authorizes with partial capabilities', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });
    const capabilities = {
      filesystem: { read: ['/workspace'] },
      network: { allowedHosts: ['api.example.com'], allowedPorts: [443] }
    } as unknown as Partial<SkillCapabilities>;

    const state = await authorization.authorize('demo-skill', { capabilities });

    expect(state.enabled).toBe(true);
    expect(state.authorizedCapabilities).toEqual(capabilities);
  });

  it('revokes authorization by setting enabled=false', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });
    await authorization.authorize('demo-skill', { userId: 'alice' });

    const state = await authorization.revoke('demo-skill');

    expect(state).toEqual({
      enabled: false,
      authorizedCapabilities: null
    });
  });

  it('supports quick enabled checks', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });

    expect(await authorization.isEnabled('demo-skill')).toBe(false);

    await authorization.authorize('demo-skill');

    expect(await authorization.isEnabled('demo-skill')).toBe(true);
  });

  it('lists all authorization states', async () => {
    const authorization = new SkillAuthorization({ storageRoot: tmpRoot });

    await authorization.authorize('skill-a');
    await authorization.authorize('skill-b', {
      capabilities: {
        network: {
          allowedHosts: ['example.com'],
          allowedPorts: [443]
        }
      }
    });

    const listed = await authorization.listAll();

    expect(Object.keys(listed).sort()).toEqual(['skill-a', 'skill-b']);
    expect(listed['skill-a']?.enabled).toBe(true);
    expect(listed['skill-a']?.authorizedCapabilities).toBeNull();
    expect(listed['skill-b']?.authorizedCapabilities).toEqual({
      network: {
        allowedHosts: ['example.com'],
        allowedPorts: [443]
      }
    });
  });

  it('persists states across instances', async () => {
    const writer = new SkillAuthorization({ storageRoot: tmpRoot });
    await writer.authorize('demo-skill', {
      capabilities: {
        env: ['OPENAI_API_KEY']
      },
      userId: 'alice'
    });

    const reader = new SkillAuthorization({ storageRoot: tmpRoot });
    const state = await reader.getState('demo-skill');

    expect(state.enabled).toBe(true);
    expect(state.authorizedCapabilities).toEqual({ env: ['OPENAI_API_KEY'] });
    expect(state.authorizedBy).toBe('alice');
    expect(typeof state.authorizedAt).toBe('number');
  });
});
