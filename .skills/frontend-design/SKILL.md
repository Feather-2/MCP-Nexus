---
name: frontend-design
description: MCP-Nexus 前端设计专家。基于 gui/ 目录的 React + Vite + Tailwind + shadcn/ui 技术栈，创建一致的管理界面。
---

# frontend-design (MCP-Nexus 前端设计)

## 技术栈

- **Framework**: React 18 + TypeScript
- **Build**: Vite
- **Styling**: Tailwind CSS
- **Components**: shadcn/ui (Radix UI primitives)
- **Routing**: React Router DOM

## 项目结构

```
gui/
├── src/
│   ├── components/ui/    # shadcn/ui 组件
│   ├── lib/utils.ts      # cn() 工具函数
│   └── ...
├── components.json       # shadcn/ui 配置
└── tailwind.config.js
```

## 设计规范

### 颜色系统

使用 shadcn/ui 内置的 CSS 变量系统:
```css
--background, --foreground
--card, --card-foreground
--primary, --primary-foreground
--secondary, --secondary-foreground
--muted, --muted-foreground
--accent, --accent-foreground
--destructive, --destructive-foreground
--border, --input, --ring
```

### 组件使用

优先使用已安装的 shadcn/ui 组件:
```bash
# 查看已安装组件
ls gui/src/components/ui/

# 添加新组件
cd gui && npx shadcn@latest add [component]
```

### 样式规范

```typescript
// 使用 cn() 合并 class
import { cn } from "@/lib/utils";

<div className={cn("base-class", condition && "conditional-class")} />
```

### 布局

- 管理面板风格：左侧导航 + 主内容区
- 响应式断点：使用 Tailwind 默认断点 (sm, md, lg, xl)
- 间距：使用 Tailwind 的 spacing scale (p-4, m-2, gap-4 等)

## 开发命令

```bash
cd gui
npm run dev      # 开发服务器
npm run build    # 生产构建
npm run lint     # ESLint 检查
```

## 禁止事项

- 不使用内联样式
- 不直接操作 DOM
- 不添加与 shadcn/ui 冲突的 UI 库
- 不使用非 Tailwind 的 CSS 方案
