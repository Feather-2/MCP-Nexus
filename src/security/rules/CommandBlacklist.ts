export interface CommandCheckResult {
  blocked: boolean;
  pattern?: string;
}

interface CommandPattern {
  id: string;
  pattern: RegExp;
}

export const DEFAULT_COMMAND_BLACKLIST: readonly CommandPattern[] = [
  // Download-and-execute chains
  { id: 'curl|bash', pattern: /\bcurl\b[^\n]{0,200}\|\s*\bbash\b/i },
  { id: 'curl|sh', pattern: /\bcurl\b[^\n]{0,200}\|\s*\bsh\b/i },
  { id: 'wget|bash', pattern: /\bwget\b[^\n]{0,200}\|\s*\bbash\b/i },
  { id: 'wget|sh', pattern: /\bwget\b[^\n]{0,200}\|\s*\bsh\b/i },

  // Destructive filesystem operations
  {
    id: 'rm -rf /',
    pattern: /\brm\b[^\n]{0,200}\s-(?:rf|fr|r\s*-f|-f\s*-r|r)\b[^\n]{0,80}\s+\/(?:\s|$)/i
  },

  // Reverse shells / remote execution helpers
  { id: 'nc -e', pattern: /\b(?:nc|netcat)\b[^\n]{0,200}\s-e\s+\S+/i },

  // Unsafe permission changes
  { id: 'chmod 777', pattern: /\bchmod\b[^\n]{0,40}(?:\s+-R)?\s+777\b/i }
];

export function checkCommand(cmd: string, patterns: readonly CommandPattern[] = DEFAULT_COMMAND_BLACKLIST): CommandCheckResult {
  const input = cmd.trim();
  if (!input) return { blocked: false };

  for (const entry of patterns) {
    if (entry.pattern.test(input)) {
      return { blocked: true, pattern: entry.id };
    }
  }

  return { blocked: false };
}
