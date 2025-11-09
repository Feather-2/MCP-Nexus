import React, { useState, useEffect, useRef, useMemo } from 'react';
import { apiClient, type HealthStatus } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import PageHeader from '@/components/PageHeader';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n';
import {
  Activity,
  Server,
  Clock,
  Cpu,
  HardDrive,
  Wifi,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Pause,
  Play,
  Download
} from 'lucide-react';

const Monitoring: React.FC = () => {
  const { t } = useI18n();
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ timestamp: string; level: string; message: string; service?: string }>>([]);
  const [isLogStreamActive, setIsLogStreamActive] = useState(true);
  const logStreamRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [agg, setAgg] = useState<{ global?: any; perService?: any[] }>({});
  const [svcMetrics, setSvcMetrics] = useState<Array<{ serviceId: string; serviceName: string; health: any; uptime: number }>>([]);
  const [sortKey, setSortKey] = useState<'latency' | 'p95' | 'p99' | 'errorRate'>('p95')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [onlyUnhealthy, setOnlyUnhealthy] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [exporting, setExporting] = useState(false)

  const loadHealthData = async () => {
    try {
      const [s1, s2, s3] = await Promise.all([
        apiClient.getHealthStatus(),
        apiClient.getHealthAggregates(),
        apiClient.getPerServiceMetrics()
      ]);
      if (s1.ok) setHealthStatus(s1.data || null); else setError(s1.error || '加载监控数据失败');
      if (s2.ok) setAgg(s2.data || {});
      if (s3.ok) setSvcMetrics(s3.data?.serviceMetrics || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载监控数据失败');
    } finally {
      // setLoading(false); // Remove unused loading state
    }
  };

  const exportHealthJSON = async () => {
    try {
      setExporting(true)
      const data = { aggregates: agg, services: svcMetrics }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'health-report.json'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    } finally { setExporting(false) }
  }

  const exportHealthCSV = async () => {
    try {
      setExporting(true)
      const rows: string[] = []
      rows.push(['serviceId','serviceName','lastLatency','p95','p99','errorRate','samples','lastError'].join(','))
      const per = agg.perService || []
      for (const s of per) {
        const svc = svcMetrics.find(v => v.serviceId === s.id)
        const name = (svc?.serviceName || s.id).replaceAll('"','\"')
        const lastLatency = s.last?.latency ?? ''
        const cols = [s.id, name, lastLatency, s.p95 ?? '', s.p99 ?? '', s.errorRate ?? '', s.samples ?? '', (s.lastError || '').replaceAll('\n',' ').replaceAll('"','\"')]
        rows.push(cols.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(','))
      }
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'health-report.csv'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    } finally { setExporting(false) }
  }

  const loadInitialLogs = async () => {
    try {
      const result = await apiClient.getLogs(50);
      if (result.ok) {
        setLogs(result.data || []);
      }
    } catch (err) {
      console.error('Failed to load initial logs:', err);
    }
  };

  const startLogStream = () => {
    if (logStreamRef.current) {
      logStreamRef.current.close();
    }

    const eventSource = apiClient.createLogStream(
      (log) => {
        setLogs(prev => {
          const newLogs = [...prev, log];
          // Keep only last 100 logs for performance
          return newLogs.slice(-100);
        });

        // Auto-scroll to bottom
        setTimeout(() => {
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }
        }, 100);
      },
      (error) => {
        console.error('Log stream error:', error);
        setError('日志流连接失败');
      }
    );

    logStreamRef.current = eventSource;
    setIsLogStreamActive(true);
  };

  const stopLogStream = () => {
    if (logStreamRef.current) {
      logStreamRef.current.close();
      logStreamRef.current = null;
    }
    setIsLogStreamActive(false);
  };

  const toggleLogStream = () => {
    if (isLogStreamActive) {
      stopLogStream();
    } else {
      startLogStream();
    }
  };

  const getLevelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error': return 'text-red-600 dark:text-red-400';
      case 'warn': return 'text-amber-700 dark:text-amber-400';
      case 'info': return 'text-blue-600 dark:text-blue-400';
      case 'debug': return 'text-slate-600 dark:text-slate-400';
      default: return 'text-slate-600 dark:text-slate-300';
    }
  };

  const formatLogTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  useEffect(() => {
    loadHealthData();
    loadInitialLogs();

    const interval = setInterval(loadHealthData, 5000); // Refresh every 5 seconds

    // Start log streaming
    startLogStream();

    return () => {
      clearInterval(interval);
      stopLogStream();
    };
  }, []);

  const formatNumber = (num: number | undefined): string => {
    if (num === undefined || num === null) return '-';
    return num.toLocaleString();
  };

  const formatPercentage = (num: number | undefined): string => {
    if (num === undefined || num === null) return '-';
    return `${Math.round(num * 100)}%`;
  };

  const formatTime = (ms: number | undefined): string => {
    if (ms === undefined || ms === null) return '-';
    return `${ms.toFixed(0)}ms`;
  };

  const formatUptime = (ms: number | undefined): string => {
    if (ms === undefined || ms === null) return '-';
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('mon.title')}
        description={t('mon.desc')}
        actions={<Button variant="outline" onClick={loadHealthData} className="gap-2"><RefreshCw className="h-4 w-4" /> {t('common.refresh')}</Button>}
      />

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              <p className="text-red-800 dark:text-red-200">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Metrics Cards - 简约白卡 + 绿色点缀 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.totalRequests')}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Activity className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">
              {formatNumber(healthStatus?.metrics?.totalRequests)}
            </div>
          </CardContent>
        </Card>

        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.successRate')}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <CheckCircle className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">
              {formatPercentage(healthStatus?.metrics?.successRate)}
            </div>
          </CardContent>
        </Card>

        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.avgResponse')}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">
              {formatTime(healthStatus?.metrics?.averageResponseTime)}
            </div>
          </CardContent>
        </Card>

        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.activeConns')}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Wifi className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">
              {formatNumber(healthStatus?.metrics?.activeConnections)}
            </div>
          </CardContent>
        </Card>

        {/* P95 */}
        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.p95') || 'P95'}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">{formatTime(agg.global?.p95)}</div>
          </CardContent>
        </Card>

        {/* P99 */}
        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.p99') || 'P99'}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Clock className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">{formatTime(agg.global?.p99)}</div>
          </CardContent>
        </Card>

        {/* Error rate */}
        <Card className="border bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-[13px] font-medium">{t('mon.errorRate') || 'Error Rate'}</CardTitle>
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <AlertTriangle className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-xl md:text-2xl font-semibold">{formatPercentage(agg.global?.errorRate)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Gateway Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle>{t('mon.gateway')}</CardTitle>
          </div>
          <CardDescription>
            {t('mon.gatewayDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="text-center p-4 bg-muted/40 rounded-lg">
              <div className="flex items-center justify-center mb-2">
                <Badge variant={healthStatus?.gateway?.status === 'healthy' ? 'default' : 'destructive'} className="gap-1 text-[12px]">
                  {healthStatus?.gateway?.status === 'healthy' ? (
                    <CheckCircle className="h-3 w-3" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  {healthStatus?.gateway?.status === 'healthy' ? t('status.healthy') : t('status.unhealthy')}
                </Badge>
              </div>
              <div className="text-[12px] text-muted-foreground">{t('common.status')}</div>
            </div>
            <div className="text-center p-4 bg-muted/40 rounded-lg">
              <div className="text-base md:text-lg font-semibold mb-1">
                {formatUptime(healthStatus?.gateway?.uptime)}
              </div>
              <div className="text-[12px] text-muted-foreground">{t('mon.uptime')}</div>
            </div>
            <div className="text-center p-4 bg-muted/40 rounded-lg">
              <div className="text-base md:text-lg font-semibold mb-1">
                {healthStatus?.gateway?.version || '-'}
              </div>
              <div className="text-[12px] text-muted-foreground">{t('common.version')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Service Status + Health Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-primary" />
            <CardTitle>{t('mon.services')}</CardTitle>
          </div>
          <CardDescription>
            {t('mon.servicesDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Select value={sortKey} onValueChange={(v) => setSortKey(v as any)}>
                  <SelectTrigger className="w-[130px] h-8 text-xs">
                    <SelectValue placeholder={t('mon.sortBy')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latency">{t('mon.latency') || 'Latency'}</SelectItem>
                    <SelectItem value="p95">{t('mon.p95') || 'P95'}</SelectItem>
                    <SelectItem value="p99">{t('mon.p99') || 'P99'}</SelectItem>
                    <SelectItem value="errorRate">{t('mon.errorRate') || 'Error Rate'}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as any)}>
                  <SelectTrigger className="w-[90px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">{t('mon.orderDesc') || 'Desc'}</SelectItem>
                    <SelectItem value="asc">{t('mon.orderAsc') || 'Asc'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="h-8 w-[180px] text-xs"
                  placeholder={t('mon.filter') || 'Filter services...'}
                />
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox id="only-unhealthy" checked={onlyUnhealthy} onCheckedChange={(c) => setOnlyUnhealthy(!!c)} />
                <label
                  htmlFor="only-unhealthy"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  {t('mon.onlyUnhealthy') || 'Only unhealthy'}
                </label>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={exportHealthJSON} disabled={exporting} className="h-8 gap-1">
                <Download className="h-3.5 w-3.5" /> JSON
              </Button>
              <Button variant="outline" size="sm" onClick={exportHealthCSV} disabled={exporting} className="h-8 gap-1">
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="text-center p-4 bg-muted/30 rounded-lg border">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.total || 0}
              </div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">{t('mon.totalServices')}</div>
            </div>
            <div className="text-center p-4 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-lg border border-emerald-100 dark:border-emerald-900/50">
              <div className="text-2xl font-semibold mb-1 text-emerald-600 dark:text-emerald-400">
                {healthStatus?.services?.running || 0}
              </div>
              <div className="text-xs text-emerald-600/80 dark:text-emerald-400/80 uppercase tracking-wider">{t('status.running')}</div>
            </div>
            <div className="text-center p-4 bg-muted/30 rounded-lg border">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.stopped || 0}
              </div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">{t('status.stopped')}</div>
            </div>
            <div className="text-center p-4 bg-red-50/50 dark:bg-red-950/20 rounded-lg border border-red-100 dark:border-red-900/50">
              <div className="text-2xl font-semibold mb-1 text-red-600 dark:text-red-400">
                {healthStatus?.services?.error || 0}
              </div>
              <div className="text-xs text-red-600/80 dark:text-red-400/80 uppercase tracking-wider">{t('status.error')}</div>
            </div>
          </div>

          {/* Health table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('mon.service') || 'Service'}</TableHead>
                  <TableHead>{t('mon.latency') || 'Latency'}</TableHead>
                  <TableHead>{t('mon.p95') || 'P95'}</TableHead>
                  <TableHead>{t('mon.p99') || 'P99'}</TableHead>
                  <TableHead>{t('mon.errorRate') || 'Error Rate'}</TableHead>
                  <TableHead>{t('mon.latencyTrend') || 'Latency Trend'}</TableHead>
                  <TableHead>{t('mon.lastError') || 'Last Error'}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agg.perService && [...agg.perService]
                  .filter((s: any) => {
                    const svc = svcMetrics.find(v => v.serviceId === s.id);
                    const name = (svc?.serviceName || s.id).toLowerCase();
                    const match = !filterText || name.includes(filterText.toLowerCase());
                    const unhealthy = s.last && s.last.healthy === false;
                    return match && (!onlyUnhealthy || unhealthy);
                  })
                  .sort((a: any, b: any) => {
                    const pick = (x: any) => sortKey === 'latency' ? (x.last?.latency ?? 0) : (x[sortKey] ?? 0);
                    const va = pick(a), vb = pick(b);
                    return sortOrder === 'asc' ? va - vb : vb - va;
                  })
                  .map((s: any) => {
                    const svc = svcMetrics.find(v => v.serviceId === s.id);
                    const name = svc?.serviceName || s.id;
                    const lastLatency = s.last?.latency;
                    const latArr: number[] = Array.isArray(s.latencies) ? s.latencies : [];
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell>{formatTime(lastLatency)}</TableCell>
                        <TableCell>{formatTime(s.p95)}</TableCell>
                        <TableCell>{formatTime(s.p99)}</TableCell>
                        <TableCell>{formatPercentage(s.errorRate)}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="py-1">
                                <Sparkline data={latArr} width={120} height={24} />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>
                              {latArr.length ? latArr.map((v,i) => <span key={i}>{i ? ', ' : ''}{v.toFixed ? v.toFixed(0) : v}ms</span>) : <span>-</span>}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate text-muted-foreground" title={s.lastError || ''}>
                          {s.lastError || '-'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                {(!agg.perService || agg.perService.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {t('mon.noHealthData') || 'No health data yet'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Real-time Log & Quick MCP Console */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-primary" />
              <CardTitle>{t('mon.liveLogs')}</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleLogStream}
              className="gap-2"
            >
              {isLogStreamActive ? (
                <>
                  <Pause className="h-4 w-4" />
                  {t('common.pause')}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  {t('common.resume')}
                </>
              )}
            </Button>
          </div>
          <CardDescription>
            {t('mon.liveLogsDesc')} {isLogStreamActive && <Badge variant="outline" className="ml-2 text-primary">{t('mon.connecting')}</Badge>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            ref={logContainerRef}
            className="bg-black dark:bg-slate-950 text-slate-200 dark:text-slate-200 p-4 rounded-lg h-80 overflow-auto font-mono text-sm space-y-1"
          >
            {logs.length === 0 ? (
              <div className="text-slate-400">
                [{formatLogTime(new Date().toISOString())}] {t('mon.waitingLogs')}...
              </div>
            ) : (
              logs.map((log, index) => (
                <div key={index} className={getLevelColor(log.level)}>
                  [{formatLogTime(log.timestamp)}] {log.service && `[${log.service}]`} {log.message}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Monitoring;

// Inline sparkline component (no external deps)
function Sparkline({ data, width = 120, height = 24 }: { data: number[]; width?: number; height?: number }) {
  const path = useMemo(() => {
    if (!data || data.length === 0) return '';
    const w = width;
    const h = height;
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = Math.max(1, max - min);
    const step = data.length > 1 ? (w / (data.length - 1)) : w;
    const points = data.map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h; // invert y (0 at bottom)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(' ');
  }, [data, width, height]);

  if (!data || data.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-primary">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
