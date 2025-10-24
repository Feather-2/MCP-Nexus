import { Logger } from '../types/index.js';
import chalk from 'chalk';

export class SimpleLogger implements Logger {
  private logLevel: number;
  private levels = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4
  };

  constructor(level: keyof typeof SimpleLogger.prototype.levels = 'info') {
    this.logLevel = this.levels[level];
  }

  trace(message: string, meta?: any): void {
    if (this.logLevel <= this.levels.trace) {
      this.log('TRACE', chalk.gray(message), meta);
    }
  }

  debug(message: string, meta?: any): void {
    if (this.logLevel <= this.levels.debug) {
      this.log('DEBUG', chalk.blue(message), meta);
    }
  }

  info(message: string, meta?: any): void {
    if (this.logLevel <= this.levels.info) {
      this.log('INFO', chalk.green(message), meta);
    }
  }

  warn(message: string, meta?: any): void {
    if (this.logLevel <= this.levels.warn) {
      this.log('WARN', chalk.yellow(message), meta);
    }
  }

  error(message: string, meta?: any): void {
    if (this.logLevel <= this.levels.error) {
      this.log('ERROR', chalk.red(message), meta);
    }
  }

  private log(level: string, message: string, meta?: any): void {
    const timestamp = new Date().toISOString();
    const prefix = chalk.gray(`[${timestamp}] ${level}:`);
    
    if (meta) {
      console.log(`${prefix} ${message}`, meta);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}