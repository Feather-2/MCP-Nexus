# MCP Gateway 元能力（Meta-Capabilities）路线图

**创建日期**：2025-11-05
**状态**：规划中
**优先级**：P2（中期目标）

---

## 🎯 愿景概述

让 MCP Gateway 具备**元能力（Meta-Capabilities）**，即通过开放的 API 将自身能力组装成新的 MCP 工具，实现"自我调用"和"自我扩展"能力。本质上是让 MCP Gateway 成为一个**"MCP 的 MCP"**，具备自举（bootstrapping）能力。

---

## 💡 核心概念

### 什么是元能力？

**元能力**是指系统能够：
1. 将自身的功能作为构建块（building blocks）
2. 通过组合这些构建块创建新的高阶功能
3. 新功能可以再次被用作构建块（递归组合）
4. 保留操作历史和模式（记忆与学习）

### MCP Gateway 的元能力表现

```
┌─────────────────────────────────────────────────────┐
│         MCP Gateway (Meta Layer)                     │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐│
│  │ Orchestrator │──│  Generator   │──│   Memory   ││
│  └──────────────┘  └──────────────┘  └────────────┘│
│         │                 │                 │        │
│         └─────────────────┴─────────────────┘        │
│                        │                             │
│                        ▼                             │
│            Compose New MCP Tools                     │
│                                                       │
└─────────────────────────────────────────────────────┘
                        │
                        ▼
              New MCP Service (Self-Generated)
              - Can call original gateway APIs
              - Can be used by other services
              - Can compose with other MCPs
```

---

## 🚀 核心场景

### 🆕 场景 0：半动态工作流（Semi-Dynamic Workflow）

**核心思想**："Freeze to Workflow" - 在确保灵活性的同时优化重复任务

#### 问题背景

在 AI 对话场景中，经常遇到相似的需求：
- **Token 消耗大**：每次都需要重新规划和组合 MCP
- **成功率不稳定**：动态组合可能遇到各种问题
- **响应速度慢**：需要多轮推理和调用

#### "Freeze to Workflow" 机制

**触发方式（3 种）**：

```
方式 1: 用户主动触发
┌──────────────────────────────────────┐
│ 用户："保存这个流程" / "记住这个做法" │
└──────────────────────────────────────┘
                │
                ▼
        立即 Freeze 当前执行


方式 2: AI 推荐确认
┌──────────────────────────────────────┐
│  任务完成后，AI 检测到可复用模式      │
└──────────────────────────────────────┘
                │
                ▼
        AI: "这个任务要保存成固定流程吗？"
                │
        ┌───────┴───────┐
        │               │
     用户说 yes      用户说 no
        │               │
        ▼               ▼
    Freeze         仅记录轨迹


方式 3: 自动静默固化
┌──────────────────────────────────────┐
│  检测到同一模式成功执行 ≥ 3 次        │
│  (通过执行轨迹指纹匹配)               │
└──────────────────────────────────────┘
                │
                ▼
        自动 Freeze（后台静默）
                │
                ▼
        在 UI 展示 "新增固化流程：xxx"
```

**执行流程**：

```
┌──────────────────────────────────────────────────────┐
│              新的用户需求                             │
└──────────────────────────────────────────────────────┘
                    │
                    ▼
        ┌────────────────────────┐
        │  检查是否有 Frozen      │
        │  Workflow 可用          │
        └────────────────────────┘
                │
        ┌───────┴────────┐
        │                │
        ▼                ▼
    找到可用的        没有匹配
   Frozen Workflow
        │                │
        ▼                ▼
  ┌─────────────┐   ┌──────────────┐
  │ 直接执行     │   │ 动态编排调用  │
  │ (0 规划)    │   │  (完整推理)   │
  └─────────────┘   └──────────────┘
        │                │
        │                ├─→ 执行成功
        │                │      │
        │                │      ▼
        │                │   记录轨迹
        │                │   (累计执行次数)
        │                │      │
        ▼                ▼      ▼
  ┌────────────────────────────────┐
  │      返回结果                   │
  └────────────────────────────────┘
```

