import { BehaviorValidator, type ExecutionTrace } from '../security/BehaviorValidator.js';
import type { Logger } from '../types/index.js';
import type { Skill } from './types.js';

export type SkillToolRequest =
  | {
      type: 'filesystem';
      operation: 'read' | 'write';
      path: string;
    }
  | {
      type: 'network';
      host: string;
      port: number;
    }
  | {
      type: 'subprocess';
      command: string;
      argv?: string[];
    };

export interface SkillExecutorOptions {
  logger?: Logger;
}

function buildTraceFromRequest(request: SkillToolRequest): ExecutionTrace {
  if (request.type === 'filesystem') {
    return {
      fileAccesses: [{ path: request.path, operation: request.operation }],
      networkConnections: [],
      envAccessed: [],
      subprocesses: []
    };
  }

  if (request.type === 'network') {
    return {
      fileAccesses: [],
      networkConnections: [{ host: request.host, port: request.port }],
      envAccessed: [],
      subprocesses: []
    };
  }

  return {
    fileAccesses: [],
    networkConnections: [],
    envAccessed: [],
    subprocesses: [{ command: request.command, argv: request.argv }]
  };
}

function describeRequest(request: SkillToolRequest): string {
  if (request.type === 'filesystem') return `filesystem ${request.operation} ${request.path}`;
  if (request.type === 'network') return `network ${request.host}:${request.port}`;
  return `subprocess ${request.command}`;
}

function assertRequestShape(request: SkillToolRequest): void {
  if (request.type === 'filesystem') {
    if (!request.path || !request.path.trim()) throw new Error('filesystem path is required');
    return;
  }
  if (request.type === 'network') {
    if (!request.host || !request.host.trim()) throw new Error('network host is required');
    if (!Number.isInteger(request.port) || request.port <= 0 || request.port > 65535) {
      throw new Error('network port must be an integer between 1 and 65535');
    }
    return;
  }
  if (!request.command || !request.command.trim()) {
    throw new Error('subprocess command is required');
  }
}

export class SkillExecutor {
  private readonly logger?: Logger;
  private readonly behaviorValidator = new BehaviorValidator();

  constructor(options?: SkillExecutorOptions) {
    this.logger = options?.logger;
  }

  validate(skill: Skill, request: SkillToolRequest): void {
    assertRequestShape(request);

    const trace = buildTraceFromRequest(request);
    const result = this.behaviorValidator.validate(skill.capabilities, trace);
    if (result.violations.length === 0) return;

    const first = result.violations[0];
    const action = describeRequest(request);
    this.logger?.warn('Skill runtime capability check failed', {
      skill: skill.metadata.name,
      action,
      reason: first?.message,
      violations: result.violations
    });
    throw new Error(`Skill "${skill.metadata.name}" is not allowed to ${action}: ${first?.message || 'permission denied'}`);
  }

  async execute<T>(skill: Skill, request: SkillToolRequest, run: () => Promise<T>): Promise<T> {
    this.validate(skill, request);
    return run();
  }
}
