import { Context, Middleware, State } from './types.js';
import { realpath } from 'fs/promises';
import { resolve } from 'path';

export interface SecurityConfig {
  enableRedaction: boolean;
  enableSymlinkGuard: boolean;
  bannedArguments: string[];
  sensitivePatterns: RegExp[];
}

const DEFAULT_SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{48}/,                 // OpenAI API Keys
  /ghp_[a-zA-Z0-9]{36}/,                // GitHub Tokens
  /xox[baprs]-[a-zA-Z0-9-]+/,           // Slack Tokens
  /[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{4}/ // Credit Cards (simple)
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
  private globalPatterns: RegExp[];
  private cachedAllowedDir?: string;

  constructor(config?: Partial<SecurityConfig>) {
    this.config = {
      enableRedaction: config?.enableRedaction ?? true,
      enableSymlinkGuard: config?.enableSymlinkGuard ?? true,
      bannedArguments: config?.bannedArguments ?? DEFAULT_BANNED_ARGS,
      sensitivePatterns: config?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS
    };
    this.globalPatterns = this.config.sensitivePatterns.map(p => {
      const flags = p.flags.includes('g') ? p.flags : p.flags + 'g';
      return new RegExp(p.source, flags);
    });
  }

  /**
   * 工具执行前：路径检查与参数检查
   */
  async beforeTool(ctx: Context, state: State): Promise<void> {
    const toolCall = state.values.get('toolCall') as Record<string, unknown> | undefined;
    if (!toolCall) return;

    // 1. 参数级黑名单检查
    const args = JSON.stringify(toolCall.arguments || {});
    for (const banned of this.config.bannedArguments) {
      if (args.includes(banned)) {
        throw new Error(`Security Guard: Banned argument detected: "${banned}"`);
      }
    }

    // 2. 路径符号链接防护 (Symlink Guard)
    const toolArgs = toolCall.arguments as Record<string, unknown> | undefined;
    if (this.config.enableSymlinkGuard && toolArgs?.path) {
      await this.validatePath(String(toolArgs.path));
    }
  }

  /**
   * 工具执行后：响应脱敏
   */
  async afterTool(ctx: Context, state: State): Promise<void> {
    if (!this.config.enableRedaction) return;

    const result = state.values.get('toolResult') as Record<string, unknown> | undefined;
    if (!result || typeof result.content !== 'string') return;

    // 3. 敏感信息脱敏 (Secret Redaction)
    let sanitized = result.content;
    for (const globalPattern of this.globalPatterns) {
      globalPattern.lastIndex = 0;
      sanitized = sanitized.replace(globalPattern, (match: string) => {
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
    const output = state.values.get('modelOutput') as Record<string, unknown> | undefined;
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

  private async resolveAllowedDir(): Promise<string> {
    if (this.cachedAllowedDir) return this.cachedAllowedDir;
    const cwd = process.cwd();
    const realCwd = await realpath(cwd);
    this.cachedAllowedDir = process.env.ALLOWED_DIRECTORY
      ? await realpath(resolve(process.env.ALLOWED_DIRECTORY))
      : realCwd;
    return this.cachedAllowedDir;
  }

  private async validatePath(filePath: string): Promise<void> {
    try {
      const resolvedPath = resolve(filePath);
      const realPath = await realpath(resolvedPath);
      const allowedDir = await this.resolveAllowedDir();

      if (!realPath.startsWith(allowedDir)) {
        throw new Error(`Security Guard: Access denied to path outside allowed directory: ${filePath}`);
      }
    } catch (err: unknown) {
      if ((err as Error)?.message?.includes('Security Guard')) throw err;
      throw new Error(`Security Guard: Path validation failed: ${filePath}`, { cause: err });
    }
  }
}