#### 优势对比

| 维度 | 传统动态方式 | 半动态工作流 | 改进 |
|------|-------------|-------------|------|
| **Token 消耗** | 每次完整规划 | 匹配时跳过规划 | ⬇️ 60-80% |
| **响应速度** | 多轮推理 | 直接执行 | ⬆️ 3-5x |
| **成功率** | 不稳定 | 已验证流程 | ⬆️ 20-30% |
| **灵活性** | 完全灵活 | 保持灵活 | ✅ 不变 |

#### 实现要点

**A. 执行轨迹指纹（判断是否同一模式）**
```typescript
interface ExecutionFingerprint {
  // 工具调用序列
  toolSequence: string[];  // ['web-search', 'scraper', 'summarizer', 'notion']

  // 参数模式（不是具体值，而是类型）
  paramPatterns: Record<string, string>;
  // 例如：{ query: 'string', maxResults: 'number', saveToNotion: 'boolean' }

  // 数据流模式
  dataFlowPattern: string;
  // 例如：'step1.output → step2.input → step3.input → step4.input'
}

// 指纹匹配逻辑
function fingerprints Match(fp1: ExecutionFingerprint, fp2: ExecutionFingerprint): boolean {
  // 工具序列完全一致
  const sameTools = JSON.stringify(fp1.toolSequence) === JSON.stringify(fp2.toolSequence);

  // 参数模式基本一致（允许 20% 差异）
  const paramSimilarity = calculateParamSimilarity(fp1.paramPatterns, fp2.paramPatterns);

  return sameTools && paramSimilarity >= 0.8;
}
```

**B. 固化工作流存储（极简版）**
```typescript
interface FrozenWorkflow {
  id: string;
  name: string;  // 用户给的名字或自动生成，如 "research-and-save"

  // 执行指纹（用于匹配）
  fingerprint: ExecutionFingerprint;

  // 工作流定义（就是保存的执行步骤）
  steps: Array<{
    tool: string;
    action: string;
    params: Record<string, any>;  // 可以包含占位符，如 {{topic}}
  }>;

  // 统计数据
  stats: {
    successCount: number;    // 成功执行次数
    lastUsed: Date;
    avgTokenSaved: number;   // 平均节省 token
  };

  enabled: boolean;  // 用户可以随时禁用
}
```

**C. 简单的匹配逻辑**
```typescript
class FrozenWorkflowMatcher {
  // 在执行完成后记录轨迹
  async recordExecution(execution: TaskExecution): Promise<void> {
    const fingerprint = this.extractFingerprint(execution);

    // 检查是否有匹配的 frozen workflow
    const existing = this.findByFingerprint(fingerprint);

    if (existing) {
      // 累加成功次数
      existing.stats.successCount++;

      // 如果达到 3 次，且用户没主动 freeze，则自动 freeze
      if (existing.stats.successCount >= 3 && !existing.userCreated) {
        await this.autoFreeze(existing);
      }
    } else {
      // 新模式，记录下来
      await this.saveExecutionTrace(fingerprint, execution);
    }
  }

  // 在新请求到来时，检查是否可以用 frozen workflow
  async tryMatch(plannedExecution: TaskExecution): Promise<FrozenWorkflow | null> {
    const fingerprint = this.extractFingerprint(plannedExecution);

    // 遍历所有启用的 frozen workflows
    for (const frozen of this.getAllEnabled()) {
      if (fingerprintsMatch(fingerprint, frozen.fingerprint)) {
        return frozen;  // 找到了！直接用
      }
    }

    return null;  // 没找到，走动态编排
  }
}
```

---

### 场景 1：动态编排 MCP 服务组合

**用例**：通过 API 调用 Orchestrator 动态组装多个 MCP

