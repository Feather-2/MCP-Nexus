import { describe, expect, it } from 'vitest';
import { createDefaultHandlers, IntentAuditHandler, InjectionAuditHandler, DataflowAuditHandler, DependencyAuditHandler, PrivilegeAuditHandler } from '../../security/audit-handlers/index.js';

describe('audit-handlers/index', () => {
  it('createDefaultHandlers returns 5 handlers', () => {
    const handlers = createDefaultHandlers();
    expect(handlers).toHaveLength(5);
  });

  it('createDefaultHandlers with config', () => {
    const handlers = createDefaultHandlers({
      intent: {},
      injection: {},
      dataflow: {},
      dependency: {},
      privilege: {}
    });
    expect(handlers).toHaveLength(5);
  });

  it('exports all handler classes', () => {
    expect(IntentAuditHandler).toBeDefined();
    expect(InjectionAuditHandler).toBeDefined();
    expect(DataflowAuditHandler).toBeDefined();
    expect(DependencyAuditHandler).toBeDefined();
    expect(PrivilegeAuditHandler).toBeDefined();
  });

  it('each handler has an audit method', () => {
    const handlers = createDefaultHandlers();
    for (const h of handlers) {
      expect(typeof h.analyze).toBe('function');
    }
  });
});
