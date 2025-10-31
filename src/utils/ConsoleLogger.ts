import { Logger } from '../types/index.js';

export class ConsoleLogger implements Logger {
  private logLevel: string;
  private logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4
  };

  constructor(logLevel: string = 'info') {
    this.logLevel = logLevel;
  }

  private shouldLog(level: string): boolean {
    const currentLevel = this.logLevels[this.logLevel as keyof typeof this.logLevels] ?? 2;
    const messageLevel = this.logLevels[level as keyof typeof this.logLevels] ?? 2;
    return messageLevel <= currentLevel;
  }

  private sanitize(value: any): any {
    try {
      const sensitiveKeys = ['password', 'token', 'apiKey', 'apikey', 'secret', 'authorization', 'auth', 'x-api-key', 'set-cookie'];
      const mask = (v: string) => (typeof v === 'string' && v.length > 8) ? v.slice(0, 4) + '…' + v.slice(-4) : '***';

      const redact = (obj: any, depth = 0): any => {
        if (obj == null) return obj;
        if (depth > 5) return '[Object]';
        if (typeof obj === 'string') return obj;
        if (typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(it => redact(it, depth + 1));
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (sensitiveKeys.includes(k.toLowerCase())) {
            out[k] = mask(typeof v === 'string' ? v : JSON.stringify(v));
            continue;
          }
          out[k] = redact(v, depth + 1);
        }
        return out;
      };

      return redact(value);
    } catch {
      return value;
    }
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const formattedArgs = args.length > 0 ?
      ' ' + args.map(arg => {
        const safe = this.sanitize(arg);
        try {
          return typeof safe === 'object' ? JSON.stringify(safe, null, 2) : String(safe);
        } catch {
          return '[Unserializable]';
        }
      }).join(' ')
      : '';
    
    return `[${timestamp}] ${levelStr} ${message}${formattedArgs}`;
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, ...args));
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, ...args));
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, ...args));
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, ...args));
    }
  }

  trace(message: string, ...args: any[]): void {
    if (this.shouldLog('trace')) {
      console.trace(this.formatMessage('trace', message, ...args));
    }
  }

  setLevel(level: string): void {
    this.logLevel = level;
  }

  getLevel(): string {
    return this.logLevel;
  }
}