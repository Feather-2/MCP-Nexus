
type Subagent = {
  name: string;
  tools?: string[];
  actions?: string[];
};

export default function RouteGraph({ subagents = [] as Subagent[] }: { subagents?: Subagent[] }) {
  const uniqueTools = Array.from(new Set(subagents.flatMap((s) => s.tools || []))).filter(Boolean);
  const edges = subagents.reduce<Array<{ from: string; to: string }>>((acc, s) => {
    (s.tools || []).forEach((t) => acc.push({ from: s.name, to: t }));
    return acc;
  }, []);

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        <span className="mr-4">分组：{subagents.length}</span>
        <span className="mr-4">模板：{uniqueTools.length}</span>
        <span>连接：{edges.length}</span>
      </div>

      {/* 简版节点图：分组 → 模板 列表+连线描述 */}
      <div className="grid gap-3">
        {subagents.length === 0 && (
          <div className="text-sm text-muted-foreground">暂无分组。通过右上角“快速创建分组”添加。</div>
        )}
        {subagents.map((s) => (
          <div key={s.name} className="rounded-md border p-3">
            <div className="text-sm font-medium mb-2">
              <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary/10 text-primary mr-2">S</span>
              {s.name}
            </div>
            <div className="text-xs text-muted-foreground mb-2">动作：{(s.actions || []).join(', ') || '—'}</div>
            <div className="text-sm">
              <span className="mr-2">路由 →</span>
              {(s.tools || []).length > 0 ? (
                <span className="inline-flex flex-wrap gap-1 align-middle">
                  {(s.tools || []).map((t) => (
                    <span key={t} className="px-2 py-0.5 rounded bg-muted text-xs">
                      {t}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">未配置模板</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 右侧模板清单（去重） */}
      {uniqueTools.length > 0 && (
        <div className="rounded-md border p-3">
          <div className="text-sm font-medium mb-2">已注册模板</div>
          <div className="flex flex-wrap gap-2">
            {uniqueTools.map((t) => (
              <span key={t} className="px-2 py-0.5 rounded bg-muted text-xs">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        说明：此为简版路由图，显示分组到模板的静态映射；实际执行时仍会结合工具名与内置映射（如 search→brave-search）。
      </div>
    </div>
  );
}
