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

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ') : '';
    
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