```typescript
// 用户通过 API 定义一个工作流
POST /api/orchestrator/compose
{
  "name": "multi-search-workflow",
  "description": "Search across multiple sources and summarize",
  "steps": [
    { "tool": "web-search-mcp", "action": "search", "input": "{{query}}" },
    { "tool": "github-mcp", "action": "search_repos", "input": "{{query}}" },
    { "tool": "ai-summarizer-mcp", "action": "summarize", "input": "{{results}}" }
  ],
  "outputAs": "new-mcp-tool"
}

// Gateway 自动生成一个新的 MCP 工具
Response: {
  "toolId": "composed-search-v1",
  "mcpEndpoint": "/api/local-proxy/tools?serviceId=composed-search-v1",
  "schema": { ... }
}
```

**实现要点**：
- Orchestrator 需要支持将编排结果导出为标准 MCP 工具
- 生成的工具可以被其他服务调用
- 工具定义可以持久化和版本管理

---

### 场景 2：对话历史转化为可复用工具

**用例**：将用户对话中的 MCP 操作序列转化为新工具

```typescript
// 用户在对话中执行了一系列操作
User: "搜索 TypeScript 最佳实践"
Assistant: [calls web-search-mcp]
User: "总结前三条结果"
Assistant: [calls summarizer-mcp]
User: "保存到我的笔记"
Assistant: [calls notion-mcp]

// 用户希望将这个流程固化为工具
User: "把这个流程保存为一个新的 MCP 工具叫 'research-and-save'"

// Gateway 调用 Generator API
POST /api/generator/from-conversation
{
  "conversationId": "conv-12345",
  "toolName": "research-and-save",
  "parameters": ["topic"],
  "includeSteps": [1, 2, 3]  // 对话中的步骤索引
}

// Generator 生成新的 MCP 工具
Response: {
  "toolId": "research-and-save",
  "generated": {
    "mcpConfig": { ... },
    "implementation": "...",
    "schema": { ... }
  },
  "downloadUrl": "/api/generator/download/research-and-save.zip"
}
```

**实现要点**：
- 需要记录对话中的 MCP 调用历史
- 抽象出可参数化的模式
- 自动生成 tool schema 和实现代码

---

### 场景 3：自引用（Self-Reference）能力

**用例**：生成的 MCP 工具可以调用 Gateway 自身的 API

```typescript
// 生成的工具定义
{
  "name": "smart-orchestrator",
  "description": "Intelligently orchestrate MCPs based on user intent",
  "implementation": {
    "steps": [
      {
        "call": "self://api/orchestrator/plan",  // 🔥 调用自己的 API
        "input": "{{userQuery}}"
      },
      {
        "call": "self://api/orchestrator/execute",
        "input": "{{plan}}"
      },
      {
        "call": "self://api/generator/generate",  // 🔥 再次调用自己
        "input": {
          "source": "{{result}}",
          "format": "mcp-tool"
        }
      }
    ]
  }
}
```

**实现要点**：
- 支持 `self://` 协议引用自身 API
- 防止无限递归（设置调用深度限制）
- 权限管理（自生成工具的权限范围）

---

### 🆕 场景 3.5：执行轨迹自动记录（Execution Trace）

**核心思想**：任务成功后自动记录执行指纹，累计到一定次数自动 freeze

#### 问题背景

传统做法需要手动识别和保存重复模式：
- ❌ **人工识别**：用户自己发现"这个任务做过好几次了"
- ❌ **手动操作**：每次都要手动保存
- ❌ **丢失机会**：很多可复用的模式被忽略

#### 自动记录机制（极简版）

```
┌─────────────────────────────────────┐
│      任务成功执行完成                │
└─────────────────────────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 提取执行指纹      │
    │ (工具序列+参数)   │
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 查找匹配的记录    │
    └──────────────────┘
              │
      ┌───────┴───────┐
      │               │
   找到了          没找到
      │               │
      ▼               ▼
  累计次数 +1     新建记录
      │               │
      ▼               │
  次数 ≥ 3?          │
      │               │
   ┌──┴──┐           │
   │     │           │
  是    否           │
   │     │           │
   ▼     └───────────┘
自动 Freeze        结束
   │
   ▼
通知用户
"已自动保存流程：xxx"
```

#### 记录内容（够用就行）

**就记录这些**：

