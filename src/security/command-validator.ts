export interface ValidatorOptions {
  maxCommandBytes?: number; // 默认 4096
  maxArgs?: number; // 默认 64
  allowShellMeta?: boolean; // 默认 false，是否允许 |;&><`$
}

export const DEFAULT_BANNED_COMMANDS: Record<string, string> = {
  dd: 'raw disk writes are unsafe',
  mkfs: 'filesystem formatting is unsafe',
  fdisk: 'partition editing is unsafe',
  shutdown: 'system power management forbidden',
  reboot: 'system power management forbidden',
  halt: 'system power management forbidden',
  sudo: 'privilege escalation forbidden',
  mount: 'mount can expose host filesystem'
};

export const DEFAULT_BANNED_FRAGMENTS = [
  'rm -rf /',
  'rm -fr /',
  'rm -r /',
  '--no-preserve-root',
  '--preserve-root=false',
  'rm *',
  '> /dev/'
];

const DEFAULT_OPTIONS: Required<ValidatorOptions> = {
  maxCommandBytes: 4096,
  maxArgs: 64,
  allowShellMeta: false
};

const SHELL_META_CHARS = '|;&><`$';

function containsControlCharacters(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function splitCommand(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  const flush = () => {
    if (current.length === 0) return;
    args.push(current);
    current = '';
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      if (inSingle) {
        current += ch;
        continue;
      }
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      flush();
      continue;
    }

    current += ch;
  }

  if (escapeNext) {
    throw new Error('CommandValidator: parse failed (dangling escape)');
  }
  if (inSingle || inDouble) {
    throw new Error('CommandValidator: parse failed (unclosed quote)');
  }

  flush();
  return args;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function basenameCrossPlatform(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  const last = normalized.split('/').filter(Boolean).pop() ?? normalized;
  const lower = last.toLowerCase();
  return lower.replace(/\.(exe|cmd|bat|com)$/i, '');
}

export class CommandValidator {
  private bannedCommands: Map<string, string>;
  private bannedFragments: string[];
  private options: Required<ValidatorOptions>;

  constructor(options?: ValidatorOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
    this.bannedCommands = new Map<string, string>();
    for (const [cmd, reason] of Object.entries(DEFAULT_BANNED_COMMANDS)) {
      this.bannedCommands.set(cmd.toLowerCase(), reason);
    }
    this.bannedFragments = [...DEFAULT_BANNED_FRAGMENTS];
  }

  validate(command: string): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      throw new Error('CommandValidator: empty command');
    }

    if (this.options.maxCommandBytes > 0) {
      const bytes = Buffer.byteLength(trimmed, 'utf8');
      if (bytes > this.options.maxCommandBytes) {
        throw new Error(`CommandValidator: command too long (${bytes} bytes)`);
      }
    }

    if (containsControlCharacters(trimmed)) {
      throw new Error('CommandValidator: control characters detected');
    }

    if (!this.options.allowShellMeta && [...trimmed].some((ch) => SHELL_META_CHARS.includes(ch))) {
      throw new Error('CommandValidator: shell metacharacters are blocked');
    }

    const args = splitCommand(trimmed);
    if (args.length === 0) {
      throw new Error('CommandValidator: empty command');
    }

    if (this.options.maxArgs > 0 && args.length > this.options.maxArgs) {
      throw new Error(`CommandValidator: too many arguments (${args.length})`);
    }

    const commandToken = args.find((token) => !isEnvAssignment(token)) ?? args[0]!;
    const base = basenameCrossPlatform(commandToken);
    const bannedReason = this.bannedCommands.get(base);
    if (bannedReason) {
      throw new Error(`CommandValidator: banned command "${base}" (${bannedReason})`);
    }

    const lower = trimmed.toLowerCase();
    for (const fragment of this.bannedFragments) {
      if (!fragment) continue;
      if (lower.includes(fragment.toLowerCase())) {
        throw new Error(`CommandValidator: banned fragment "${fragment}"`);
      }
    }
  }

  addBannedCommand(cmd: string, reason: string): void {
    const normalized = basenameCrossPlatform(cmd.trim());
    if (!normalized) return;
    this.bannedCommands.set(normalized, reason);
  }

  addBannedFragment(fragment: string): void {
    const value = fragment.trim();
    if (!value) return;
    this.bannedFragments.push(value);
  }

  setAllowShellMeta(allow: boolean): void {
    this.options.allowShellMeta = allow;
  }
}

