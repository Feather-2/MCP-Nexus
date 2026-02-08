import { describe, expect, it } from 'vitest';

describe('routing/index exports', () => {
  it('exports key types and classes', async () => {
    const mod = await import('../../routing/index.js');
    expect(mod.GatewayRouterImpl).toBeDefined();
    expect(mod.RadixTree).toBeDefined();
    expect(mod.DelegateTool).toBeDefined();
    expect(mod.TierRouter).toBeDefined();
  });
});