```typescript
interface ExecutionRecord {
  id: string;
  timestamp: Date;
  userQuery: string;  // 原始需求

  // 执行指纹（用于匹配）
  fingerprint: {
    toolSequence: string[];  // ['web-search', 'scraper', 'summarizer', 'notion']
    paramTypes: Record<string, string>;  // { query: 'string', maxResults: 'number' }
  };

  // 实际执行的步骤（用于 freeze）
  steps: Array<{
    tool: string;
    action: string;
    params: Record<string, any>;  // 实际参数值
    duration: number;  // ms
    success: boolean;
  }>;

  // 统计数据
  stats: {
    totalDuration: number;  // ms
    tokenUsed: number;
    success: boolean;
  };

  // 匹配计数（用于自动 freeze）
  matchCount: number;  // 这个指纹模式累计执行了几次
}
```

**示例**：

```json
{
  "id": "exec-001",
  "timestamp": "2025-11-05T14:32:00Z",
  "userQuery": "搜索 TypeScript 最佳实践并总结保存",

  "fingerprint": {
    "toolSequence": ["web-search", "scraper", "summarizer", "notion"],
    "paramTypes": { "query": "string", "maxResults": "number" }
  },

  "steps": [
    {
      "tool": "web-search",
      "action": "search",
      "params": { "query": "TypeScript best practices", "maxResults": 10 },
      "duration": 2100,
      "success": true
    },
    // ... 其他步骤
  ],

  "stats": {
    "totalDuration": 12300,
    "tokenUsed": 365,
    "success": true
  },

  "matchCount": 1  // 第 1 次执行这个模式
}
```

#### 实现逻辑（直截了当）

```typescript
class ExecutionRecorder {
  // 执行完成后调用
  async recordExecution(execution: TaskExecution): Promise<void> {
    // 1. 提取指纹
    const fingerprint = {
      toolSequence: execution.steps.map(s => s.tool),
      paramTypes: this.extractParamTypes(execution.steps[0].params)
    };

    // 2. 查找匹配的记录
    const existing = await this.findByFingerprint(fingerprint);

    if (existing) {
      // 找到了，累计次数
      existing.matchCount++;
      await this.db.update(existing);

      // 达到 3 次？自动 freeze
      if (existing.matchCount === 3) {
        await this.autoFreeze(existing);
        console.log(`🎉 已自动保存流程：${this.generateName(existing)}`);
      }
    } else {
      // 新模式，保存
      const record: ExecutionRecord = {
        id: uuid(),
        timestamp: new Date(),
        userQuery: execution.userQuery,
        fingerprint,
        steps: execution.steps,
        stats: {
          totalDuration: execution.duration,
          tokenUsed: execution.tokenUsed,
          success: true
        },
        matchCount: 1
      };
      await this.db.insert(record);
    }
  }

  // 自动固化
  private async autoFreeze(record: ExecutionRecord): Promise<void> {
    const workflow: FrozenWorkflow = {
      id: uuid(),
      name: this.generateName(record),  // 例如："search-scrape-summarize-save"
      fingerprint: record.fingerprint,
      steps: record.steps,
      stats: {
        successCount: record.matchCount,
        lastUsed: new Date(),
        avgTokenSaved: 250  // 估算值
      },
      enabled: true
    };

    await this.workflowStore.save(workflow);
  }

  // 生成名字（从工具序列）
  private generateName(record: ExecutionRecord): string {
    return record.fingerprint.toolSequence.join('-');
  }
}
```

#### 优势

| 维度 | 人工固化 | 自动记录 | 改进 |
|------|---------|---------|------|
| **及时性** | 事后手动 | 实时自动 | ⬆️ 100% |
| **覆盖率** | 可能遗漏 | 全量捕获 | ⬆️ 显著 |
| **复用率** | 需要想起来 | 自动匹配 | ⬆️ 显著 |

---

### 🆕 场景 3.7：Workflow 效率提升工具生成（Generator++）

**核心思想**：为了优化 workflow，自动生成可执行的单体工具（Node.js/Python/Go）

#### 使用场景

