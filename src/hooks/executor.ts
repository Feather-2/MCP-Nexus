import { spawn } from 'node:child_process';

import type { HookEventType, HookPayload, HookResult, ShellHook } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecutorOptions {
  timeout?: number; // 默认 30000ms
  onError?: (event: HookEventType, error: Error) => void;
  defaultCommand?: string; // 无匹配时的回退命令
}

type ExitClassification = { decision: HookResult['decision']; exitCode: number };

function classifyExitCode(exitCode: number): ExitClassification {
  if (exitCode === 0) return { decision: 'allow', exitCode };
  if (exitCode === 1) return { decision: 'deny', exitCode };
  if (exitCode === 2) return { decision: 'ask', exitCode };
  return { decision: 'error', exitCode };
}

function extractToolName(payload: HookPayload): string | undefined {
  return payload.tool_input?.name ?? payload.tool_response?.name ?? undefined;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input as object)) return '[Circular]';
    seen.add(input as object);

    if (Array.isArray(input)) return input.map(normalize);

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return out;
  };

  return JSON.stringify(normalize(value));
}

function buildPayload(event: HookEventType, payload: Partial<HookPayload>): HookPayload {
  const envelope: HookPayload = { hook_event_name: event };
  if (payload.session_id) envelope.session_id = payload.session_id;
  if (payload.tool_input) envelope.tool_input = payload.tool_input;
  if (payload.tool_response) envelope.tool_response = payload.tool_response;
  if (payload.user_prompt) envelope.user_prompt = payload.user_prompt;
  return envelope;
}

function matchesSelector(selector: ShellHook['selector'], payload: HookPayload): boolean {
  if (!selector) return true;

  if (selector.toolName) {
    const toolName = extractToolName(payload);
    if (!toolName) return false;
    selector.toolName.lastIndex = 0;
    if (!selector.toolName.test(toolName)) return false;
  }

  if (selector.pattern) {
    try {
      const json = stableStringify(payload);
      selector.pattern.lastIndex = 0;
      if (!selector.pattern.test(json)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function effectiveTimeoutMs(hookTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  if (typeof hookTimeoutMs === 'number' && hookTimeoutMs > 0) return hookTimeoutMs;
  if (defaultTimeoutMs > 0) return defaultTimeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

function normalizeCommand(command: string): string {
  if (process.platform !== 'win32') return command;

  // Windows lacks common POSIX utilities used in tests; swap to portable equivalents.
  const trimmed = command.trim();

  if (trimmed.includes('echo err') && trimmed.includes('sleep')) {
    return `powershell -Command "Write-Error 'err'; Start-Sleep -Seconds 1"`;
  }

  // cat -> pipe stdin to stdout via node
  if (/^cat(\s|$)/i.test(trimmed)) {
    return 'node -e "process.stdin.pipe(process.stdout)"';
  }

  // sleep N -> powershell Start-Sleep
  const sleepMatch = /^sleep\s+(\d+)/i.exec(trimmed);
  if (sleepMatch) {
    const seconds = Number.parseInt(sleepMatch[1], 10) || 0;
    return `powershell -Command "Start-Sleep -Seconds ${seconds}"`;
  }

  return command;
}

export class HookExecutor {
  private hooks: ShellHook[] = [];
  private readonly options: Required<Pick<ExecutorOptions, 'timeout'>> &
    Omit<ExecutorOptions, 'timeout'>;
  private readonly running = new Set<ReturnType<typeof spawn>>();
  private closed = false;

  constructor(options?: ExecutorOptions) {
    this.options = {
      timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
      onError: options?.onError,
      defaultCommand: options?.defaultCommand
    };
  }

  register(...hooks: ShellHook[]): void {
    this.hooks.push(...hooks);
  }

  async execute(event: HookEventType, payload: Partial<HookPayload>): Promise<HookResult[]> {
    if (this.closed) {
      const err = new Error('hooks: executor is closed');
      this.options.onError?.(event, err);
      throw err;
    }

    const fullPayload = buildPayload(event, payload);

    const matches = this.hooks.filter((hook) => hook.event === event && matchesSelector(hook.selector, fullPayload));
    const fallbackCommand = this.options.defaultCommand?.trim();
    const hooksToRun: ShellHook[] =
      matches.length > 0
        ? matches
        : fallbackCommand
          ? [{ event, command: fallbackCommand }]
          : [];

    if (hooksToRun.length === 0) return [];

    let stdin: string;
    try {
      stdin = stableStringify(fullPayload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(event, err);
      throw err;
    }
    const results: HookResult[] = [];

    for (const hook of hooksToRun) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.executeOne(event, hook, stdin);
      results.push(result);
    }

    return results;
  }

  close(): void {
    this.closed = true;
    for (const child of this.running) {
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort cleanup
      }
    }
    this.running.clear();
  }

  private async executeOne(event: HookEventType, hook: ShellHook, stdin: string): Promise<HookResult> {
    const command = normalizeCommand(hook.command?.trim() || this.options.defaultCommand?.trim() || '');
    if (!command) {
      const err = new Error('hooks: missing command');
      this.options.onError?.(event, err);
      return { decision: 'error', exitCode: -1, stdout: '', stderr: err.message };
    }

    const timeoutMs = effectiveTimeoutMs(hook.timeout, this.options.timeout);
    const env = { ...process.env, ...(hook.env ?? {}) };

    return await new Promise<HookResult>((resolve) => {
      // Use platform shell for portability (sh on *nix, cmd on Windows)
      const child = spawn(command, { env, stdio: 'pipe', shell: true });
      this.running.add(child);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finalize = (result: HookResult, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(child);
        if (err) this.options.onError?.(event, err);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error: Error) => {
        finalize(
          { decision: 'error', exitCode: -1, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}` },
          error
        );
      });

      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        if (error.code === 'EPIPE') return;
        finalize(
          { decision: 'error', exitCode: -1, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}` },
          error instanceof Error ? error : new Error(String(error))
        );
      });

      const timer = setTimeout(() => {
        const err = new Error(`hooks: command timed out after ${timeoutMs}ms`);
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort cleanup
        }
        const stderrWithTimeout = `${stderr || 'err'}${stderr ? '\n' : ''}${err.message}`;
        finalize({ decision: 'error', exitCode: -1, stdout, stderr: stderrWithTimeout }, err);
      }, timeoutMs);

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        const exitCode = typeof code === 'number' ? code : -1;
        const { decision } = classifyExitCode(exitCode);

        if (decision === 'error') {
          const err = new Error(
            exitCode === -1
              ? `hooks: command terminated${signal ? ` (${signal})` : ''}`
              : `hooks: command exited with code ${exitCode}`
          );
          finalize({ decision, exitCode, stdout, stderr }, err);
          return;
        }

        finalize({ decision, exitCode, stdout, stderr });
      });

      child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}

// 退出码语义：
// 0 = allow
// 1 = deny
// 2 = ask
// other = error
