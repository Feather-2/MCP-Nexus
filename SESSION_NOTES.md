# MCP-Nexus 会话要点与后续计划

## 当前进度
- 分支：`main`，已提交一次功能性变更（容器适配、GUI 鉴权、SSE 重连、i18n 修复、冒烟脚本）。
- 前后端关键路由可用；GUI 已能正常构建与访问（`/` 与 `/static/index.html`）。

### 本次增量改动（已落地）
- 沙箱安装稳健性（后端）：
  - Windows Node 检测修正：支持 `nodejs/node.exe` + `npm.cmd`（根或 bin），避免“已装却判未装”。
  - 目录整理 EPERM 回退：Node/Go 解压后移动失败自动回退“复制+删除”，减少占用导致的失败与重试。
  - 下载重定向上限：最多 5 次，防环路。
  - 流式安装互斥与多订阅：`/api/sandbox/install/stream` 仅首次连接执行安装，其余连接 `attach` 订阅进度；完成后统一广播 `complete`。
  - 非流式安装互斥：`POST /api/sandbox/install|repair` 忙时返回 409 Busy，杜绝并发重入。
  - 自检详情与版本：`/api/sandbox/status` 附带 `details.nodePath/npmPath/pythonPath/goPath/packagesDir` 以及 `node/python/go` 版本号（轻量探针）。
- 健康探针与噪音：
  - 健康探针仅对 `state === running` 的实例执行，减少对非运行/一次性实例的周期性拉起与日志噪音。
  - 探针/启动错误写入实例元数据 `lastProbeError`，便于前端提示。
- 模板与服务的“缺失 env”智能提示（前端+后端信号）：
  - Services：当实例缺 env 或有 `lastProbeError` 时显示“配置”按钮，弹窗预填推断变量名（静态映射 + 错误文本提取），保存即 `PATCH /api/services/:id/env` 并重建实例。
  - Templates：模板列表标注“缺少环境变量”徽标，提供“一键配置”弹窗直接补齐模板 env（已新增后端 `PATCH /api/templates/:name/env`）。
  - 已内置常见映射：
    - brave-search → `BRAVE_API_KEY`
    - github → `GITHUB_TOKEN`
    - openai → `OPENAI_API_KEY`
    - azure-openai → `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`
    - anthropic → `ANTHROPIC_API_KEY`
    - ollama → 无需 key
- GUI 其他：
  - 安装流去除自动重连（只对日志流保留重连）。
  - 模板行新增“一键切换容器模式（预填镜像）”。
  - 设置页沙箱卡片展示运行时路径与版本号。
  - 新增默认模板 `node-stdio-container`（容器内常驻），便于 Console/健康检查验证。

## 新增能力（本轮）
- 容器沙盒适配器：`src/adapters/ContainerTransportAdapter.ts`
  - 在模板 `transport='stdio'` 且 `env.SANDBOX='container'` 或存在 `container` 字段时，使用容器（docker/podman）拉起服务，向上仍呈现 `stdio`。
- AI/生成器与市场路由增强：`/api/ai/*`、`/api/generator/*`、`/api/generator/marketplace*`。
- GUI 鉴权注入：`apiClient.setAuth()`，支持持久化 `X-API-Key` / `Authorization: Bearer`；Settings 页新增输入项。
- SSE 重连：日志与沙箱安装流加入指数退避重连（后续对“安装流”将改为不重连，见“沙箱问题”）。
- i18n 修复：`mon.desc`/`mon.order` 重复键已清理，新增 `mon.orderAsc`/`mon.orderDesc`。
- 脚本：
  - `scripts/smoke-test.cjs`：一键本地冒烟（健康/AI/生成器/GUI）。
  - `scripts/service-e2e.cjs`：启动网关→注册容器模板→创建实例→停服。
  - `scripts/service-register-onlive.cjs`：复用已运行网关直接注册与创建。