**场景 A：填补工具空白**
```
用户执行 workflow 时发现：
"我需要把这 100 个 JSON 文件合并成一个，但现在没有合适的 MCP 工具"

系统响应：
1. 分析需求：合并 JSON 文件
2. 选择语言：Node.js（文件操作简单）
3. 生成脚本：merge-json.js
4. 集成到 workflow：直接可用
```

**场景 B：优化性能瓶颈**
```
用户的 workflow：
Step 1: 调用 API 获取 1000 条数据（耗时 5s）
Step 2: 逐条处理（Python MCP，耗时 30s）
Step 3: 保存结果

系统检测到瓶颈在 Step 2，自动生成：
- batch-processor.py（并行处理版本）
- 耗时降低到 3s
```

#### 实现机制

```
┌─────────────────────────────────┐
│  检测到 Workflow 可优化点        │
│  - 缺少工具                      │
│  - 性能瓶颈                      │
│  - 用户明确要求                  │
└─────────────────────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 分析需求          │
    │ - 输入/输出       │
    │ - 性能要求        │
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 选择最佳语言      │
    │ Node.js / Python  │
    │ / Go             │
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 调用 AI 生成代码  │
    │ (通过 Generator)  │
    └──────────────────┘
              │
              ▼
    ┌──────────────────┐
    │ 测试 & 验证       │
    │ (沙箱执行)        │
    └──────────────────┘
              │
      ┌───────┴───────┐
      │               │
     通过          失败
      │               │
      ▼               ▼
  集成到 Workflow   提示用户
```

#### API 设计

```typescript
// 生成单体工具
POST /api/generator/create-tool
{
  "purpose": "merge-json-files",  // 用途描述
  "language": "nodejs",  // nodejs | python | go
  "requirements": {
    "input": "directory containing JSON files",
    "output": "single merged JSON file",
    "performance": "handle 1000+ files"
  },
  "integrationTarget": "workflow-step-2"  // 可选：直接替换某个步骤
}

Response: {
  "toolId": "merge-json-v1",
  "language": "nodejs",
  "files": {
    "merge-json.js": "...",
    "package.json": "...",
    "README.md": "..."
  },
  "usage": {
    "command": "node merge-json.js --input ./data --output merged.json",
    "docker": "docker run merge-json:latest ..."
  },
  "testResults": {
    "passed": true,
    "performance": "1000 files in 0.8s"
  }
}
```

#### 语言选择策略

| 需求类型 | 推荐语言 | 理由 |
|---------|---------|------|
| 文件操作、JSON/YAML 处理 | Node.js | 生态丰富，启动快 |
| 数据分析、科学计算 | Python | numpy/pandas 强大 |
| 高性能并发、系统级操作 | Go | 性能好，部署简单 |
| 文本处理、脚本任务 | Node.js | 异步 I/O 优秀 |

#### 示例：自动生成的工具

**Node.js 工具**（合并 JSON）
```javascript
// merge-json.js
const fs = require('fs').promises;
const path = require('path');

async function mergeJsonFiles(inputDir, outputFile) {
  const files = await fs.readdir(inputDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const merged = [];
  for (const file of jsonFiles) {
    const content = await fs.readFile(path.join(inputDir, file), 'utf-8');
    merged.push(...JSON.parse(content));
  }

  await fs.writeFile(outputFile, JSON.stringify(merged, null, 2));
  console.log(`✅ Merged ${jsonFiles.length} files → ${outputFile}`);
}

// CLI
const args = process.argv.slice(2);
const inputDir = args[0] || './data';
const outputFile = args[1] || './merged.json';

mergeJsonFiles(inputDir, outputFile).catch(console.error);
```

**Python 工具**（并行数据处理）
```python
# batch-processor.py
import sys
import json
from concurrent.futures import ThreadPoolExecutor

def process_item(item):
    # 处理逻辑
    return {"id": item["id"], "processed": True}

def batch_process(input_file, output_file, workers=10):
    with open(input_file) as f:
        data = json.load(f)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(process_item, data))

    with open(output_file, 'w') as f:
        json.dump(results, f)

    print(f"✅ Processed {len(results)} items")

if __name__ == '__main__':
    batch_process(sys.argv[1], sys.argv[2])
```

