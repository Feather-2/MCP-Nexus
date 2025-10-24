import React, { useState, useEffect, useRef } from 'react';
import { apiClient, type HealthStatus } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import PageHeader from '@/components/PageHeader';
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
  Play
} from 'lucide-react';

const Monitoring: React.FC = () => {
  const { t } = useI18n();
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ timestamp: string; level: string; message: string; service?: string }>>([]);
  const [isLogStreamActive, setIsLogStreamActive] = useState(true);
  const logStreamRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const loadHealthData = async () => {
    try {
      const result = await apiClient.getHealthStatus();
      if (result.ok) {
        setHealthStatus(result.data || null);
        setError(null);
      } else {
        setError(result.error || '加载监控数据失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载监控数据失败');
    } finally {
      // setLoading(false); // Remove unused loading state
    }
  };

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
      case 'error': return 'text-destructive';
      case 'warn': return 'text-amber-600';
      case 'info': return 'text-primary';
      case 'debug': return 'text-foreground/70';
      default: return 'text-muted-foreground';
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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

      {/* Service Status */}
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-4 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.total || 0}
              </div>
              <div className="text-sm text-muted-foreground">{t('mon.totalServices')}</div>
            </div>
            <div className="text-center p-4 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.running || 0}
              </div>
              <div className="text-sm text-muted-foreground">{t('status.running')}</div>
            </div>
            <div className="text-center p-4 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.stopped || 0}
              </div>
              <div className="text-sm text-muted-foreground">{t('status.stopped')}</div>
            </div>
            <div className="text-center p-4 bg-muted/30 rounded-lg">
              <div className="text-2xl font-semibold mb-1">
                {healthStatus?.services?.error || 0}
              </div>
              <div className="text-sm text-muted-foreground">{t('status.error')}</div>
            </div>
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
            className="bg-black dark:bg-slate-950 text-foreground p-4 rounded-lg h-80 overflow-auto font-mono text-sm space-y-1"
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