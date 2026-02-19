/**
 * 统一错误 Envelope - 跨边界错误传播保真
 */

export interface ErrorEnvelope {
  // 错误标识
  code: string; // 错误代码（如 'NETWORK_TIMEOUT', 'VALIDATION_FAILED'）
  fingerprint: string; // 错误指纹（用于聚合相同错误）

  // 错误内容
  message: string;
  name: string;
  stack?: string;
  cause?: ErrorEnvelope; // 原始错误（支持错误链）

  // 分类与严重性
  category: ErrorCategory;
  severity: ErrorSeverity;
  recoverable: boolean;

  // 上下文信息
  context: ErrorContext;

  // 元数据
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export type ErrorCategory =
  | 'network'
  | 'validation'
  | 'timeout'
  | 'authentication'
  | 'authorization'
  | 'resource'
  | 'internal'
  | 'external'
  | 'unknown';

export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ErrorContext {
  // 执行上下文
  runId?: string;
  traceId?: string;
  stage?: string; // 执行阶段（如 tool, orchestrator, worker）
  component?: string; // 组件名称
  operation?: string; // 操作名称

  // 服务上下文
  serviceId?: string;
  serviceName?: string;

  // 边界信息
  boundary?: 'main' | 'worker' | 'stage' | 'tool' | 'external';
  boundaryStack?: string[]; // 边界穿越栈（用于追踪错误传播路径）

  // 额外上下文
  [key: string]: unknown;
}

/**
 * 错误转换工具 - 将原生 Error 转换为 ErrorEnvelope
 */
export function toErrorEnvelope(
  error: unknown,
  context: Partial<ErrorContext> = {},
  options: {
    code?: string;
    category?: ErrorCategory;
    severity?: ErrorSeverity;
    recoverable?: boolean;
  } = {}
): ErrorEnvelope {
  let message = 'Unknown error';
  let name = 'Error';
  let stack: string | undefined;
  let cause: ErrorEnvelope | undefined;

  if (error instanceof Error) {
    message = error.message;
    name = error.name;
    stack = error.stack;

    // 递归处理 cause
    if (error.cause) {
      cause = toErrorEnvelope(error.cause, context);
    }
  } else if (typeof error === 'string') {
    message = error;
    name = 'StringError';
  } else if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    message = String(obj.message || 'Unknown object error');
    name = String(obj.name || 'ObjectError');
    stack = obj.stack as string | undefined;
  }

  // 自动分类
  const category = options.category || categorizeError(name, message);
  const severity = options.severity || inferSeverity(category);
  const recoverable = options.recoverable ?? isRecoverable(category);

  // 生成错误指纹
  const fingerprint = generateFingerprint(name, message, context.component);

  // 生成错误代码
  const code = options.code || generateErrorCode(category, name);

  return {
    code,
    fingerprint,
    message,
    name,
    stack,
    cause,
    category,
    severity,
    recoverable,
    context: context as ErrorContext,
    timestamp: new Date(),
    metadata: {}
  };
}

/**
 * 跨边界错误传播 - 添加边界信息
 */
export function propagateError(
  envelope: ErrorEnvelope,
  boundary: ErrorContext['boundary'],
  additionalContext: Partial<ErrorContext> = {}
): ErrorEnvelope {
  return {
    ...envelope,
    context: {
      ...envelope.context,
      ...additionalContext,
      boundary,
      boundaryStack: [
        ...(envelope.context.boundaryStack || []),
        boundary || 'unknown'
      ]
    }
  };
}

/**
 * 错误序列化 - 用于跨进程传输
 */
export function serializeError(envelope: ErrorEnvelope): string {
  return JSON.stringify(envelope, (key, value) => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  });
}

/**
 * 错误反序列化
 */
export function deserializeError(json: string, maxDepth = 10): ErrorEnvelope {
  const obj = JSON.parse(json);
  return {
    ...obj,
    timestamp: new Date(obj.timestamp),
    cause: obj.cause && maxDepth > 0
      ? deserializeError(JSON.stringify(obj.cause), maxDepth - 1)
      : undefined
  };
}

// 辅助函数

function categorizeError(name: string, message: string): ErrorCategory {
  const text = `${name} ${message}`.toLowerCase();

  if (text.includes('network') || text.includes('connection') || text.includes('econnrefused')) {
    return 'network';
  }
  if (text.includes('validation') || text.includes('invalid')) {
    return 'validation';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (text.includes('authentication') || text.includes('unauthorized')) {
    return 'authentication';
  }
  if (text.includes('authorization') || text.includes('forbidden')) {
    return 'authorization';
  }
  if (text.includes('resource') || text.includes('not found') || text.includes('enoent')) {
    return 'resource';
  }

  return 'unknown';
}

function inferSeverity(category: ErrorCategory): ErrorSeverity {
  switch (category) {
    case 'authentication':
    case 'authorization':
      return 'high';
    case 'network':
    case 'timeout':
      return 'medium';
    case 'validation':
    case 'resource':
      return 'low';
    default:
      return 'medium';
  }
}

function isRecoverable(category: ErrorCategory): boolean {
  switch (category) {
    case 'network':
    case 'timeout':
    case 'resource':
      return true;
    case 'validation':
    case 'authentication':
    case 'authorization':
      return false;
    default:
      return false;
  }
}

function generateFingerprint(name: string, message: string, component?: string): string {
  // 简化消息以生成稳定的指纹（移除动态部分如 ID、时间戳等）
  const normalized = message
    .replace(/\d+/g, 'N') // 数字替换为 N
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, 'UUID') // UUID
    .replace(/\b\w+@\w+\.\w+\b/g, 'EMAIL') // Email
    .toLowerCase();

  const parts = [name, normalized, component || ''].join('|');

  // 简单哈希（生产环境应使用更好的哈希算法）
  let hash = 0;
  for (let i = 0; i < parts.length; i++) {
    const char = parts.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return `err_${Math.abs(hash).toString(36)}`;
}

function generateErrorCode(category: ErrorCategory, name: string): string {
  const prefix = category.toUpperCase();
  const suffix = name.replace(/Error$/, '').toUpperCase();
  return `${prefix}_${suffix}`;
}
