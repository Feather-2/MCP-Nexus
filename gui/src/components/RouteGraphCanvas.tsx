import { useEffect, useMemo, useRef, useState } from "react";

type Subagent = {
  name: string;
  tools?: string[];
  actions?: string[];
};

type Node = {
  id: string;
  label: string;
  type: 'subagent' | 'tool';
  x: number;
  y: number;
};

export default function RouteGraphCanvas({ subagents = [] as Subagent[] }: { subagents?: Subagent[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 360 });
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({ dragging: false, lastX: 0, lastY: 0 });

  // Measure container width for responsive layout
  useEffect(() => {
    const el = containerRef.current;
    const measure = () => {
      if (!el) return;
      const width = Math.max(600, el.clientWidth);
      setSize((s) => ({ width, height: s.height }));
    };
    measure();
    const RO = (window as any).ResizeObserver as any;
    const ro = RO ? new RO(() => measure()) : undefined;
    if (ro && el) ro.observe(el);
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (ro && el) ro.unobserve(el);
    };
  }, []);

  const tools = useMemo(() => Array.from(new Set(subagents.flatMap(s => s.tools || []))).filter(Boolean), [subagents]);

  const layout = useMemo(() => {
    const padding = 24;
    const nodeH = 28;
    const leftX = 120;
    const rightX = Math.max(leftX + 260, size.width - 200);
    const leftCount = Math.max(1, subagents.length);
    const rightCount = Math.max(1, tools.length);
    const rows = Math.max(leftCount, rightCount);
    const height = Math.max(size.height, Math.min(520, 60 + rows * 48));
    const yStepLeft = (height - padding * 2) / (leftCount + 1);
    const yStepRight = (height - padding * 2) / (rightCount + 1);

    const leftNodes: Node[] = subagents.map((s, i) => ({
      id: `sub-${s.name}`,
      label: s.name,
      type: 'subagent',
      x: leftX,
      y: padding + (i + 1) * yStepLeft,
    }));
    const rightNodes: Node[] = tools.map((t, i) => ({
      id: `tool-${t}`,
      label: t,
      type: 'tool',
      x: rightX,
      y: padding + (i + 1) * yStepRight,
    }));

    const edges = subagents.reduce<Array<{ from: Node; to: Node }>>((acc, s) => {
      const from = leftNodes.find(n => n.label === s.name);
      (s.tools || []).forEach((t) => {
        const to = rightNodes.find(n => n.label === t);
        if (from && to) acc.push({ from, to });
      });
      return acc;
    }, []);

    return { leftNodes, rightNodes, edges, height, nodeH };
  }, [size.width, size.height, subagents, tools]);

  // Pan & Zoom handlers
  const onWheel: React.WheelEventHandler<SVGSVGElement> = (e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.05 : 0.95;
    setScale((s) => Math.min(2, Math.max(0.5, s * factor)));
  };

  const onMouseDown: React.MouseEventHandler<SVGSVGElement> = (e) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
  };
  const onMouseMove: React.MouseEventHandler<SVGSVGElement> = (e) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
  };
  const onMouseUp: React.MouseEventHandler<SVGSVGElement> = () => {
    dragRef.current.dragging = false;
  };
  const onMouseLeave: React.MouseEventHandler<SVGSVGElement> = () => {
    dragRef.current.dragging = false;
  };

  const resetView = () => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        <button className="px-2 py-1 text-sm rounded border bg-card" onClick={() => setScale((s) => Math.max(0.5, s * 0.9))}>-</button>
        <button className="px-2 py-1 text-sm rounded border bg-card" onClick={() => setScale((s) => Math.min(2, s * 1.1))}>+</button>
        <button className="px-2 py-1 text-sm rounded border bg-card" onClick={resetView}>重置</button>
      </div>

      <svg
        width={size.width}
        height={layout.height}
        className="block w-full rounded-md border bg-background cursor-grab"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        <g transform={`translate(${translate.x}, ${translate.y}) scale(${scale})`}>
          {/* Edges */}
          {layout.edges.map((e, idx) => (
            <path
              key={`edge-${idx}`}
              d={`M ${e.from.x + 80} ${e.from.y} C ${e.from.x + 140} ${e.from.y}, ${e.to.x - 140} ${e.to.y}, ${e.to.x - 20} ${e.to.y}`}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.25}
              strokeWidth={1.5}
              fill="none"
              markerEnd="url(#arrow)"
            />
          ))}

          {/* Left: Subagents */}
          {layout.leftNodes.map((n) => (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              <rect x={-60} y={-16} rx={6} ry={6} width={120} height={32} fill="hsl(var(--primary))" fillOpacity={0.08} stroke="hsl(var(--primary))" strokeOpacity={0.6} />
              <text x={0} y={4} textAnchor="middle" fontSize="12" fill="hsl(var(--primary))">{n.label}</text>
            </g>
          ))}

          {/* Right: Tools */}
          {layout.rightNodes.map((n) => (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              <rect x={-60} y={-16} rx={6} ry={6} width={120} height={32} fill="hsl(var(--muted))" stroke="hsl(var(--border))" />
              <text x={0} y={4} textAnchor="middle" fontSize="12" fill="hsl(var(--foreground))">{n.label}</text>
            </g>
          ))}

          {/* Titles */}
          <text x={120} y={24} textAnchor="start" fontSize="12" fill="hsl(var(--muted-foreground))">分组</text>
          <text x={Math.max(120 + 260, size.width - 200)} y={24} textAnchor="start" fontSize="12" fill="hsl(var(--muted-foreground))">模板</text>
        </g>
      </svg>

      {subagents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">
          暂无数据，创建分组后查看路由连线。
        </div>
      )}
    </div>
  );
}
