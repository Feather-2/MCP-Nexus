import { Context, Middleware, State } from './types.js';
import { realpathSync } from 'fs';
import { resolve } from 'path';

export interface SecurityConfig {
  enableRedaction: boolean;
  enableSymlinkGuard: boolean;
  bannedArguments: string[];
  sensitivePatterns: RegExp[];
}

const DEFAULT_SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{48}/g,                 // OpenAI API Keys
  /ghp_[a-zA-Z0-9]{36}/g,                // GitHub Tokens
  /xox[baprs]-[a-zA-Z0-9-]+/g,           // Slack Tokens
  /[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{4}/g // Credit Cards (simple)
];

const DEFAULT_BANNED_ARGS = [
  '--no-preserve-root',
  '--preserve-root=false',
  '--insecure',
  '--force-yes'
];

/**
 * SecurityMiddleware
 * 参考 agentsdk-go 的安全实践，增强 MCP-Nexus 的防御能力。
 */
export class SecurityMiddleware implements Middleware {
  readonly name = 'SecurityMiddleware';
  private config: SecurityConfig;

  constructor(config?: Partial<SecurityConfig>) {
    this.config = {
      enableRedaction: config?.enableRedaction ?? true,
      enableSymlinkGuard: config?.enableSymlinkGuard ?? true,
      bannedArguments: config?.bannedArguments ?? DEFAULT_BANNED_ARGS,
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS
    };
  }

  /**
   * 工具执行前：路径检查与参数检查
   */
  async beforeTool(ctx: Context, state: State): Promise<void> {
    const toolCall = state.values.get('toolCall') as any;
    if (!toolCall) return;

    // 1. 参数级黑名单检查
    const args = JSON.stringify(toolCall.arguments || {});
    for (const banned of this.config.bannedArguments) {
      if (args.includes(banned)) {
        throw new Error(`Security Guard: Banned argument detected: "${banned}"`);
      }
    }

    // 2. 路径符号链接防护 (Symlink Guard)
    if (this.config.enableSymlinkGuard && toolCall.arguments?.path) {
      this.validatePath(toolCall.arguments.path);
    }
  }

  /**
   * 工具执行后：响应脱敏
   */
  async afterTool(ctx: Context, state: State): Promise<void> {
    if (!this.config.enableRedaction) return;

    const result = state.values.get('toolResult') as any;
    if (!result || typeof result.content !== 'string') return;

    // 3. 敏感信息脱敏 (Secret Redaction)
    let sanitized = result.content;
    for (const pattern of this.config.sensitivePatterns) {
      sanitized = sanitized.replace(pattern, (match: string) => {
        return `${match.slice(0, 4)}****${match.slice(-4)}`;
      });
    }
    
    if (sanitized !== result.content) {
      ctx.metadata.redacted = true;
      result.content = sanitized;
    }
  }

  /**
   * 模型输出检查：防止注入后的危险指令
   */
  async afterModel(ctx: Context, state: State): Promise<void> {
    const output = state.values.get('modelOutput') as any;
    if (!output || typeof output.content !== 'string') return;

    // 启发式扫描：防止 Prompt Injection 导致的破坏性建议
    const lower = output.content.toLowerCase();
    if (lower.includes('ignore previous instructions') || lower.includes('disregard all previous')) {
      ctx.metadata.injectionAttempt = true;
      // 在生产环境中可以选择直接中止
      // state.aborted = true;
      // throw new Error("Security Guard: Potential prompt injection detected");
    }
  }

  private validatePath(filePath: string): void {
    try {
      const resolvedPath = resolve(filePath);
      const realPath = realpathSync(resolvedPath);
      
      // 获取当前工作目录
      const cwd = process.cwd();
      const realCwd = realpathSync(cwd);

      // 如果提供了 ALLOWED_DIRECTORY 环境变量，则以此为准
      const allowedDir = process.env.ALLOWED_DIRECTORY 
        ? realpathSync(resolve(process.env.ALLOWED_DIRECTORY))
        : realCwd;

      if (!realPath.startsWith(allowedDir)) {
        throw new Error(`Security Guard: Access denied to path outside allowed directory: ${filePath}`);
      }
    } catch (err: any) {
      if (err.message?.includes('Security Guard')) throw err;
      // 路径不存在或解析失败，也视为不安全（除非明确允许创建）
      throw new Error(`Security Guard: Path validation failed: ${filePath}`);
    }
  }
}