**Go 工具**（高性能文件扫描）
```go
// file-scanner.go
package main

import (
    "fmt"
    "os"
    "path/filepath"
    "sync"
)

func scanFiles(dir string) ([]string, error) {
    var files []string
    var mu sync.Mutex

    err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
        if err == nil && !info.IsDir() {
            mu.Lock()
            files = append(files, path)
            mu.Unlock()
        }
        return nil
    })

    return files, err
}

func main() {
    files, _ := scanFiles(os.Args[1])
    fmt.Printf("✅ Found %d files\n", len(files))
}
```

#### 集成方式

**方式 1：直接执行**
```typescript
// 在 workflow 中直接调用
{
  "step": "merge-data",
  "type": "exec",
  "command": "node merge-json.js ./input ./output.json"
}
```

**方式 2：包装成 MCP**
```typescript
// 自动包装成 MCP 工具
{
  "step": "merge-data",
  "tool": "merge-json-mcp",  // 自动生成的 MCP wrapper
  "params": {
    "inputDir": "./input",
    "outputFile": "./output.json"
  }
}
```

#### 与 Generator 的区别

| 维度 | Generator（现有） | Generator++（新） |
|------|------------------|------------------|
| **目标** | 生成 MCP 骨架代码 | 生成完整可用工具 |
| **输出** | 项目模板 | 可执行脚本 |
| **用途** | 开发新 MCP 服务 | 优化现有 workflow |
| **复杂度** | 需要后续开发 | 立即可用 |
| **语言** | 主要 TypeScript | Node.js/Python/Go |

---

### 场景 4：技能记忆（Skills Memory）

**用例**：保存和复用成功的 MCP 组合模式

```typescript
// 系统自动识别成功的模式
POST /api/memory/skills
{
  "pattern": {
    "name": "research-workflow",
    "frequency": 15,  // 使用次数
    "successRate": 0.93,
    "steps": [
      { "tool": "search", "params": {...} },
      { "tool": "summarize", "params": {...} },
      { "tool": "save", "params": {...} }
    ]
  },
  "context": {
    "useCases": ["research", "learning", "note-taking"],
    "avgDuration": 12.5,  // seconds
    "userSatisfaction": 4.8
  }
}

// 下次用户提出类似需求时自动推荐
GET /api/memory/skills/recommend?intent=research
Response: {
  "recommendations": [
    {
      "skillId": "research-workflow",
      "confidence": 0.87,
      "reason": "Used 15 times with 93% success rate",
      "canGenerateAsTool": true
    }
  ]
}
```

**实现要点**：
- 记录所有成功的 MCP 组合模式
- 基于使用频率和成功率推荐
- 支持将记忆模式转化为实际工具

---

## 🏗️ 技术架构

### 新增组件

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Gateway (Enhanced)                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Meta Controller (新增)                               │  │
│  │  - 管理元能力的生命周期                               │  │
│  │  - 协调 Orchestrator + Generator + Memory            │  │
│  │  - 处理自引用和递归调用                               │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                   │
│         ┌─────────────────┼─────────────────┐                │
│         ▼                 ▼                 ▼                │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │Orchestr- │      │Generator │      │ Memory   │          │
│  │ator API  │      │   API    │      │  Store   │          │
│  │(增强)    │      │  (增强)  │      │  (新增)  │          │
│  └──────────┘      └──────────┘      └──────────┘          │
│       │                 │                  │                 │
│       └─────────────────┴──────────────────┘                 │
│                         │                                     │
│                         ▼                                     │
│              Self-Reference Handler                          │
│              - 解析 self:// 协议                             │
│              - 权限检查                                       │
│              - 递归深度限制                                   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### API 扩展

#### 1. **Meta Controller API** (新增)

```typescript
// 创建元工具
POST /api/meta/compose
Body: {
  name: string;
  type: 'orchestration' | 'conversation-based' | 'pattern-based';
  source: object;  // 根据 type 不同而不同
  options: {
    allowSelfReference?: boolean;
    maxRecursionDepth?: number;
    permissions?: string[];
  }
}

// 列出所有元工具
GET /api/meta/tools

// 执行元工具
POST /api/meta/execute/:toolId
Body: { input: any }

// 删除元工具
DELETE /api/meta/tools/:toolId
```

