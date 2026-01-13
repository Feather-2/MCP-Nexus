# Orchestrator Module

任务编排引擎，支持多服务协作和自动任务规划。

## Structure

```
orchestrator/
├── OrchestratorEngine.ts   # 编排引擎入口
├── OrchestratorManager.ts  # 编排器配置管理
├── SubagentLoader.ts       # 子代理加载器
├── SubagentScheduler.ts    # 子代理调度器
├── planning/               # 规划系统
│   └── LocalPlanner.ts
└── types.ts
```

## Key Classes

### OrchestratorEngine

编排执行入口：
- `execute(req)` - 执行编排任务
- `buildPlan(goal, steps, config)` - 构建执行计划
- `runStep(step)` - 执行单个步骤

配置项：
- `maxSteps` - 最大步骤数 (默认 8)
- `timeoutMs` - 超时时间 (默认 5 分钟)
- `concurrency.global` - 全局并发数 (默认 8)
- `concurrency.perSubagent` - 每子代理并发数 (默认 2)

### SubagentScheduler

调度器，支持：
- 并行/串行执行
- 超时控制
- 错误隔离

### LocalPlanner

本地规划器，将目标分解为可执行步骤。

## Types

```typescript
interface ExecuteRequest {
  goal: string;
  steps?: OrchestratorStep[];
  maxSteps?: number;
  timeoutMs?: number;
  parallel?: boolean;
}

interface ExecuteResult {
  results: StepResult[];
  totalTime: number;
}
```

## Common Tasks

```typescript
// 执行编排任务
const result = await engine.execute({
  goal: 'Analyze code and generate report',
  maxSteps: 5,
  parallel: true
});

// 加载所有子代理
await subagentLoader.loadAll();
```
