export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd';

export type HookDecision = 'allow' | 'deny' | 'ask' | 'error';

export interface HookSelector {
  toolName?: RegExp;
  pattern?: RegExp;
}

export interface ShellHook {
  event: HookEventType;
  command: string;
  selector?: HookSelector;
  timeout?: number; // ms, 默认 30000
  env?: Record<string, string>;
  name?: string; // 调试标签
}

export interface HookResult {
  decision: HookDecision;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookPayload {
  hook_event_name: HookEventType;
  session_id?: string;
  tool_input?: { name: string; params: unknown };
  tool_response?: { name: string; result: unknown; error?: string };
  user_prompt?: string;
}

