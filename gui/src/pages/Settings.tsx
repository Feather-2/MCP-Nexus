import React, { useState, useEffect } from 'react';
import { apiClient, type ChannelState, type OrchestratorConfig, type UsageStats } from '../api/client';
import SandboxBanner from '@/components/SandboxBanner';
import { useToastHelpers } from '../components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiClient as client } from '@/api/client';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import {
  Server,
  Database,
  Save,
  RotateCcw,
  RefreshCw,
  Info,
  Shield,
  Zap,
  Network,
  Gauge
} from 'lucide-react';

const Settings: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  const [settings, setSettings] = useState({
    server: {
      port: 19233,
      host: '0.0.0.0',
      maxConnections: 100,
      timeout: 30000
    },
    logging: {
      level: 'info',
      maxFileSize: '10MB',
      maxFiles: 5
    },
    security: {
      enableAuth: true,
      sessionTimeout: 3600,
      maxLoginAttempts: 5
    },
    loadBalancing: {
      strategy: 'round-robin',
      healthCheckInterval: 30000,
      maxRetries: 3,
      enableFailover: true
    },
    mcp: {
      protocolVersion: '2024-11-26',
      enableTools: true,
      enableResources: true,
      enablePrompts: true,
      requestTimeout: 30000
    },
    performance: {
      maxConcurrentRequests: 50,
      requestQueueSize: 1000,
      memoryLimit: '512MB',
      cpuThreshold: 80
    }
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<{ status?: any; installing?: boolean }>({});
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig | null>(null);
  const [orchestratorError, setOrchestratorError] = useState<string | null>(null);
  const [orchestratorSaving, setOrchestratorSaving] = useState(false);
  // AI provider config (non-secret)
  const [aiConfig, setAiConfig] = useState<{ provider: string; model?: string; endpoint?: string; timeoutMs?: number; streaming?: boolean }>(
    { provider: 'none', model: '', endpoint: '', timeoutMs: 30000, streaming: true }
  );
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  // AI channels + usage (requires /api/ai/channels + /api/ai/usage)
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [aiDataLoading, setAiDataLoading] = useState(false);
  const [aiDataError, setAiDataError] = useState<string | null>(null);
  const [aiBusyChannelId, setAiBusyChannelId] = useState<string | null>(null);
  // Client auth (API Key / Bearer) for GUI→API
  const [apiKey, setApiKey] = useState<string>(() => {
    try { return localStorage.getItem('pb_api_key') || '' } catch { return '' }
  });
  const [bearer, setBearer] = useState<string>(() => {
    try { return localStorage.getItem('pb_bearer_token') || '' } catch { return '' }
  });

  // Load configuration from server
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const [configResult, orchestratorResult, aiResult] = await Promise.all([
          apiClient.getConfig(),
          apiClient.getOrchestratorConfig(),
          apiClient.getAiConfig()
        ]);
        if (configResult.ok) {
          // Map server config to UI settings structure
          const config = configResult.data;
          setSettings({
            server: {
              port: config.port || 19233,
              host: config.host || '0.0.0.0',
              maxConnections: config.maxConcurrentServices || 100,
              timeout: config.requestTimeout || 30000
            },
            logging: {
              level: config.logLevel || 'info',
              maxFileSize: '10MB',
              maxFiles: 5
            },
            security: {
              enableAuth: config.authMode !== 'none',
              sessionTimeout: 3600,
              maxLoginAttempts: 5
            },
            loadBalancing: {
              strategy: config.loadBalancingStrategy || 'round-robin',
              healthCheckInterval: config.healthCheckInterval || 30000,
              maxRetries: config.maxRetries || 3,
              enableFailover: config.enableFailover !== false
            },
            mcp: {
              protocolVersion: config.mcpVersion || '2024-11-26',
              enableTools: config.enableMcpTools !== false,
              enableResources: config.enableMcpResources !== false,
              enablePrompts: config.enableMcpPrompts !== false,
              requestTimeout: config.mcpTimeout || 30000
            },
            performance: {
              maxConcurrentRequests: config.maxConcurrentRequests || 50,
              requestQueueSize: config.requestQueueSize || 1000,
              memoryLimit: config.memoryLimit || '512MB',
              cpuThreshold: config.cpuThreshold || 80
            }
          });
        } else {
          setError(configResult.error || t('settings.loadFail'));
        }

        if (orchestratorResult.ok) {
          const cfg = orchestratorResult.data?.config;
          if (cfg) {
            setOrchestratorConfig({
              enabled: cfg.enabled,
              mode: cfg.mode,
              subagentsDir: cfg.subagentsDir || './config/subagents',
              planner: cfg.planner,
              vectorStore: cfg.vectorStore,
              reranker: cfg.reranker,
              budget: cfg.budget,
              routing: cfg.routing
            });
          }
        } else {
          setOrchestratorError(orchestratorResult.error || t('settings.orch.loadFail'));
        }

        if (aiResult.ok && (aiResult.data as any)?.config) {
          const aic = (aiResult.data as any).config || {};
          setAiConfig({
            provider: aic.provider || 'none',
            model: aic.model || '',
            endpoint: aic.endpoint || '',
            timeoutMs: typeof aic.timeoutMs === 'number' ? aic.timeoutMs : 30000,
            streaming: aic.streaming !== false
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.loadFail'));
        setOrchestratorError(t('settings.orch.loadFail'));
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, []);

  const unwrapData = (payload: any) => {
    if (!payload) return payload;
    if (typeof payload === 'object' && 'data' in payload) return (payload as any).data;
    return payload;
  };

  const refreshAiData = async () => {
    setAiDataLoading(true);
    setAiDataError(null);
    try {
      const [channelsRes, usageRes] = await Promise.all([
        apiClient.request<any>(`/api/ai/channels`),
        apiClient.request<any>(`/api/ai/usage`)
      ]);

      if (channelsRes.ok) {
        const list = unwrapData(channelsRes.data);
        setChannels(Array.isArray(list) ? list : (Array.isArray(list?.channels) ? list.channels : []));
      } else {
        setChannels([]);
        setAiDataError(channelsRes.error || 'Failed to fetch AI channels');
      }

      if (usageRes.ok) {
        const u = unwrapData(usageRes.data);
        setUsage(u || null);
      } else {
        setUsage(null);
        setAiDataError((prev) => prev || usageRes.error || 'Failed to fetch AI usage');
      }
    } catch (e) {
      setChannels([]);
      setUsage(null);
      setAiDataError(e instanceof Error ? e.message : 'Failed to fetch AI data');
    } finally {
      setAiDataLoading(false);
    }
  };

  useEffect(() => {
    void refreshAiData();
  }, []);

  const toggleChannel = async (channelId: string, enabled: boolean) => {
    setAiBusyChannelId(channelId);
    try {
      const endpoint = enabled
        ? `/api/ai/channels/${encodeURIComponent(channelId)}/disable`
        : `/api/ai/channels/${encodeURIComponent(channelId)}/enable`;
      const res = await apiClient.request(endpoint, {
        method: 'POST',
        ...(enabled ? { body: JSON.stringify({ reason: 'disabled via gui' }) } : {})
      });
      if (res.ok) {
        success(enabled ? 'Channel disabled' : 'Channel enabled');
        await refreshAiData();
      } else {
        showError('Channel update failed', res.error || 'Unknown error');
      }
    } catch (e) {
      showError('Channel update failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setAiBusyChannelId(null);
    }
  };

  const testChannel = async (channelId: string) => {
    setAiBusyChannelId(channelId);
    try {
      // Prefer per-channel test endpoint if available
      const direct = await apiClient.request<any>(`/api/ai/channels/${encodeURIComponent(channelId)}/test`, { method: 'POST' });
      if (direct.ok) {
        success('Channel test OK');
        return;
      }

      // Fallback: provider-level environment check
      const channel = channels.find((c) => c.channelId === channelId);
      const fallback = await apiClient.testAiConnectivity({
        provider: channel?.provider,
        model: channel?.model,
        mode: 'env-only'
      });
      if (fallback.ok && (fallback.data as any)?.success) {
        success('AI environment OK');
      } else {
        showError('Channel test failed', direct.error || fallback.error || 'Unknown error');
      }
    } catch (e) {
      showError('Channel test failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setAiBusyChannelId(null);
    }
  };

  const handleOrchestratorToggle = (value: boolean) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, enabled: value } : { enabled: value, mode: 'manager-only', subagentsDir: './config/subagents' });
  };

  const handleAiSave = async () => {
    try {
      setAiSaving(true);
      const res = await apiClient.updateAiConfig(aiConfig);
      if (res.ok) {
        success(t('settings.ai.saveSuccess'));
      } else {
        showError(t('settings.ai.saveFail'), res.error || t('common.unknownError'));
      }
    } catch (err) {
      showError(t('settings.ai.saveFail'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setAiSaving(false);
    }
  };

  const handleAiTest = async (mode: 'env-only' | 'ping' = 'env-only') => {
    try {
      setAiTesting(true);
      const res = await apiClient.testAiConnectivity({ provider: aiConfig.provider, endpoint: aiConfig.endpoint, model: aiConfig.model, mode });
      if (res.ok && (res.data as any)?.success) {
        success(t('settings.ai.testOk'));
      } else {
        const data: any = res.data || {};
        const missing = data.env?.missing?.join(', ');
        showError(t('settings.ai.testFail'), missing ? `${t('settings.ai.missing')}: ${missing}` : (res.error || ''));
      }
    } catch (err) {
      showError(t('settings.ai.testFail'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setAiTesting(false);
    }
  };

  const handleOrchestratorMode = (value: string) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, mode: value as OrchestratorConfig['mode'] } : { enabled: false, mode: value as OrchestratorConfig['mode'], subagentsDir: './config/subagents' });
  };

  const handleOrchestratorDir = (value: string) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, subagentsDir: value } : { enabled: false, mode: 'manager-only', subagentsDir: value });
  };

  const handleOrchestratorSave = async () => {
    if (!orchestratorConfig) return;
    setOrchestratorSaving(true);
    setOrchestratorError(null);
    try {
      const updates = {
        enabled: orchestratorConfig.enabled,
        mode: orchestratorConfig.mode,
        subagentsDir: orchestratorConfig.subagentsDir
      };
      const result = await apiClient.updateOrchestratorConfig(updates);
      if (result.ok) {
        const updated = result.data?.config;
        if (updated) {
          setOrchestratorConfig({
            enabled: updated.enabled,
            mode: updated.mode,
            subagentsDir: updated.subagentsDir || orchestratorConfig.subagentsDir,
            planner: updated.planner,
            vectorStore: updated.vectorStore,
            reranker: updated.reranker,
            budget: updated.budget,
            routing: updated.routing
          });
        }
        success(t('settings.orch.saveSuccess'), t('settings.orch.saveSuccessDesc'));
      } else {
        setOrchestratorError(result.error || t('settings.orch.saveFail'));
        showError(t('settings.orch.saveFail'), result.error || t('common.unknownError'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.orch.saveFail');
      setOrchestratorError(msg);
      showError(t('settings.orch.saveFail'), msg);
    } finally {
      setOrchestratorSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // Save GUI auth first
      apiClient.setAuth({ apiKey: apiKey || null, bearerToken: bearer || null });

      // Map UI settings back to server config structure
      const configUpdates = {
        port: settings.server.port,
        host: settings.server.host,
        maxConcurrentServices: settings.server.maxConnections,
        requestTimeout: settings.server.timeout,
        logLevel: settings.logging.level,
        authMode: settings.security.enableAuth ? 'dual' : 'none',
        loadBalancingStrategy: settings.loadBalancing.strategy,
        healthCheckInterval: settings.loadBalancing.healthCheckInterval,
        maxRetries: settings.loadBalancing.maxRetries,
        enableFailover: settings.loadBalancing.enableFailover,
        mcpVersion: settings.mcp.protocolVersion,
        enableMcpTools: settings.mcp.enableTools,
        enableMcpResources: settings.mcp.enableResources,
        enableMcpPrompts: settings.mcp.enablePrompts,
        mcpTimeout: settings.mcp.requestTimeout,
        maxConcurrentRequests: settings.performance.maxConcurrentRequests,
        requestQueueSize: settings.performance.requestQueueSize,
        memoryLimit: settings.performance.memoryLimit,
        cpuThreshold: settings.performance.cpuThreshold
      };

      const result = await apiClient.updateConfig(configUpdates);

      if (result.ok) {
        success(t('settings.saveSuccess'), t('settings.saveSuccessDesc'));
      } else {
        setError(result.error || t('settings.saveFail'));
        showError(t('settings.saveFailShort'), result.error || t('common.unknownError'));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('settings.saveFail');
      setError(errorMsg);
      showError(t('settings.saveFailShort'), errorMsg);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setSettings({
      server: {
        port: 19233,
        host: '0.0.0.0',
        maxConnections: 100,
        timeout: 30000
      },
      logging: {
        level: 'info',
        maxFileSize: '10MB',
        maxFiles: 5
      },
      security: {
        enableAuth: true,
        sessionTimeout: 3600,
        maxLoginAttempts: 5
      },
      loadBalancing: {
        strategy: 'round-robin',
        healthCheckInterval: 30000,
        maxRetries: 3,
        enableFailover: true
      },
      mcp: {
        protocolVersion: '2024-11-26',
        enableTools: true,
        enableResources: true,
        enablePrompts: true,
        requestTimeout: 30000
      },
      performance: {
        maxConcurrentRequests: 50,
        requestQueueSize: 1000,
        memoryLimit: '512MB',
        cpuThreshold: 80
      }
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-lg text-muted-foreground">{t('settings.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SandboxBanner />
      <PageHeader
        title={t('settings.title')}
        description={t('settings.desc')}
        actions={<>
          <Button onClick={handleSave} disabled={saving} className="gap-2">
            <Save className="h-4 w-4" /> {saving ? t('settings.saving') : t('settings.save')}
          </Button>
          <Button variant="outline" onClick={handleReset} disabled={saving} className="gap-2">
            <RotateCcw className="h-4 w-4" /> {t('common.reset')}
          </Button>
        </>}
      />

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="pt-6">
            <p className="text-red-800 dark:text-red-200">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* AI Provider Settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.ai.title')}</CardTitle>
          <CardDescription>{t('settings.ai.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('settings.ai.provider')}</Label>
              <Select value={aiConfig.provider} onValueChange={(v) => setAiConfig({ ...aiConfig, provider: v })}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="openai">openai</SelectItem>
                  <SelectItem value="anthropic">anthropic</SelectItem>
                  <SelectItem value="azure-openai">azure-openai</SelectItem>
                  <SelectItem value="ollama">ollama</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('settings.ai.model')}</Label>
              <Input className="mt-1" value={aiConfig.model || ''} onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })} placeholder="gpt-4o-mini / claude-3-haiku / ..." />
            </div>
            <div>
              <Label>{t('settings.ai.endpoint')}</Label>
              <Input className="mt-1" value={aiConfig.endpoint || ''} onChange={(e) => setAiConfig({ ...aiConfig, endpoint: e.target.value })} placeholder="可选：自定义 Endpoint 或本地 Ollama 地址" />
            </div>
            <div>
              <Label>{t('settings.ai.timeout')}</Label>
              <Input className="mt-1" type="number" value={aiConfig.timeoutMs || 30000} onChange={(e) => setAiConfig({ ...aiConfig, timeoutMs: parseInt(e.target.value || '0', 10) || 30000 })} />
            </div>
            <div className="flex items-center space-x-3">
              <Switch checked={aiConfig.streaming !== false} onCheckedChange={(v) => setAiConfig({ ...aiConfig, streaming: !!v })} />
              <Label>{t('settings.ai.streaming')}</Label>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <Button onClick={handleAiSave} disabled={aiSaving}>{t('settings.ai.save')}</Button>
            <Button variant="outline" onClick={() => handleAiTest('env-only')} disabled={aiTesting}>{t('settings.ai.envOnly')}</Button>
            <Button variant="outline" onClick={() => handleAiTest('ping')} disabled={aiTesting}>{t('settings.ai.ping')}</Button>
          </div>
        </CardContent>
      </Card>

      {/* AI Channels */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>AI Channels</CardTitle>
              <CardDescription>Channels routing, status, and live metrics</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={refreshAiData} disabled={aiDataLoading} className="gap-2">
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {aiDataError && (
            <p className="text-sm text-red-600 dark:text-red-400">{aiDataError}</p>
          )}

          {!aiDataLoading && channels.length === 0 && (
            <p className="text-sm text-muted-foreground">No channels found (or the API is not enabled).</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {channels.map((channel) => (
              <Card key={channel.channelId}>
                <CardHeader>
                  <div className="flex justify-between items-center">
                    <div>
                      <h3 className="font-semibold leading-none tracking-tight">{channel.channelId}</h3>
                      <p className="text-sm text-muted-foreground">
                        {channel.provider} / {channel.model}
                      </p>
                    </div>
                    <Badge variant={channel.enabled ? 'default' : 'destructive'}>
                      {channel.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Requests</p>
                      <p className="font-medium">{channel.metrics?.totalRequests ?? 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Errors</p>
                      <p className="font-medium">{channel.metrics?.totalErrors ?? 0}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Avg Latency</p>
                      <p className="font-medium">{Math.round(channel.metrics?.avgLatencyMs ?? 0)}ms</p>
                    </div>
                  </div>
                  {(channel.cooldownUntil || channel.consecutiveFailures) && (
                    <div className="mt-3 text-xs text-muted-foreground">
                      {channel.consecutiveFailures ? `Failures: ${channel.consecutiveFailures}` : null}
                      {channel.cooldownUntil ? `${channel.consecutiveFailures ? ' · ' : ''}Cooldown until: ${channel.cooldownUntil}` : null}
                    </div>
                  )}
                  <div className="mt-4 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={aiBusyChannelId === channel.channelId}
                      onClick={() => testChannel(channel.channelId)}
                    >
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant={channel.enabled ? 'destructive' : 'default'}
                      disabled={aiBusyChannelId === channel.channelId}
                      onClick={() => toggleChannel(channel.channelId, channel.enabled)}
                    >
                      {channel.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* AI Cost & Usage */}
      <Card>
        <CardHeader>
          <CardTitle>Cost & Usage</CardTitle>
          <CardDescription>Total cost, budget, and per-model breakdown</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!usage && (
            <p className="text-sm text-muted-foreground">Usage data unavailable.</p>
          )}

          {usage && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Total Cost</p>
                  <p className="text-lg font-semibold">${Number(usage.totalCostUsd || 0).toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Prompt Tokens</p>
                  <p className="text-lg font-semibold">{usage.totalPromptTokens ?? 0}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Completion Tokens</p>
                  <p className="text-lg font-semibold">{usage.totalCompletionTokens ?? 0}</p>
                </div>
              </div>

              {typeof usage.budgetUsd === 'number' && usage.budgetUsd > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Budget</span>
                    <span>
                      $
                      {Number(
                        typeof usage.budgetRemaining === 'number'
                          ? usage.budgetUsd - usage.budgetRemaining
                          : usage.totalCostUsd || 0
                      ).toFixed(2)}
                      {' / '}
                      ${Number(usage.budgetUsd).toFixed(2)}
                    </span>
                  </div>
                  <Progress
                    value={Math.min(
                      100,
                      Math.max(
                        0,
                        ((typeof usage.budgetRemaining === 'number'
                          ? usage.budgetUsd - usage.budgetRemaining
                          : usage.totalCostUsd || 0) /
                          usage.budgetUsd) *
                          100
                      )
                    )}
                    className="h-2"
                  />
                </div>
              )}

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Prompt</TableHead>
                      <TableHead className="text-right">Completion</TableHead>
                      <TableHead className="text-right">Cost (USD)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(usage.byModel || {})
                      .map(([model, s]) => ({ model, ...s }))
                      .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))
                      .map((row) => (
                        <TableRow key={row.model}>
                          <TableCell className="font-medium">{row.model}</TableCell>
                          <TableCell className="text-right">{row.requests ?? 0}</TableCell>
                          <TableCell className="text-right">{row.promptTokens ?? 0}</TableCell>
                          <TableCell className="text-right">{row.completionTokens ?? 0}</TableCell>
                          <TableCell className="text-right">${Number(row.costUsd || 0).toFixed(4)}</TableCell>
                        </TableRow>
                      ))}
                    {Object.keys(usage.byModel || {}).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-sm text-muted-foreground">
                          No per-model usage yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.orch.title')}</CardTitle>
          <CardDescription>{t('settings.orch.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="orch-enabled" className="text-sm font-medium">
                {t('settings.orch.enable')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.orch.enableDesc')}
              </p>
            </div>
            <Switch
              id="orch-enabled"
              checked={Boolean(orchestratorConfig?.enabled)}
              onCheckedChange={handleOrchestratorToggle}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="orch-mode">{t('settings.orch.mode')}</Label>
            <Select value={orchestratorConfig?.mode ?? 'manager-only'} onValueChange={handleOrchestratorMode}>
              <SelectTrigger id="orch-mode">
                <SelectValue placeholder={t('settings.orch.modePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager-only">{t('settings.orch.mode.manager-only')}</SelectItem>
                <SelectItem value="auto">{t('settings.orch.mode.auto')}</SelectItem>
                <SelectItem value="wrapper-prefer">{t('settings.orch.mode.wrapper-prefer')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="orch-subagents">{t('settings.orch.subagents')}</Label>
            <Input
              id="orch-subagents"
              value={orchestratorConfig?.subagentsDir ?? ''}
              onChange={(event) => handleOrchestratorDir(event.target.value)}
              placeholder="./config/subagents"
            />
          </div>

          {orchestratorError && (
            <p className="text-sm text-red-600 dark:text-red-400">{orchestratorError}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Badge variant={orchestratorConfig?.enabled ? 'default' : 'secondary'}>
              {orchestratorConfig?.enabled ? t('common.enabled') : t('common.disabled')}
            </Badge>
            <Button onClick={handleOrchestratorSave} disabled={orchestratorSaving}>
              {orchestratorSaving ? t('settings.orch.saving') : t('settings.orch.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Server Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-emerald-600" />
            <CardTitle>{t('settings.server.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.server.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{t('settings.server.port')}</label>
              <Input
                type="number"
                value={settings.server.port}
                onChange={(e) => setSettings({
                  ...settings,
                  server: { ...settings.server, port: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.server.host')}</label>
              <Input
                value={settings.server.host}
                onChange={(e) => setSettings({
                  ...settings,
                  server: { ...settings.server, host: e.target.value }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.server.maxConnections')}</label>
              <Input
                type="number"
                value={settings.server.maxConnections}
                onChange={(e) => setSettings({
                  ...settings,
                  server: { ...settings.server, maxConnections: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.server.timeoutMs')}</label>
              <Input
                type="number"
                value={settings.server.timeout}
                onChange={(e) => setSettings({
                  ...settings,
                  server: { ...settings.server, timeout: parseInt(e.target.value) }
                })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sandbox Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-emerald-600" />
            <CardTitle>{t('settings.sandbox.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.sandbox.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={sandbox.installing}
              onClick={async () => {
                setSandbox(s => ({ ...s, installing: true }));
                await client.installSandbox(['node', 'python', 'go', 'packages']);
                const res = await client.getSandboxStatus();
                setSandbox({ status: res.ok ? res.data : sandbox.status, installing: false });
              }}
            >
              {sandbox.installing ? t('settings.sandbox.installing') : t('settings.sandbox.installRepair')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await client.repairTemplates();
                const res = await client.getSandboxStatus();
                setSandbox({ ...sandbox, status: res.ok ? res.data : sandbox.status });
              }}
            >
              {t('settings.sandbox.repairPlaceholders')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const res = await client.getSandboxStatus();
                setSandbox({ ...sandbox, status: res.ok ? res.data : sandbox.status });
              }}
            >
              {t('settings.sandbox.refresh')}
            </Button>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Node</div>
              <Badge variant={(sandbox.status?.nodeReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.nodeReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.nodePath && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.nodePath}{sandbox.status.details.nodeVersion ? ` (${sandbox.status.details.nodeVersion})` : ''}</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Python</div>
              <Badge variant={(sandbox.status?.pythonReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.pythonReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.pythonPath && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.pythonPath}{sandbox.status.details.pythonVersion ? ` (${sandbox.status.details.pythonVersion})` : ''}</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Go</div>
              <Badge variant={(sandbox.status?.goReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.goReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.goPath && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.goPath}{sandbox.status.details.goVersion ? ` (${sandbox.status.details.goVersion})` : ''}</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">{t('settings.sandbox.mcpPackages')}</div>
              <Badge variant={(sandbox.status?.packagesReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.packagesReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.packagesDir && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.packagesDir}</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Logging Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-amber-600" />
            <CardTitle>{t('settings.logging.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.logging.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.logging.level')}</Label>
              <Select
                value={settings.logging.level}
                onValueChange={(v) => setSettings({
                  ...settings,
                  logging: { ...settings.logging, level: v }
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">Debug</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warn">Warning</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.logging.maxFileSize')}</Label>
              <Input
                value={settings.logging.maxFileSize}
                onChange={(e) => setSettings({
                  ...settings,
                  logging: { ...settings.logging, maxFileSize: e.target.value }
                })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.logging.maxFiles')}</Label>
              <Input
                type="number"
                value={settings.logging.maxFiles}
                onChange={(e) => setSettings({
                  ...settings,
                  logging: { ...settings.logging, maxFiles: parseInt(e.target.value) }
                })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-emerald-600" />
            <CardTitle>{t('settings.security.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.security.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* GUI Authentication (for API calls) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>API Key (X-API-Key)</Label>
              <Input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="pbk_xxx..."
              />
            </div>
            <div className="space-y-2">
              <Label>Bearer Token (Authorization)</Label>
              <Input
                value={bearer}
                onChange={(e) => setBearer(e.target.value)}
                placeholder="eyJhbGci... (可留空)"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col space-y-3">
              <Label>{t('settings.security.enableAuth')}</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="sec-auth"
                  checked={settings.security.enableAuth}
                  onCheckedChange={(v) => setSettings({
                    ...settings,
                    security: { ...settings.security, enableAuth: v }
                  })}
                />
                <Label htmlFor="sec-auth" className="font-normal text-muted-foreground">
                  {settings.security.enableAuth ? t('common.enabled') : t('common.disabled')}
                </Label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.security.sessionTimeout')}</Label>
              <Input
                type="number"
                value={settings.security.sessionTimeout}
                onChange={(e) => setSettings({
                  ...settings,
                  security: { ...settings.security, sessionTimeout: parseInt(e.target.value) }
                })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.security.maxLoginAttempts')}</Label>
              <Input
                type="number"
                value={settings.security.maxLoginAttempts}
                onChange={(e) => setSettings({
                  ...settings,
                  security: { ...settings.security, maxLoginAttempts: parseInt(e.target.value) }
                })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Load Balancing Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-amber-600" />
            <CardTitle>{t('settings.lb.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.lb.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.lb.strategy')}</Label>
              <Select
                value={settings.loadBalancing.strategy}
                onValueChange={(v) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, strategy: v }
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="round-robin">{t('settings.lb.strategyRoundRobin')}</SelectItem>
                  <SelectItem value="performance">{t('settings.lb.strategyPerformance')}</SelectItem>
                  <SelectItem value="cost">{t('settings.lb.strategyCost')}</SelectItem>
                  <SelectItem value="content-aware">{t('settings.lb.strategyContentAware')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.lb.healthInterval')}</Label>
              <Input
                type="number"
                value={settings.loadBalancing.healthCheckInterval}
                onChange={(e) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, healthCheckInterval: parseInt(e.target.value) }
                })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.lb.maxRetries')}</Label>
              <Input
                type="number"
                value={settings.loadBalancing.maxRetries}
                onChange={(e) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, maxRetries: parseInt(e.target.value) }
                })}
              />
            </div>
            <div className="flex flex-col space-y-3">
              <Label>{t('settings.lb.enableFailover')}</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="lb-failover"
                  checked={settings.loadBalancing.enableFailover}
                  onCheckedChange={(v) => setSettings({
                    ...settings,
                    loadBalancing: { ...settings.loadBalancing, enableFailover: v }
                  })}
                />
                <Label htmlFor="lb-failover" className="font-normal text-muted-foreground">
                  {settings.loadBalancing.enableFailover ? t('common.enabled') : t('common.disabled')}
                </Label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* MCP Protocol Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-emerald-600" />
            <CardTitle>{t('settings.mcp.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.mcp.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('settings.mcp.version')}</Label>
              <Select
                value={settings.mcp.protocolVersion}
                onValueChange={(v) => setSettings({
                  ...settings,
                  mcp: { ...settings.mcp, protocolVersion: v }
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2024-11-26">2024-11-26</SelectItem>
                  <SelectItem value="2025-03-26">2025-03-26</SelectItem>
                  <SelectItem value="2025-06-18">2025-06-18</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.mcp.timeoutMs')}</Label>
              <Input
                type="number"
                value={settings.mcp.requestTimeout}
                onChange={(e) => setSettings({
                  ...settings,
                  mcp: { ...settings.mcp, requestTimeout: parseInt(e.target.value) }
                })}
              />
            </div>
            <div className="flex flex-col space-y-3">
              <Label>{t('settings.mcp.enableTools')}</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="mcp-tools"
                  checked={settings.mcp.enableTools}
                  onCheckedChange={(v) => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enableTools: v }
                  })}
                />
                <Label htmlFor="mcp-tools" className="font-normal text-muted-foreground">
                  {settings.mcp.enableTools ? t('common.enabled') : t('common.disabled')}
                </Label>
              </div>
            </div>
            <div className="flex flex-col space-y-3">
              <Label>{t('settings.mcp.enableResources')}</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="mcp-resources"
                  checked={settings.mcp.enableResources}
                  onCheckedChange={(v) => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enableResources: v }
                  })}
                />
                <Label htmlFor="mcp-resources" className="font-normal text-muted-foreground">
                  {settings.mcp.enableResources ? t('common.enabled') : t('common.disabled')}
                </Label>
              </div>
            </div>
            <div className="flex flex-col space-y-3">
              <Label>{t('settings.mcp.enablePrompts')}</Label>
              <div className="flex items-center space-x-2">
                <Switch
                  id="mcp-prompts"
                  checked={settings.mcp.enablePrompts}
                  onCheckedChange={(v) => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enablePrompts: v }
                  })}
                />
                <Label htmlFor="mcp-prompts" className="font-normal text-muted-foreground">
                  {settings.mcp.enablePrompts ? t('common.enabled') : t('common.disabled')}
                </Label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Performance Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-amber-700" />
            <CardTitle>{t('settings.perf.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.perf.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">{t('settings.perf.maxConcurrent')}</label>
              <Input
                type="number"
                value={settings.performance.maxConcurrentRequests}
                onChange={(e) => setSettings({
                  ...settings,
                  performance: { ...settings.performance, maxConcurrentRequests: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.perf.queueSize')}</label>
              <Input
                type="number"
                value={settings.performance.requestQueueSize}
                onChange={(e) => setSettings({
                  ...settings,
                  performance: { ...settings.performance, requestQueueSize: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.perf.memoryLimit')}</label>
              <Input
                value={settings.performance.memoryLimit}
                onChange={(e) => setSettings({
                  ...settings,
                  performance: { ...settings.performance, memoryLimit: e.target.value }
                })}
                placeholder="512MB"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.perf.cpuThreshold')}</label>
              <Input
                type="number"
                value={settings.performance.cpuThreshold}
                onChange={(e) => setSettings({
                  ...settings,
                  performance: { ...settings.performance, cpuThreshold: parseInt(e.target.value) }
                })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* System Info */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Info className="h-5 w-5 text-emerald-700" />
            <CardTitle>{t('settings.systemInfo.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.systemInfo.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="text-sm text-slate-600 dark:text-slate-400">{t('common.version')}</div>
              <div className="font-medium">v1.0.0</div>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-slate-600 dark:text-slate-400">{t('settings.systemInfo.runtime')}</div>
              <div className="font-medium">Node.js</div>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-slate-600 dark:text-slate-400">{t('settings.systemInfo.platform')}</div>
              <div className="font-medium">Windows</div>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-slate-600 dark:text-slate-400">{t('settings.systemInfo.arch')}</div>
              <div className="font-medium">x64</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Settings;
