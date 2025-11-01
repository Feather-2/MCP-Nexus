// Minimal ioredis type shim to satisfy TS in environments
// where @types or module resolution might be unavailable.
declare module 'ioredis' {
  export default class IORedis {
    constructor(urlOrOpts?: any);
    ping(): Promise<string>;
    quit(): Promise<void>;
  }
}
