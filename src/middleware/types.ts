export type Stage =
  | 'beforeAgent'
  | 'beforeModel'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'afterAgent';

export interface Context {
  requestId: string;
  sessionId?: string;
  startTime: number;
  metadata: Record<string, unknown>;
}

export interface State {
  stage: Stage;
  values: Map<string, unknown>;
  error?: Error;
  aborted: boolean;
}

export interface Middleware {
  name: string;
  beforeAgent?(ctx: Context, state: State): Promise<void>;
  beforeModel?(ctx: Context, state: State): Promise<void>;
  afterModel?(ctx: Context, state: State): Promise<void>;
  beforeTool?(ctx: Context, state: State): Promise<void>;
  afterTool?(ctx: Context, state: State): Promise<void>;
  afterAgent?(ctx: Context, state: State): Promise<void>;
}

