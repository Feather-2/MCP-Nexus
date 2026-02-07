import type { AuditSkillHandler } from '../AuditSkillRouter.js';
import { IntentAuditHandler } from './IntentAuditHandler.js';
import { InjectionAuditHandler } from './InjectionAuditHandler.js';
import { DataflowAuditHandler } from './DataflowAuditHandler.js';
import { DependencyAuditHandler } from './DependencyAuditHandler.js';
import { PrivilegeAuditHandler } from './PrivilegeAuditHandler.js';

export { IntentAuditHandler } from './IntentAuditHandler.js';
export { InjectionAuditHandler } from './InjectionAuditHandler.js';
export { DataflowAuditHandler } from './DataflowAuditHandler.js';
export { DependencyAuditHandler } from './DependencyAuditHandler.js';
export { PrivilegeAuditHandler } from './PrivilegeAuditHandler.js';

export function createDefaultHandlers(): AuditSkillHandler[] {
  return [
    new IntentAuditHandler(),
    new InjectionAuditHandler(),
    new DataflowAuditHandler(),
    new DependencyAuditHandler(),
    new PrivilegeAuditHandler()
  ];
}