#### 2. **Orchestrator API 增强**

```typescript
// 现有: 执行编排
POST /api/orchestrator/execute

// 新增: 导出编排为 MCP 工具
POST /api/orchestrator/export-as-mcp
Body: {
  orchestrationId: string;
  toolName: string;
  parameters: Array<{name: string, type: string}>;
}

// 新增: 从模板创建编排
POST /api/orchestrator/from-template
Body: {
  templateName: string;
  variables: object;
}
```

#### 3. **Generator API 增强**

```typescript
// 现有: 从各种源生成 MCP
POST /api/generator/generate

// 新增: 从对话历史生成
POST /api/generator/from-conversation
Body: {
  conversationId: string;
  steps: number[];  // 要包含的步骤
  toolName: string;
  parameters: string[];
}

// 新增: 从 MCP 组合生成新工具
POST /api/generator/compose-mcps
Body: {
  mcps: Array<{serviceId: string, tools: string[]}>;
  workflow: object;
  outputName: string;
}
```

#### 4. **Memory Store API** (新增)

```typescript
// 保存技能模式
POST /api/memory/skills
Body: {
  pattern: object;
  context: object;
}

// 搜索技能
GET /api/memory/skills/search?query=...

// 推荐技能
GET /api/memory/skills/recommend?intent=...

// 将技能转化为工具
POST /api/memory/skills/:skillId/to-tool
```

---

## 📝 实施计划

### Phase 1: 基础能力（2-3周）

**目标**：建立元能力的基础设施

- [ ] 实现 Meta Controller 基础框架
- [ ] Orchestrator API 增强（export-as-mcp）
- [ ] Generator API 增强（compose-mcps）
- [ ] 自引用处理器（self:// 协议）
- [ ] 递归深度限制和权限管理

**交付物**：
- 能够将编排结果导出为 MCP 工具
- 生成的工具可以调用 Gateway 的 API
- 基础的权限和安全控制

---

### Phase 2: 对话历史集成（2-3周）

**目标**：从用户对话中学习和生成工具

- [ ] 对话历史记录机制
- [ ] MCP 调用跟踪和模式识别
- [ ] from-conversation API 实现
- [ ] 参数化和抽象化逻辑
- [ ] 自动生成 tool schema

**交付物**：
- 对话中的 MCP 操作可被转化为工具
- 自动识别可参数化的部分
- 生成完整的 MCP 工具包（代码+配置+文档）

---

### Phase 3: 技能记忆系统（3-4周）

**目标**：建立模式学习和推荐系统

- [ ] Memory Store 实现（存储层）
- [ ] 模式识别算法
- [ ] 使用频率和成功率统计
- [ ] 推荐引擎
- [ ] Skills 到 Tool 的转换

**交付物**：
- 系统自动记录成功的 MCP 组合
- 基于历史推荐最佳实践
- 一键将记忆转化为可复用工具

---

### Phase 4: 高级元能力（3-4周）

**目标**：实现完整的自举和递归能力

- [ ] 元工具的元工具（二阶组合）
- [ ] 动态权限管理
- [ ] 版本管理和回滚
- [ ] 性能优化和缓存
- [ ] 完整的监控和日志

**交付物**：
- 生成的工具可以生成新工具（递归）
- 完整的生命周期管理
- 生产级性能和稳定性

---

## 🔒 安全考虑

### 关键安全问题

1. **无限递归风险**
   - 限制递归深度（建议 max 3-5 层）
   - 检测循环依赖
   - 设置执行超时

2. **权限提升风险**
   - 生成的工具继承创建者权限（不得超越）
   - 自引用调用需要额外验证
   - 敏感 API 需要显式授权

3. **资源滥用**
   - 限制生成工具的数量
   - 限制执行频率
   - 监控资源消耗