## 如何运行与验证
- 构建：`npm run build`（根目录），GUI：`cd gui && npm run build`。
- 启动 GUI：`npm run web` 或 `tsx start-gui.js`，访问 `http://localhost:19233`。
- 本地冒烟：`node scripts/smoke-test.cjs`。
- 容器端到端（示例）：`node scripts/service-e2e.cjs`（验证容器适配器可连接；该示例服务非完整 MCP，仅输出一行 JSON 即退出）。

## 容器模板使用注意
- 仅支持 `transport='stdio'`；容器镜像必填。
- `env.SANDBOX='container'` 或提供 `container` 字段即触发容器适配。
- 卷挂载格式：一行一个，`hostPath:containerPath[:ro]`；Windows 盘符示例：`C:\\data\\logs:/app/logs:ro`。
- 资源/网络：可选 `resources.cpus/memory`、`network`、`readonlyRootfs`、`workdir`。

## 沙箱“一键安装”反复下载的问题
现象：安装日志多次出现“下载/解压 Node.js…”，并伴随 Windows 报错：

```
EPERM: rename,
path: F:\pb\mcp-sandbox\runtimes\nodejs\node-v20.15.0-win-x64\node_modules,
dest: F:\pb\mcp-sandbox\runtimes\nodejs\node_modules
```

根因（综合）：
1) 检测与解压不一致：
   - Windows 上 inspectSandbox 检查的是 `nodejs/bin/node(.cmd)`，但安装后文件位于 `nodejs/node.exe` 与（可能的）`npm.cmd`，导致始终判定未安装，触发重复安装。
2) 目录占用或已存在：
   - 目标 `nodejs/node_modules` 已存在或被占用时，Windows 的 `rename` 返回 EPERM，当前流程按失败处理并重试。
3) 流式安装重入：
   - 前端安装流（SSE）断线自动重连；后端每个新连接都会重新跑安装流程，形成“重连=重装”。

立即操作建议（可立刻解除卡顿）：
- 在“系统设置 → 沙箱设置”先点“清理”，再点“安装/修复”（非流式接口）。安装过程中不要刷新或重复点击。
- 关闭占用 `F:\pb\mcp-sandbox\` 的资源管理器/编辑器/杀软/索引；必要时将该目录加入排除。
- 若仍失败：手动删除 `F:\pb\mcp-sandbox\runtimes\nodejs\node_modules` 与 `...\node-v20.15.0-win-x64` 残留目录后再试。

代码级修复（拟落实）：
- 修正 Node 安装检测（Windows）：同时支持 `nodejs/node.exe` 与 `nodejs/bin/node(.cmd)` 两种布局，任一可用即判定已安装。
- 提升目录整理鲁棒性：移动/rename 前检测与安全替换目标目录，避免 EPERM；若已安装（可执行存在）则跳过下载/解压。
- 安装流并发保护：后端对 `/api/sandbox/install/stream` 加“安装中”锁；新连接仅订阅进度，禁止重入。前端对“安装流”去除自动重连（保留日志流重连）。

（以上三项已完成，并新增 Go 的移动回退、下载重定向上限、非流式接口互斥）

## GUI 变更要点
- Settings 页新增：API Key / Bearer Token 输入；保存后通过 `apiClient.setAuth()` 自动注入所有请求。
- Monitoring 页与 SandboxBanner：日志流与安装流使用 SSE；后续将仅对日志保留自动重连，安装流不再重连。
 - Services/Templates：支持“缺失环境变量”主动感知与一键配置；Services 支持实例级 env 快速修复。
 - Settings：沙箱路径与版本号展示。

## 本次对话进展（新增/修复）
- 模板/服务的 ENV 映射扩展（前后端一致）：
  - 新增：`GOOGLE_API_KEY`(Gemini/Google)、`COHERE_API_KEY`、`GROQ_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`FIREWORKS_API_KEY`、`DEEPSEEK_API_KEY`、`MISTRAL_API_KEY`、`PERPLEXITY_API_KEY`、`REPLICATE_API_TOKEN`、`SERPAPI_API_KEY`、`HF_TOKEN`。
  - Services/ Templates 均按名称/包名/args 进行启发式识别，缺失时显示徽标与“配置”入口。
