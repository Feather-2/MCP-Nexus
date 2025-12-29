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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import {
  Server,
  Save,
  RotateCcw,
  RefreshCw,
  Info,
  Shield,
  Zap,
  Plus,
  Trash2,
  Power,
  PowerOff,
  TestTube
} from 'lucide-react';

// Channel form for add dialog
interface ChannelForm {
  id: string;
  provider: string;
  model: string;
  keySourceType: 'env' | 'literal';
  keySourceValue: string;
  keyRotation: 'polling' | 'random';
  weight: number;
  baseUrl?: string;
}

const Settings: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  // Simplified settings - only what's actually implemented
  const [settings, setSettings] = useState({
    server: { port: 19233, host: '127.0.0.1' },
    logLevel: 'info'
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<{ status?: any; installing?: boolean }>({});
  const [gatewaySandbox, setGatewaySandbox] = useState<{
    profile: 'dev' | 'default' | 'locked-down';
    requiredForUntrusted: boolean;
    preferContainer: boolean;
  }>(() => ({
    profile: 'default',
    requiredForUntrusted: false,
    preferContainer: false
  }));
  // Orchestrator config with returnMode
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig & { returnMode?: string } | null>(null);
  const [orchestratorError, setOrchestratorError] = useState<string | null>(null);
  const [orchestratorSaving, setOrchestratorSaving] = useState(false);
  // AI channels + usage
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [aiDataLoading, setAiDataLoading] = useState(false);
  const [aiDataError, setAiDataError] = useState<string | null>(null);
  const [aiBusyChannelId, setAiBusyChannelId] = useState<string | null>(null);
  // Add channel dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelForm, setChannelForm] = useState<ChannelForm>({
    id: '',
    provider: 'openai',
    model: 'gpt-4o-mini',
    keySourceType: 'env',
    keySourceValue: 'OPENAI_API_KEY',
    keyRotation: 'polling',
    weight: 1
  });
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
        const [configResult, orchestratorResult] = await Promise.all([
          apiClient.getConfig(),
          apiClient.getOrchestratorConfig()
        ]);
        if (configResult.ok) {
          const config = configResult.data;
          const sbx: any = (config as any)?.sandbox || {};
          setGatewaySandbox({
            profile: sbx.profile === 'dev' || sbx.profile === 'locked-down' || sbx.profile === 'default' ? sbx.profile : 'default',
            requiredForUntrusted: Boolean(sbx?.container?.requiredForUntrusted),
            preferContainer: Boolean(sbx?.container?.prefer)
          });
          setSettings({
            server: { port: config.port || 19233, host: config.host || '127.0.0.1' },
            logLevel: config.logLevel || 'info'
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
              returnMode: (cfg as any).returnMode || 'simple'
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
      const direct = await apiClient.request<any>(`/api/ai/channels/${encodeURIComponent(channelId)}/test`, { method: 'POST' });
      if (direct.ok) {
        success('Channel test OK');
        return;
      }
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

  const addChannel = async () => {
    if (!channelForm.id.trim()) {
      showError('Validation Error', 'Channel ID is required');
      return;
    }
    setAddingChannel(true);
    try {
      const payload = {
        id: channelForm.id.trim(),
        provider: channelForm.provider,
        model: channelForm.model,
        keySource: {
          type: channelForm.keySourceType,
          value: channelForm.keySourceValue,
          format: 'single'
        },
        keyRotation: channelForm.keyRotation,
        weight: channelForm.weight,
        enabled: true,
        ...(channelForm.baseUrl ? { baseUrl: channelForm.baseUrl } : {})
      };
      const res = await apiClient.request('/api/ai/channels', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        success('Channel added');
        setAddDialogOpen(false);
        setChannelForm({ id: '', provider: 'openai', model: 'gpt-4o-mini', keySourceType: 'env', keySourceValue: 'OPENAI_API_KEY', keyRotation: 'polling', weight: 1 });
        await refreshAiData();
      } else {
        showError('Failed to add channel', res.error || 'Unknown error');
      }
    } catch (e) {
      showError('Failed to add channel', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setAddingChannel(false);
    }
  };

  const deleteChannel = async (channelId: string) => {
    if (!confirm(`Delete channel "${channelId}"?`)) return;
    setAiBusyChannelId(channelId);
    try {
      const res = await apiClient.request(`/api/ai/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
      if (res.ok) {
        success('Channel deleted');
        await refreshAiData();
      } else {
        showError('Failed to delete channel', res.error || 'Unknown error');
      }
    } catch (e) {
      showError('Failed to delete channel', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setAiBusyChannelId(null);
    }
  };

  const handleOrchestratorToggle = (value: boolean) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, enabled: value } : { enabled: value, mode: 'manager-only', subagentsDir: './config/subagents', returnMode: 'simple' });
  };

  const handleOrchestratorMode = (value: string) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, mode: value as OrchestratorConfig['mode'] } : { enabled: false, mode: value as OrchestratorConfig['mode'], subagentsDir: './config/subagents', returnMode: 'simple' });
  };

  const handleReturnMode = (value: string) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, returnMode: value } : null);
  };

  const handleOrchestratorDir = (value: string) => {
    setOrchestratorConfig((prev) => prev ? { ...prev, subagentsDir: value } : { enabled: false, mode: 'manager-only', subagentsDir: value, returnMode: 'simple' });
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

      // Shallow merge on backend; fetch current config to deep-merge nested sandbox settings safely.
      let currentSandbox: any = undefined;
      try {
        const currentRes = await apiClient.getConfig();
        if (currentRes.ok) currentSandbox = (currentRes.data as any)?.sandbox;
      } catch { /* ignored */ }

      const nextSandbox = {
        ...(currentSandbox || {}),
        profile: gatewaySandbox.profile,
        container: {
          ...((currentSandbox || {})?.container || {}),
          requiredForUntrusted: gatewaySandbox.requiredForUntrusted,
          prefer: gatewaySandbox.preferContainer
        }
      };

      const configUpdates: any = {
        port: settings.server.port,
        host: settings.server.host,
        logLevel: settings.logLevel,
        sandbox: nextSandbox
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
      server: { port: 19233, host: '127.0.0.1' },
      logLevel: 'info'
    });
    setGatewaySandbox({
      profile: 'default',
      requiredForUntrusted: false,
      preferContainer: false
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
    <div className="space-y-10">
      <SandboxBanner />
      <PageHeader
        title={t('settings.title')}
        description={t('settings.desc')}
        actions={<>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-2 h-8">
            <Save className="h-3.5 w-3.5" /> {saving ? t('settings.saving') : t('settings.save')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReset} disabled={saving} className="gap-2 h-8">
            <RotateCcw className="h-3.5 w-3.5" /> {t('common.reset')}
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

      {/* AI Channels - Table View */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>AI Channels</CardTitle>
              <CardDescription>Configure AI provider channels for routing, load balancing, and failover</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={refreshAiData} disabled={aiDataLoading}>
                <RefreshCw className="h-4 w-4 mr-1" /> Refresh
              </Button>
              <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-1" /> Add Channel
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add AI Channel</DialogTitle>
                    <DialogDescription>Configure a new AI provider channel</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Channel ID</Label>
                        <Input value={channelForm.id} onChange={(e) => setChannelForm({ ...channelForm, id: e.target.value })} placeholder="openai-main" className="mt-1" />
                      </div>
                      <div>
                        <Label>Provider</Label>
                        <Select value={channelForm.provider} onValueChange={(v) => setChannelForm({ ...channelForm, provider: v })}>
                          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                            <SelectItem value="google">Google</SelectItem>
                            <SelectItem value="mistral">Mistral</SelectItem>
                            <SelectItem value="groq">Groq</SelectItem>
                            <SelectItem value="deepseek">DeepSeek</SelectItem>
                            <SelectItem value="ollama">Ollama</SelectItem>
                            <SelectItem value="azure-openai">Azure OpenAI</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label>Model</Label>
                      <Input value={channelForm.model} onChange={(e) => setChannelForm({ ...channelForm, model: e.target.value })} placeholder="gpt-4o-mini" className="mt-1" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Key Source</Label>
                        <Select value={channelForm.keySourceType} onValueChange={(v) => setChannelForm({ ...channelForm, keySourceType: v as 'env' | 'literal' })}>
                          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="env">Environment Variable</SelectItem>
                            <SelectItem value="literal">Direct Value</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>{channelForm.keySourceType === 'env' ? 'Env Var Name' : 'API Key'}</Label>
                        <Input
                          value={channelForm.keySourceValue}
                          onChange={(e) => setChannelForm({ ...channelForm, keySourceValue: e.target.value })}
                          placeholder={channelForm.keySourceType === 'env' ? 'OPENAI_API_KEY' : 'sk-xxx'}
                          className="mt-1"
                          type={channelForm.keySourceType === 'literal' ? 'password' : 'text'}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Key Rotation</Label>
                        <Select value={channelForm.keyRotation} onValueChange={(v) => setChannelForm({ ...channelForm, keyRotation: v as 'polling' | 'random' })}>
                          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="polling">Polling (Round-robin)</SelectItem>
                            <SelectItem value="random">Random</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Weight</Label>
                        <Input type="number" value={channelForm.weight} onChange={(e) => setChannelForm({ ...channelForm, weight: parseInt(e.target.value) || 1 })} min={0} className="mt-1" />
                      </div>
                    </div>
                    <div>
                      <Label>Base URL (optional)</Label>
                      <Input value={channelForm.baseUrl || ''} onChange={(e) => setChannelForm({ ...channelForm, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" className="mt-1" />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
                    <Button onClick={addChannel} disabled={addingChannel}>{addingChannel ? 'Adding...' : 'Add Channel'}</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {aiDataError && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{aiDataError}</p>}

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No channels configured. Click "Add Channel" to create one.
                    </TableCell>
                  </TableRow>
                )}
                {channels.map((ch) => (
                  <TableRow key={ch.channelId}>
                    <TableCell className="font-medium">{ch.channelId}</TableCell>
                    <TableCell>{ch.provider}</TableCell>
                    <TableCell className="font-mono text-sm">{ch.model}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={ch.enabled ? 'default' : 'secondary'}>
                        {ch.enabled ? 'Active' : 'Disabled'}
                      </Badge>
                      {ch.cooldownUntil && <span className="ml-1 text-xs text-muted-foreground">(cooldown)</span>}
                    </TableCell>
                    <TableCell className="text-right">{ch.metrics?.totalRequests ?? 0}</TableCell>
                    <TableCell className="text-right">{ch.metrics?.totalErrors ?? 0}</TableCell>
                    <TableCell className="text-right">{Math.round(ch.metrics?.avgLatencyMs ?? 0)}ms</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={aiBusyChannelId === ch.channelId}
                          onClick={() => testChannel(ch.channelId)}
                          title="Test"
                        >
                          <TestTube className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={aiBusyChannelId === ch.channelId}
                          onClick={() => toggleChannel(ch.channelId, ch.enabled)}
                          title={ch.enabled ? 'Disable' : 'Enable'}
                        >
                          {ch.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={aiBusyChannelId === ch.channelId}
                          onClick={() => deleteChannel(ch.channelId)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

          <div className="space-y-2">
            <Label htmlFor="orch-returnmode">Return Mode</Label>
            <Select value={orchestratorConfig?.returnMode ?? 'simple'} onValueChange={handleReturnMode}>
              <SelectTrigger id="orch-returnmode">
                <SelectValue placeholder="Select return mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Simple (~300b - result only)</SelectItem>
                <SelectItem value="step">Step (~1-2KB - per-step summaries)</SelectItem>
                <SelectItem value="overview">Overview (~500b-1KB - execution summary)</SelectItem>
                <SelectItem value="details">Details (~5-50KB - full debug info)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Controls how much context SubAgents return to the main agent
            </p>
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              <Label>{t('settings.logging.level')}</Label>
              <Select
                value={settings.logLevel}
                onValueChange={(v) => setSettings({ ...settings, logLevel: v })}
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
        <CardContent className="space-y-6">
          {/* Gateway sandbox policy */}
          <div className="space-y-3">
            <div className="text-sm font-medium">{t('settings.sandboxPolicy.title')}</div>
            <p className="text-xs text-muted-foreground">{t('settings.sandboxPolicy.desc')}</p>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('settings.sandboxPolicy.profile')}</Label>
                <Select value={gatewaySandbox.profile} onValueChange={(v) => setGatewaySandbox((prev) => ({ ...prev, profile: v as any }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('settings.sandboxPolicy.profile.default')}</SelectItem>
                    <SelectItem value="dev">{t('settings.sandboxPolicy.profile.dev')}</SelectItem>
                    <SelectItem value="locked-down">{t('settings.sandboxPolicy.profile.lockedDown')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2" />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">{t('settings.sandboxPolicy.quarantine')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.sandboxPolicy.quarantineDesc')}</p>
              </div>
              <Switch
                checked={gatewaySandbox.requiredForUntrusted}
                onCheckedChange={(checked) => setGatewaySandbox((prev) => ({ ...prev, requiredForUntrusted: checked }))}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">{t('settings.sandboxPolicy.prefer')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.sandboxPolicy.preferDesc')}</p>
              </div>
              <Switch
                checked={gatewaySandbox.preferContainer}
                onCheckedChange={(checked) => setGatewaySandbox((prev) => ({ ...prev, preferContainer: checked }))}
              />
            </div>
          </div>

          <div className="h-px bg-border" />

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