4. **代码注入风险**
   - 生成的代码需要沙箱执行
   - 输入严格验证
   - 禁止直接执行用户代码

### 安全措施

```typescript
// 元能力安全配置
interface MetaSecurityConfig {
  maxRecursionDepth: number;  // 默认 3
  maxGeneratedTools: number;  // 每用户默认 50
  requireApproval: boolean;   // 是否需要人工审批
  sandboxExecution: boolean;  // 是否沙箱执行
  allowedAPIs: string[];      // 白名单 API
  rateLimits: {
    toolGeneration: number;   // 每小时生成限制
    toolExecution: number;    // 每小时执行限制
  };
}
```

---

## 📊 成功指标

### 功能指标

- [ ] 能够从 3 种以上来源生成 MCP 工具
- [ ] 生成的工具成功率 > 90%
- [ ] 支持至少 3 层递归组合
- [ ] 对话历史转化成功率 > 80%

### 性能指标

- [ ] 工具生成时间 < 5 秒
- [ ] 工具执行性能损失 < 10%（相比直接调用）
- [ ] 支持并发 100+ 元工具执行

### 用户体验

- [ ] 用户可在 3 步内创建自定义工具
- [ ] 推荐准确率 > 70%
- [ ] 文档自动生成覆盖率 100%

---

## 🎨 示例用例

### 用例 1: AI 研究助手

```typescript
// 用户创建一个研究助手
const researchAssistant = await meta.compose({
  name: "ai-research-assistant",
  steps: [
    { tool: "arxiv-search", action: "search" },
    { tool: "pdf-reader", action: "extract-text" },
    { tool: "ai-summarizer", action: "summarize" },
    { tool: "notion", action: "create-page" }
  ]
});

// 这个助手本身也是一个 MCP 工具
// 可以被其他服务调用或进一步组合
```

### 用例 2: 代码审查自动化

```typescript
// 从对话历史创建代码审查工具
const codeReviewer = await meta.fromConversation({
  conversationId: "code-review-session-1",
  extractPattern: true,
  toolName: "smart-code-reviewer"
});

// 生成的工具包含：
// 1. 运行测试
// 2. 检查代码风格
// 3. 分析复杂度
// 4. 生成审查报告
```

### 用例 3: 个性化工作流

```typescript
// 系统学习用户习惯
const userPattern = await memory.identifyPattern({
  userId: "user-123",
  minFrequency: 5
});

// 自动推荐个性化工具
const recommendations = await meta.recommend({
  userId: "user-123",
  context: "morning-routine"
});

// 用户一键创建
const morningTool = await meta.createFromPattern(recommendations[0]);
```

---

## 🔮 未来展望

### 长期目标

1. **AI 驱动的工具生成**
   - 使用 LLM 理解用户意图
   - 自动推断最佳 MCP 组合
   - 智能参数推荐

2. **市场和分享**
   - 用户可以分享自己创建的工具
   - 工具评分和评论系统
   - 工具市场和发现机制

3. **跨 Gateway 协作**
   - 多个 Gateway 实例共享元能力
   - 分布式工具生成和执行
   - 联邦学习和模式共享

4. **自我优化**
   - 系统自动优化工具性能
   - A/B 测试不同组合方案
   - 持续学习用户偏好

---

## 📚 参考资料

### 相关概念

- **元编程（Metaprogramming）**：程序能够生成或修改其他程序
- **自举（Bootstrapping）**：系统使用自身能力构建自身
- **反射（Reflection）**：程序能够检查和修改自身结构
- **高阶函数（Higher-Order Functions）**：函数作为参数或返回值

### 相似项目

- **Zapier/IFTTT**：工作流自动化平台
- **Temporal**：工作流编排引擎
- **LangChain**：LLM 应用编排框架
- **Kubernetes Operators**：自我管理的集群资源

---

## 📞 联系和反馈

**项目负责人**：待定
**讨论渠道**：待定
**设计文档**：本文档

**更新历史**：
- 2025-11-05: 初始版本，愿景和规划

---

**Status**: 📋 Planned
**Next Review**: 待 P1 优先级任务完成后评估