- 诊断能力：
  - 后端新增 `POST /api/templates/:name/diagnose`（静态轻探针），返回 `{success, required, provided, missing, transport}`；异常场景软失败（`200 + success:false`），避免前端出现 400(no body)。
  - Templates 页新增“诊断”按钮与结果弹窗，支持“一键配置缺失项”。
- 模板管理 UI 优化：
  - 行操作收纳为“更多(⋯)”菜单；新增顶部搜索框；移除表格外多余容器，列表更清爽。
  - 选择交互稳定化：改用原生 checkbox 并精简受控逻辑，解决“只能点一次”的问题；支持全选/反选无卡顿。
  - 焦点管理：对话框 `aria-describedby` 修正；菜单点击采用微延迟触发，避免焦点竞争导致二次点击无效。
  - 容器模式可视化与切换：
    - 传输列标注“容器”徽标；当未填写镜像时标注“镜像缺失”。
    - 表单内对镜像缺失给出黄色提示文案。
    - 菜单提供“一键切容器模式（预填镜像）”与“切回便携模式”。
- 日志体验：
  - 后端 SSE 广播补充 `serviceId` 字段；`GET /api/services/:id/logs` 仅返回该服务日志，减少重复。
  - 前端历史/实时日志均做相邻去重，降低闪动与噪音。
  - 监控中心实时日志在暗色主题下颜色统一调整（黑底不再出现黑字，error/warn/info/debug 均有暗色可读色）。
- 沙箱日志可读性：安装日志平台提示由 `win32/linux/darwin` 改为“Windows/macOS/Linux”。

## 已知问题与现状（本轮已缓解/待进一步）
- 个别接口返回 4xx 时仍可能出现“400 (no body)”提示：
  - 诊断接口已统一软失败结构化返回；`PATCH /api/templates/:name/env` 已放宽请求体格式（接受 `{env:{}}` 或直接 `{KEY:VAL}`），并始终返回结构化 JSON。
  - GUI `apiClient` 对非 JSON 错误体仍可能显示默认文案，下一轮将增强错误解析（优先解析 JSON `error.message`，否则回退 `text()`）。
- 某些容器模板启用 `SANDBOX=container` 但未配置 `container.image` 会导致路由/健康检查反复报错日志（已在 UI 做“镜像缺失”提醒与切回入口）。

## 复现与验证清单（快速）
- 构建：根 `npm run build`；GUI `npm --prefix gui run build`。
- 模板页：
  - 搜索、菜单、选择（多次点选/全选/反选）均正常；
  - “诊断”能弹出结果，不再 400(no body)；
  - 容器模板显示“容器/镜像缺失”徽标；菜单可切换模式；
  - 编辑容器镜像留空有黄色提示。
- 服务页：缺失 ENV 显示“配置”，更新后可重建实例；日志只显示对应服务且无快速重复。
- 监控中心：实时日志在黑底可读，颜色区分 error/warn/info/debug。

## 建议的下一步
1) 完成 GUI `apiClient` 错误解析增强，统一显示后端结构化错误（避免“no body”误导）。
2) 扫描并提示所有容器模板的镜像缺失项，提供一键批量修复为默认镜像（可选）。
3) 为实例增加 keep-alive/managed 模式，降低健康检查对一次性/短进程的影响。
4) 行点击切换选中（可配置），提升表格操作效率（不影响菜单点击）。
5) 接口层统一 4xx 错误结构化返回（后端），并在文档中标注；补充 E2E 用例覆盖诊断与模板 ENV 更新。

---
本文档用于承接后续会话与任务推进，重启对话时可直接引用本文件作为上下文。
