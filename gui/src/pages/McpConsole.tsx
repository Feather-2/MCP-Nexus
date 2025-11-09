import React, { useEffect, useMemo, useState } from 'react';
import { apiClient, type ServiceInstance } from '../api/client';
import { useToastHelpers } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import PageHeader from '@/components/PageHeader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import RightPanel from '@/components/RightPanel';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Terminal, Send, RefreshCw, Wand2, Edit2 } from 'lucide-react';

const DEFAULT_METHODS = [
  { key: 'initialize', label: 'initialize', build: () => apiClient.buildInitializeMessage() },
  { key: 'tools/list', label: 'tools/list', build: () => apiClient.buildSimpleMethod('tools/list') },
  { key: 'resources/list', label: 'resources/list', build: () => apiClient.buildSimpleMethod('resources/list') },
  { key: 'prompts/list', label: 'prompts/list', build: () => apiClient.buildSimpleMethod('prompts/list') },
];

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

const McpConsole: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  const [services, setServices] = useState<ServiceInstance[]>([]);
  const [selectedService, setSelectedService] = useState<string>('');
  const [method, setMethod] = useState<string>('initialize');
  const [requestJson, setRequestJson] = useState<string>('');
  const [responseJson, setResponseJson] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [toolName, setToolName] = useState<string>('');
  const [toolArgs, setToolArgs] = useState<string>('{}');
  const [resourceUri, setResourceUri] = useState<string>('');
  type HistoryItem = { id: string; ts: number; serviceId: string; request: string; response: string; favorite?: boolean };
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem('mcp_console_history') || '[]';
      return JSON.parse(raw);
    } catch { return []; }
  });
  const [historyServiceFilter, setHistoryServiceFilter] = useState<string>('all');
  const [historyKeyword, setHistoryKeyword] = useState<string>('');
  const [onlyFavorites, setOnlyFavorites] = useState<boolean>(false);
  const [openSettings, setOpenSettings] = useState<boolean>(false);

  // Smart tool form state
  const [availableTools, setAvailableTools] = useState<McpTool[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [toolFormData, setToolFormData] = useState<Record<string, any>>({});
  const [isSmartMode, setIsSmartMode] = useState<boolean>(false);
  const [editingEnv, setEditingEnv] = useState<boolean>(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  const preset = useMemo(() => DEFAULT_METHODS.find(m => m.key === method), [method]);

  const loadServices = async () => {
    try {
      const result = await apiClient.getServices();
      if (result.ok) {
        setServices(result.data || []);
        if (!selectedService && (result.data || []).length > 0) {
          setSelectedService((result.data || [])[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadServices();
  }, []);

  useEffect(() => {
    if (preset) {
      try {
        setRequestJson(JSON.stringify(preset.build(), null, 2));
      } catch {
        // ignore
      }
    }
  }, [preset]);

  const sendRequest = async () => {
    if (!selectedService) {
      showError(t('console.sendFail'), t('console.selectServiceFirst'));
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(requestJson || '{}');
    } catch (err) {
      showError(t('console.jsonParseFail'), t('console.jsonCheck'));
      return;
    }
    setLoading(true);
    setResponseJson('');
    try {
      const result = await apiClient.proxyMcp(selectedService, payload);
      if (result.ok) {
        setResponseJson(JSON.stringify(result.data, null, 2));
        success(t('console.requestSuccess'));
        // persist history
        const entry: HistoryItem = { id: `h-${Date.now()}`, ts: Date.now(), serviceId: selectedService, request: JSON.stringify(payload, null, 2), response: JSON.stringify(result.data, null, 2) };
        const next = [...history, entry].slice(-20);
        setHistory(next);
        localStorage.setItem('mcp_console_history', JSON.stringify(next));
      } else {
        setResponseJson(JSON.stringify({ error: result.error }, null, 2));
        showError(t('console.requestFail'), result.error || t('common.unknownError'));
        const entry: HistoryItem = { id: `h-${Date.now()}`, ts: Date.now(), serviceId: selectedService, request: JSON.stringify(payload, null, 2), response: JSON.stringify({ error: result.error }, null, 2) };
        const next = [...history, entry].slice(-20);
        setHistory(next);
        localStorage.setItem('mcp_console_history', JSON.stringify(next));
      }
    } catch (err) {
      setResponseJson(JSON.stringify({ error: err instanceof Error ? err.message : '网络错误' }, null, 2));
      showError(t('console.requestFail'), err instanceof Error ? err.message : t('common.networkError'));
      const entry: HistoryItem = { id: `h-${Date.now()}`, ts: Date.now(), serviceId: selectedService, request: JSON.stringify(payload, null, 2), response: JSON.stringify({ error: err instanceof Error ? err.message : '网络错误' }, null, 2) };
      const next = [...history, entry].slice(-20);
      setHistory(next);
      localStorage.setItem('mcp_console_history', JSON.stringify(next));
    } finally {
      setLoading(false);
    }
  };

  const buildAndSendToolsCall = async () => {
    if (!toolName) {
      showError(t('console.sendFail'), t('console.enterToolName'));
      return;
    }
    let argsObj: any = {};
    try { argsObj = toolArgs ? JSON.parse(toolArgs) : {}; } catch {
      showError(t('console.parseFail'), t('console.toolArgsJson'));
      return;
    }
    const msg = apiClient.buildSimpleMethod('tools/call', { name: toolName, arguments: argsObj });
    setRequestJson(JSON.stringify(msg, null, 2));
    await sendRequest();
  };

  const buildAndSendResourceRead = async () => {
    if (!resourceUri) {
      showError(t('console.sendFail'), t('console.enterResourceUri'));
      return;
    }
    const msg = apiClient.buildSimpleMethod('resources/read', { uri: resourceUri });
    setRequestJson(JSON.stringify(msg, null, 2));
    await sendRequest();
  };

  // Fetch available tools when service or smart mode changes
  useEffect(() => {
    if (isSmartMode && selectedService) {
      const fetchTools = async () => {
        try {
          const msg = apiClient.buildSimpleMethod('tools/list');
          const result = await apiClient.proxyMcp(selectedService, msg);
          if (result.ok && result.data?.result?.tools) {
            setAvailableTools(result.data.result.tools);
          }
        } catch (err) {
          console.error('Failed to fetch tools:', err);
        }
      };
      fetchTools();
    }
  }, [isSmartMode, selectedService]);

  // Build tool form from selected tool schema
  const buildToolForm = (tool: McpTool) => {
    const schema = tool.inputSchema;
    if (!schema || !schema.properties) return null;

    const required = schema.required || [];
    const properties = schema.properties;

    return Object.entries(properties).map(([key, prop]: [string, any]) => {
      const isRequired = required.includes(key);
      const value = toolFormData[key] || '';

      return (
        <div key={key} className="space-y-1">
          <Label htmlFor={`field-${key}`} className="text-sm font-medium">
            {key} {isRequired && <Badge variant="destructive" className="ml-1 text-xs">{t('console.required')}</Badge>}
          </Label>
          {prop.description && <p className="text-xs text-slate-500">{prop.description}</p>}

          {prop.type === 'boolean' ? (
            <Select
              value={value === true ? "true" : value === false ? "false" : ""}
              onValueChange={(v) => setToolFormData({ ...toolFormData, [key]: v === 'true' })}
            >
              <SelectTrigger id={`field-${key}`}>
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">true</SelectItem>
                <SelectItem value="false">false</SelectItem>
              </SelectContent>
            </Select>
          ) : prop.enum ? (
            <Select
              value={value}
              onValueChange={(v) => setToolFormData({ ...toolFormData, [key]: v })}
            >
              <SelectTrigger id={`field-${key}`}>
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {prop.enum.map((v: string) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : prop.type === 'number' || prop.type === 'integer' ? (
            <Input
              id={`field-${key}`}
              type="number"
              placeholder={prop.default !== undefined ? `Default: ${prop.default}` : ''}
              value={value}
              onChange={(e) => setToolFormData({ ...toolFormData, [key]: parseFloat(e.target.value) || '' })}
            />
          ) : prop.type === 'array' || prop.type === 'object' ? (
            <Textarea
              id={`field-${key}`}
              className="min-h-20 font-mono text-xs"
              placeholder={`JSON ${prop.type}`}
              value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  setToolFormData({ ...toolFormData, [key]: parsed });
                } catch {
                  setToolFormData({ ...toolFormData, [key]: e.target.value });
                }
              }}
            />
          ) : (
            <Input
              id={`field-${key}`}
              type="text"
              placeholder={prop.default !== undefined ? `Default: ${prop.default}` : ''}
              value={value}
              onChange={(e) => setToolFormData({ ...toolFormData, [key]: e.target.value })}
            />
          )}
        </div>
      );
    });
  };

  const sendSmartToolCall = async () => {
    const tool = availableTools.find(t => t.name === selectedTool);
    if (!tool) {
      showError(t('console.sendFail'), t('console.pleaseSelectTool'));
      return;
    }

    // Validate required fields
    const required = tool.inputSchema?.required || [];
    for (const field of required) {
      if (!toolFormData[field]) {
        showError(t('console.sendFail'), `${t('console.missingRequiredField')}: ${field}`);
        return;
      }
    }

    const msg = apiClient.buildSimpleMethod('tools/call', {
      name: selectedTool,
      arguments: toolFormData
    });
    setRequestJson(JSON.stringify(msg, null, 2));
    setLoading(true);
    setResponseJson('');
    try {
      const result = await apiClient.proxyMcp(selectedService, msg);
      if (result.ok) {
        setResponseJson(JSON.stringify(result.data, null, 2));
        success(t('console.requestSuccess'));
        const entry: HistoryItem = {
          id: `h-${Date.now()}`,
          ts: Date.now(),
          serviceId: selectedService,
          request: JSON.stringify(msg, null, 2),
          response: JSON.stringify(result.data, null, 2)
        };
        const next = [...history, entry].slice(-20);
        setHistory(next);
        localStorage.setItem('mcp_console_history', JSON.stringify(next));
      } else {
        setResponseJson(JSON.stringify({ error: result.error }, null, 2));
        showError(t('console.requestFail'), result.error || t('common.unknownError'));
      }
    } catch (err) {
      setResponseJson(JSON.stringify({ error: err instanceof Error ? err.message : '网络错误' }, null, 2));
      showError(t('console.requestFail'), err instanceof Error ? err.message : t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  const saveEnvVariables = async () => {
    if (!selectedService) return;

    try {
      setLoading(true);
      const result = await apiClient.updateServiceEnv(selectedService, envValues);

      if (result.ok) {
        success(t('console.envUpdateSuccess'));
        setEditingEnv(false);
        // Update local service list
        await loadServices();
        // Reset selected service to the new service ID
        if (result.data?.serviceId) {
          setSelectedService(result.data.serviceId);
        }
      } else {
        showError(t('console.envUpdateFail'), result.error || t('common.unknownError'));
      }
    } catch (err) {
      showError(t('console.envUpdateFail'), err instanceof Error ? err.message : t('common.networkError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('console.title')}
        description={t('console.desc')}
        icon={<Terminal className="h-6 w-6 text-primary" />}
        actions={<>
          <Button variant="outline" className="gap-2" onClick={loadServices}><RefreshCw className="h-4 w-4" /> {t('console.refreshInstances')}</Button>
          <Button variant="outline" className="gap-2" onClick={() => setOpenSettings(true)}>{t('console.settings')}</Button>
        </>}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('console.targetPreset')}</CardTitle>
          <CardDescription>{t('console.targetPresetDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">{t('console.serviceInstance')}</Label>
              <Select value={selectedService} onValueChange={setSelectedService}>
                <SelectTrigger>
                  <SelectValue placeholder={t('console.selectServicePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {services.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.config.name} <span className="text-xs text-slate-500">({s.id.slice(0,8)})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">{t('console.methodPreset')}</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_METHODS.map(m => (
                    <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={sendRequest} disabled={loading || !selectedService} className="gap-2">
                <Send className="h-4 w-4" /> {t('console.sendRequest')}
              </Button>
            </div>
            <div className="flex items-end">
              <Button
                variant={isSmartMode ? 'default' : 'outline'}
                onClick={() => {
                  setIsSmartMode(!isSmartMode);
                  if (!isSmartMode) {
                    setToolFormData({});
                    setSelectedTool('');
                  }
                }}
                className="gap-2"
              >
                <Wand2 className="h-4 w-4" /> {t('console.smartMode')}
              </Button>
            </div>
          </div>

          {isSmartMode && selectedService && (
            <Card className="border-primary/20 bg-primary/5">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wand2 className="h-4 w-4" /> {t('console.smartTool')}
                </CardTitle>
                <CardDescription>{t('console.smartToolDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Service info hint */}
                {(() => {
                  const service = services.find(s => s.id === selectedService);
                  if (service) {
                    const hasEnv = service.config.env && Object.keys(service.config.env).length > 0;
                    const missingEnv = hasEnv && Object.values(service.config.env!).some(v => !v);

                    return (
                      <div className={`p-3 border rounded-md text-sm ${
                        missingEnv
                          ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                          : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
                      }`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <div className={`font-medium mb-1 ${
                              missingEnv
                                ? 'text-amber-900 dark:text-amber-100'
                                : 'text-blue-900 dark:text-blue-100'
                            }`}>
                              {hasEnv ? t('console.serviceEnvConfigured') : t('console.noEnvConfigured')}
                            </div>
                            {!editingEnv && hasEnv && (
                              <div className={`text-xs space-y-1 ${
                                missingEnv
                                  ? 'text-amber-700 dark:text-amber-300'
                                  : 'text-blue-700 dark:text-blue-300'
                              }`}>
                                {Object.keys(service.config.env!).map(key => (
                                  <div key={key}>
                                    • {key}: {service.config.env![key] ? '***' : (
                                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                                        {t('console.notSet')}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            {editingEnv && (
                              <div className="mt-2 space-y-2">
                                {Object.keys(service.config.env || {}).map(key => (
                                  <div key={key} className="space-y-1">
                                    <Label htmlFor={`env-${key}`} className="text-xs font-medium">{key}</Label>
                                    <Input
                                      id={`env-${key}`}
                                      type="text"
                                      placeholder={`Enter ${key}`}
                                      value={envValues[key] || service.config.env?.[key] || ''}
                                      onChange={(e) => setEnvValues({ ...envValues, [key]: e.target.value })}
                                      className="h-8 text-xs"
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2 shrink-0">
                            {!editingEnv ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setEnvValues(service.config.env || {});
                                  setEditingEnv(true);
                                }}
                              >
                                <Edit2 className="h-3 w-3 mr-1" />
                                {t('console.editEnv')}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setEditingEnv(false);
                                    setEnvValues({});
                                  }}
                                >
                                  {t('common.cancel')}
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={saveEnvVariables}
                                  disabled={loading}
                                >
                                  {t('common.save')}
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {!editingEnv && missingEnv && (
                          <div className="mt-2 space-y-2">
                            <div className="text-xs text-amber-600 dark:text-amber-400">
                              {t('console.envMissingHint')}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return null;
                })()}

                <div>
                  <Label htmlFor="smart-tool-select">{t('console.selectTool')}</Label>
                  <Select
                    value={selectedTool}
                    onValueChange={(val) => {
                      setSelectedTool(val);
                      setToolFormData({});
                    }}
                  >
                    <SelectTrigger id="smart-tool-select">
                      <SelectValue placeholder={availableTools.length === 0 ? t('console.loadingTools') : t('console.selectToolPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableTools.map(tool => (
                        <SelectItem key={tool.name} value={tool.name}>
                          {tool.name}
                          {tool.description && <span className="text-xs text-slate-500"> - {tool.description.slice(0, 50)}</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedTool && (() => {
                  const tool = availableTools.find(t => t.name === selectedTool);
                  return tool ? (
                    <div className="space-y-3">
                      {tool.description && (
                        <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-md text-sm">
                          {tool.description}
                        </div>
                      )}
                      {buildToolForm(tool)}
                      <Button onClick={sendSmartToolCall} disabled={loading} className="gap-2 w-full">
                        <Send className="h-4 w-4" /> {t('console.callTool')} {tool.name}
                      </Button>
                    </div>
                  ) : null;
                })()}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <RightPanel open={openSettings} onClose={() => setOpenSettings(false)} title={t('console.panelSettingsTitle')}>
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-1">{t('console.editor')}</div>
            <div className="text-sm text-slate-500">{t('console.editorDesc')}</div>
          </div>
          <div>
            <div className="text-sm font-medium mb-1">{t('console.history')}</div>
            <div className="text-sm text-slate-500">{t('console.historyDesc')}</div>
          </div>
        </div>
      </RightPanel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('console.request')}</CardTitle>
            <CardDescription>{t('console.requestDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Quick forms */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div className="space-y-2">
                <Label>tools/call</Label>
                <Input placeholder={t('console.toolNamePlaceholder')} value={toolName} onChange={(e)=>setToolName(e.target.value)} />
                <Textarea className="min-h-20 font-mono text-xs" placeholder='{"query": "..."}' value={toolArgs} onChange={(e)=>setToolArgs(e.target.value)} />
                <Button variant="outline" size="sm" onClick={buildAndSendToolsCall}>{t('console.sendToolsCall')}</Button>
              </div>
              <div className="space-y-2">
                <Label>resources/read</Label>
                <Input placeholder={t('console.resourceUriPlaceholder')} value={resourceUri} onChange={(e)=>setResourceUri(e.target.value)} />
                <div>
                  <Button variant="outline" size="sm" onClick={buildAndSendResourceRead}>{t('console.sendResourcesRead')}</Button>
                </div>
              </div>
            </div>
            <Textarea
              className="h-96 font-mono text-sm"
              value={requestJson}
              onChange={(e) => setRequestJson(e.target.value)}
            />
            <div className="mt-2 text-xs text-slate-500">{t('console.exampleMethods')}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('console.response')}</CardTitle>
            <CardDescription>{t('console.responseDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="w-full h-96 font-mono text-sm p-3 rounded-md border overflow-auto bg-slate-50 dark:bg-slate-900/60 whitespace-pre-wrap">
{responseJson || ''}
            </pre>
          </CardContent>
        </Card>
      </div>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle>{t('console.historyTitle')}</CardTitle>
          <CardDescription>{t('console.historyDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-3 items-end">
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">{t('console.filterByService')}</Label>
              <Select value={historyServiceFilter} onValueChange={setHistoryServiceFilter}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('console.all')}</SelectItem>
                  {Array.from(new Set(history.map(h => h.serviceId))).map(id => (
                    <SelectItem key={id} value={id}>{id.slice(0,8)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">{t('console.keywordSearch')}</Label>
              <Input className="h-8" placeholder={t('console.keywordPlaceholder')} value={historyKeyword} onChange={(e)=>setHistoryKeyword(e.target.value)} />
            </div>
            <div className="flex items-center space-x-2 h-8">
              <Checkbox
                id="only-favorites"
                checked={onlyFavorites}
                onCheckedChange={(checked) => setOnlyFavorites(!!checked)}
              />
              <Label htmlFor="only-favorites" className="text-sm cursor-pointer">
                {t('console.onlyFavorites')}
              </Label>
            </div>
          </div>
          <div className="flex gap-2 mb-3">
            <Button variant="outline" size="sm" onClick={() => {
              const data = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(data);
              const a = document.createElement('a');
              a.href = url; a.download = `mcp-history-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
            }}>{t('common.exportJson')}</Button>
            <Button variant="outline" size="sm" onClick={() => { setHistory([]); localStorage.removeItem('mcp_console_history'); }}>{t('common.clearHistory')}</Button>
          </div>
          {history.length === 0 ? (
            <div className="text-sm text-slate-500">{t('console.noHistory')}</div>
          ) : (
            <div className="space-y-2">
              {history
                .filter(h => historyServiceFilter === 'all' ? true : h.serviceId === historyServiceFilter)
                .filter(h => historyKeyword ? (h.request + h.response).toLowerCase().includes(historyKeyword.toLowerCase()) : true)
                .filter(h => onlyFavorites ? h.favorite : true)
                .slice().reverse().map(h => (
                <div key={h.id} className="p-2 border rounded-md bg-white dark:bg-slate-900/60">
                  <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 mb-1">
                    <div>{t('console.serviceLabel')}: {h.serviceId.slice(0,8)} · {t('console.timeLabel')}: {new Date(h.ts).toLocaleString()}</div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => {
                        const next = history.map(x => x.id === h.id ? { ...x, favorite: !x.favorite } : x);
                        setHistory(next); localStorage.setItem('mcp_console_history', JSON.stringify(next));
                      }}>{h.favorite ? t('console.unfavorite') : t('console.favorite')}</Button>
                      <Button variant="outline" size="sm" onClick={() => { setRequestJson(h.request); setResponseJson(h.response); }}>{t('common.view')}</Button>
                      <Button variant="outline" size="sm" onClick={() => { setRequestJson(h.request); sendRequest(); }}>{t('common.resend')}</Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <pre className="h-28 overflow-auto text-xs bg-slate-50 dark:bg-slate-900/60 p-2 rounded">{h.request}</pre>
                    <pre className="h-28 overflow-auto text-xs bg-slate-50 dark:bg-slate-900/60 p-2 rounded">{h.response}</pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default McpConsole;


