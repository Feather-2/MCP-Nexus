declare module 'ioredis' {
  class IORedis {
    constructor(url?: string, options?: any);
    constructor(port?: number, host?: string, options?: any);
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: any[]): Promise<string>;
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    ttl(key: string): Promise<number>;
    ping(): Promise<string>;
    info(section?: string): Promise<string>;
    quit(): Promise<string>;
    disconnect(): void;
    status: string;
  }
  export default IORedis;
}
