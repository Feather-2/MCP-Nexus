import React, { useState, useEffect } from 'react';
import { apiClient, type OrchestratorConfig } from '../api/client';
import SandboxBanner from '@/components/SandboxBanner';
import { useToastHelpers } from '../components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiClient as client } from '@/api/client';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import {
  Server,
  Database,
  Save,
  RotateCcw,
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

  // Load configuration from server
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const [configResult, orchestratorResult] = await Promise.all([
          apiClient.getConfig(),
          apiClient.getOrchestratorConfig()
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
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.loadFail'));
        setOrchestratorError(t('settings.orch.loadFail'));
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, []);

  const handleOrchestratorToggle = (value: boolean) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, enabled: value } : { enabled: value, mode: 'manager-only', subagentsDir: './config/subagents' });
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
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.nodePath}</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Python</div>
              <Badge variant={(sandbox.status?.pythonReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.pythonReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.pythonPath && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.pythonPath}</div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">Go</div>
              <Badge variant={(sandbox.status?.goReady ? 'default' : 'secondary') as any}>
                {sandbox.status?.goReady ? t('settings.ready') : t('settings.notInstalled')}
              </Badge>
              {sandbox.status?.details?.goPath && (
                <div className="text-sm text-foreground/80 truncate">{sandbox.status.details.goPath}</div>
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
            <div>
              <label className="text-sm font-medium">{t('settings.logging.level')}</label>
              <select
                className="w-full h-9 px-3 rounded-md border bg-background"
                value={settings.logging.level}
                onChange={(e) => setSettings({
                  ...settings,
                  logging: { ...settings.logging, level: e.target.value }
                })}
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warning</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.logging.maxFileSize')}</label>
              <Input
                value={settings.logging.maxFileSize}
                onChange={(e) => setSettings({
                  ...settings,
                  logging: { ...settings.logging, maxFileSize: e.target.value }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.logging.maxFiles')}</label>
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium">{t('settings.security.enableAuth')}</label>
              <div className="mt-2">
                <Badge variant={settings.security.enableAuth ? "default" : "secondary"}>
                  {settings.security.enableAuth ? t('common.enabled') : t('common.disabled')}
                </Badge>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.security.sessionTimeout')}</label>
              <Input
                type="number"
                value={settings.security.sessionTimeout}
                onChange={(e) => setSettings({
                  ...settings,
                  security: { ...settings.security, sessionTimeout: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.security.maxLoginAttempts')}</label>
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
            <div>
              <label className="text-sm font-medium">{t('settings.lb.strategy')}</label>
              <select
                className="w-full h-9 px-3 rounded-md border bg-background"
                value={settings.loadBalancing.strategy}
                onChange={(e) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, strategy: e.target.value }
                })}
              >
                <option value="round-robin">{t('settings.lb.strategyRoundRobin')}</option>
                <option value="performance">{t('settings.lb.strategyPerformance')}</option>
                <option value="cost">{t('settings.lb.strategyCost')}</option>
                <option value="content-aware">{t('settings.lb.strategyContentAware')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.lb.healthInterval')}</label>
              <Input
                type="number"
                value={settings.loadBalancing.healthCheckInterval}
                onChange={(e) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, healthCheckInterval: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.lb.maxRetries')}</label>
              <Input
                type="number"
                value={settings.loadBalancing.maxRetries}
                onChange={(e) => setSettings({
                  ...settings,
                  loadBalancing: { ...settings.loadBalancing, maxRetries: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.lb.enableFailover')}</label>
              <div className="mt-2">
                <button
                  onClick={() => setSettings({
                    ...settings,
                    loadBalancing: { ...settings.loadBalancing, enableFailover: !settings.loadBalancing.enableFailover }
                  })}
                  className="flex items-center gap-2"
                >
                  <Badge variant={settings.loadBalancing.enableFailover ? "default" : "secondary"}>
                    {settings.loadBalancing.enableFailover ? t('common.enabled') : t('common.disabled')}
                  </Badge>
                </button>
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
            <div>
              <label className="text-sm font-medium">{t('settings.mcp.version')}</label>
              <select
                className="w-full h-9 px-3 rounded-md border bg-background"
                value={settings.mcp.protocolVersion}
                onChange={(e) => setSettings({
                  ...settings,
                  mcp: { ...settings.mcp, protocolVersion: e.target.value }
                })}
              >
                <option value="2024-11-26">2024-11-26</option>
                <option value="2025-03-26">2025-03-26</option>
                <option value="2025-06-18">2025-06-18</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcp.timeoutMs')}</label>
              <Input
                type="number"
                value={settings.mcp.requestTimeout}
                onChange={(e) => setSettings({
                  ...settings,
                  mcp: { ...settings.mcp, requestTimeout: parseInt(e.target.value) }
                })}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcp.enableTools')}</label>
              <div className="mt-2">
                <button
                  onClick={() => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enableTools: !settings.mcp.enableTools }
                  })}
                >
                  <Badge variant={settings.mcp.enableTools ? "default" : "secondary"}>
                    {settings.mcp.enableTools ? t('common.enabled') : t('common.disabled')}
                  </Badge>
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcp.enableResources')}</label>
              <div className="mt-2">
                <button
                  onClick={() => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enableResources: !settings.mcp.enableResources }
                  })}
                >
                  <Badge variant={settings.mcp.enableResources ? "default" : "secondary"}>
                    {settings.mcp.enableResources ? t('common.enabled') : t('common.disabled')}
                  </Badge>
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcp.enablePrompts')}</label>
              <div className="mt-2">
                <button
                  onClick={() => setSettings({
                    ...settings,
                    mcp: { ...settings.mcp, enablePrompts: !settings.mcp.enablePrompts }
                  })}
                >
                  <Badge variant={settings.mcp.enablePrompts ? "default" : "secondary"}>
                    {settings.mcp.enablePrompts ? t('common.enabled') : t('common.disabled')}
                  </Badge>
                </button>
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
