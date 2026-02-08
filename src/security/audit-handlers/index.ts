import type { AuditSkillHandler } from '../AuditSkillRouter.js';
import { IntentAuditHandler, type IntentAuditHandlerOptions } from './IntentAuditHandler.js';
import { InjectionAuditHandler, type InjectionAuditHandlerOptions } from './InjectionAuditHandler.js';
import { DataflowAuditHandler, type DataflowAuditHandlerOptions } from './DataflowAuditHandler.js';
import { DependencyAuditHandler, type DependencyAuditHandlerOptions } from './DependencyAuditHandler.js';
import { PrivilegeAuditHandler, type PrivilegeAuditHandlerOptions } from './PrivilegeAuditHandler.js';

export { IntentAuditHandler, type IntentAuditHandlerOptions } from './IntentAuditHandler.js';
export { InjectionAuditHandler, type InjectionAuditHandlerOptions } from './InjectionAuditHandler.js';
export { DataflowAuditHandler, type DataflowAuditHandlerOptions } from './DataflowAuditHandler.js';
export { DependencyAuditHandler, type DependencyAuditHandlerOptions } from './DependencyAuditHandler.js';
export { PrivilegeAuditHandler, type PrivilegeAuditHandlerOptions } from './PrivilegeAuditHandler.js';

export interface AuditHandlerConfig {
  intent?: IntentAuditHandlerOptions;
  injection?: InjectionAuditHandlerOptions;
  dataflow?: DataflowAuditHandlerOptions;
  dependency?: DependencyAuditHandlerOptions;
  privilege?: PrivilegeAuditHandlerOptions;
}

export function createDefaultHandlers(config: AuditHandlerConfig = {}): AuditSkillHandler[] {
  return [
    new IntentAuditHandler(config.intent),
    new InjectionAuditHandler(config.injection),
    new DataflowAuditHandler(config.dataflow),
    new DependencyAuditHandler(config.dependency),
    new PrivilegeAuditHandler(config.privilege)
  ];
}
