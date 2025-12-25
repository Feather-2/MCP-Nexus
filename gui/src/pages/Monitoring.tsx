import React, { useState, useEffect, useRef, useMemo } from 'react';
import { apiClient, type HealthStatus } from '../api/client';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import {
  Activity,
  Clock,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Download,
  Wifi
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
      rows.push(['serviceId', 'serviceName', 'lastLatency', 'p95', 'p99', 'errorRate', 'samples', 'lastError'].join(','))
      const per = agg.perService || []
      for (const s of per) {
        const svc = svcMetrics.find(v => v.serviceId === s.id)
        const name = (svc?.serviceName || s.id).replaceAll('"', '\"')
        const lastLatency = s.last?.latency ?? ''
        const cols = [s.id, name, lastLatency, s.p95 ?? '', s.p99 ?? '', s.errorRate ?? '', s.samples ?? '', (s.lastError || '').replaceAll('\n', ' ').replaceAll('"', '\"')]
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
    <div className="space-y-10">
      <PageHeader
        title={t('mon.title')}
        description={t('mon.desc')}
        actions={<Button variant="outline" size="sm" onClick={loadHealthData} className="gap-2 h-8"><RefreshCw className="h-3.5 w-3.5" /> {t('common.refresh')}</Button>}
      />

      {error && (
        <div className="rounded-md border border-red-100 bg-red-50/50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        </div>
      )}

      {/* Metrics Grid - 无背景平面化 */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {[
          { label: t('mon.totalRequests'), value: formatNumber(healthStatus?.metrics?.totalRequests), icon: Activity },
          { label: t('mon.successRate'), value: formatPercentage(healthStatus?.metrics?.successRate), icon: CheckCircle },
          { label: t('mon.avgResponse'), value: formatTime(healthStatus?.metrics?.averageResponseTime), icon: Clock },
          { label: t('mon.activeConns'), value: formatNumber(healthStatus?.metrics?.activeConnections), icon: Wifi },
        ].map((item, i) => (
          <div key={i} className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground/50">
              <item.icon className="h-3 w-3" />
              {item.label}
            </div>
            <div className="text-2xl font-bold tracking-tight">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        {/* Gateway & Services Table */}
        <div className="space-y-10">
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground/40">{t('mon.gateway')}</h3>
              <div className="flex items-center gap-4 text-xs font-medium">
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${healthStatus?.gateway?.status === 'healthy' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  {healthStatus?.gateway?.status === 'healthy' ? t('status.healthy') : t('status.unhealthy')}
                </span>
                <span className="text-muted-foreground/60">{formatUptime(healthStatus?.gateway?.uptime)}</span>
              </div>
            </div>

            <div className="rounded-lg border border-border/50 bg-card/30 p-1">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-none">
                    <TableHead className="h-8 text-[10px] uppercase tracking-wider">{t('mon.service')}</TableHead>
                    <TableHead className="h-8 text-right text-[10px] uppercase tracking-wider">{t('mon.p95')}</TableHead>
                    <TableHead className="h-8 text-right text-[10px] uppercase tracking-wider">{t('mon.errorRate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agg.perService && [...agg.perService].slice(0, 5).map((s: any) => (
                    <TableRow key={s.id} className="border-border/30">
                      <TableCell className="py-2.5 text-xs font-medium">{svcMetrics.find(v => v.serviceId === s.id)?.serviceName || s.id}</TableCell>
                      <TableCell className="py-2.5 text-right text-xs tabular-nums">{formatTime(s.p95)}</TableCell>
                      <TableCell className="py-2.5 text-right text-xs tabular-nums">{formatPercentage(s.errorRate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>

        {/* Real-time Logs - 极致简约桌面风格 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground/40">{t('mon.liveLogs')}</h3>
            <button
              onClick={toggleLogStream}
              className="text-[10px] font-bold uppercase tracking-widest text-primary hover:opacity-80 transition-opacity"
            >
              {isLogStreamActive ? t('common.pause') : t('common.resume')}
            </button>
          </div>

          <div className="relative group">
            <div
              ref={logContainerRef}
              className="h-[400px] overflow-auto rounded-lg border border-border/50 bg-muted/20 p-6 font-mono text-[12px] leading-relaxed selection:bg-primary/20"
            >
              {logs.length === 0 ? (
                <div className="flex h-full items-center justify-center text-muted-foreground/40 italic">
                  {t('mon.waitingLogs')}...
                </div>
              ) : (
                <div className="space-y-1.5">
                  {logs.map((log, index) => (
                    <div key={index} className="flex gap-3 group/line">
                      <span className="shrink-0 text-muted-foreground/30 tabular-nums">
                        {formatLogTime(log.timestamp)}
                      </span>
                      <span className={`shrink-0 font-bold uppercase ${log.level.toLowerCase() === 'error' ? 'text-red-500' :
                        log.level.toLowerCase() === 'warn' ? 'text-amber-500' :
                          'text-muted-foreground/40'
                        }`}>
                        {log.level.padEnd(5)}
                      </span>
                      <span className="flex-1 text-foreground/80 break-all">
                        {log.service && <span className="text-primary/60 mr-2">[{log.service}]</span>}
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Minimalistic Scroll Indicator */}
            <div className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary/40 animate-pulse opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </section>
      </div>

      {/* Advanced Health Stats */}
      <section className="space-y-6 pt-10 border-t border-border/30">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground/40">{t('mon.services')}</h3>
            <p className="text-[11px] text-muted-foreground/50">{t('mon.servicesDesc')}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={exportHealthJSON} disabled={exporting} className="h-7 text-[10px] uppercase tracking-wider gap-1.5">
              <Download className="h-3 w-3" /> JSON
            </Button>
            <Button variant="ghost" size="sm" onClick={exportHealthCSV} disabled={exporting} className="h-7 text-[10px] uppercase tracking-wider gap-1.5">
              <Download className="h-3 w-3" /> CSV
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border/40 bg-card/20 overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[10px] uppercase tracking-wider">{t('mon.service')}</TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider">{t('mon.latency')}</TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider">{t('mon.p95')}</TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider">{t('mon.errorRate')}</TableHead>
                <TableHead className="text-center text-[10px] uppercase tracking-wider">{t('mon.latencyTrend')}</TableHead>
                <TableHead className="text-right text-[10px] uppercase tracking-wider">{t('mon.lastError')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agg.perService && [...agg.perService]
                .map((s: any) => {
                  const svc = svcMetrics.find(v => v.serviceId === s.id);
                  const name = svc?.serviceName || s.id;
                  const latArr: number[] = Array.isArray(s.latencies) ? s.latencies : [];
                  return (
                    <TableRow key={s.id} className="border-border/20 group hover:bg-muted/10 transition-colors">
                      <TableCell className="py-3 text-xs font-semibold">{name}</TableCell>
                      <TableCell className="py-3 text-right text-xs tabular-nums">{formatTime(s.last?.latency)}</TableCell>
                      <TableCell className="py-3 text-right text-xs tabular-nums">{formatTime(s.p95)}</TableCell>
                      <TableCell className="py-3 text-right text-xs">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${(s.errorRate || 0) > 0.05 ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-500'
                          }`}>
                          {formatPercentage(s.errorRate)}
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex justify-center opacity-60 group-hover:opacity-100 transition-opacity">
                          <Sparkline data={latArr} width={80} height={16} />
                        </div>
                      </TableCell>
                      <TableCell className="py-3 text-right text-[10px] text-muted-foreground/60 max-w-[200px] truncate">
                        {s.lastError || '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      </section>
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
