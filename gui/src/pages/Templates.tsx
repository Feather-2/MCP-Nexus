import React, { useState, useEffect } from 'react';
import SandboxBanner from '@/components/SandboxBanner';
import { apiClient, type ServiceTemplate } from '../api/client';
import { useToastHelpers } from '../components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import PageHeader from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
// Note: Using native checkbox in table selection to avoid edge cases
import { Separator } from '@/components/ui/separator';
import {
  Plus,
  RefreshCw,
  FileText,
  Play,
  Settings,
  Edit,
  Trash2,
  Hammer,
  MoreHorizontal
} from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/i18n';

const Templates: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ServiceTemplate | null>(null);
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    description: '',
    transport: 'stdio' as const,
    version: '2024-11-26' as const,
    command: '',
    args: [] as string[]
  });
  const [sandboxEnabled, setSandboxEnabled] = useState<boolean>(true);
  const [sandboxNodeDir, setSandboxNodeDir] = useState<string>('');
  const [sandboxPythonDir, setSandboxPythonDir] = useState<string>('');
  // Container sandbox (optional)
  const [containerEnabled, setContainerEnabled] = useState<boolean>(false);
  const [containerImage, setContainerImage] = useState<string>('');
  const [containerWorkdir, setContainerWorkdir] = useState<string>('');
  const [containerNetwork, setContainerNetwork] = useState<string>('none');
  const [containerReadonly, setContainerReadonly] = useState<boolean>(true);
  const [containerCpus, setContainerCpus] = useState<string>('1');
  const [containerMemory, setContainerMemory] = useState<string>('512m');
  const [containerVolumesText, setContainerVolumesText] = useState<string>('');
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [containerFormErrors, setContainerFormErrors] = useState<{ image?: string; volumes?: string }>(() => ({}));
  // Quick ENV for template
  const [envFixOpen, setEnvFixOpen] = useState(false)
  const [envFixTemplate, setEnvFixTemplate] = useState<ServiceTemplate | null>(null)
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([])
  // Diagnose modal
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagFor, setDiagFor] = useState<ServiceTemplate | null>(null)
  const [diagResult, setDiagResult] = useState<{ required: string[]; provided: string[]; missing: string[]; transport?: string } | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [query, setQuery] = useState('')

  // Native checkbox to avoid Radix controlled edge-cases in table selection
  const TableCheckbox: React.FC<{ checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }> = ({ checked, onChange, ariaLabel }) => (
    <input
      type="checkbox"
      className="h-4 w-4"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
    />
  )

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await apiClient.getTemplates();
      if (result.ok) {
        setTemplates(result.data || []);
      } else {
        setError(result.error || '加载模板失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载模板失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAddTemplate = async () => {
    if (!newTemplate.name || !newTemplate.command) {
      showError('输入验证失败', '请填写模板名称和命令');
      return;
    }
    const errs = validateContainerInputs({ enabled: containerEnabled, image: containerImage, transport: newTemplate.transport, volumesText: containerVolumesText });
    setContainerFormErrors(errs.inline);
    if (errs.messages.length) {
      showError('输入验证失败', errs.messages.join('\n'));
      return;
    }

    try {
      const templateData: any = {
        name: newTemplate.name,
        description: newTemplate.description,
        transport: newTemplate.transport,
        version: newTemplate.version,
        command: newTemplate.command,
        args: newTemplate.args,
        env: sandboxEnabled ? {
          SANDBOX: 'portable',
          ...(sandboxNodeDir ? { SANDBOX_NODE_DIR: sandboxNodeDir } : {}),
          ...(sandboxPythonDir ? { SANDBOX_PYTHON_DIR: sandboxPythonDir } : {})
        } : {}
      };

      if (containerEnabled) {
        templateData.env = { ...(templateData.env || {}), SANDBOX: 'container' };
        const volumes = parseVolumes(containerVolumesText);
        templateData.container = {
          image: containerImage,
          workdir: containerWorkdir || undefined,
          network: containerNetwork || undefined,
          readonlyRootfs: containerReadonly,
          resources: { cpus: containerCpus || undefined, memory: containerMemory || undefined },
          volumes: volumes.length ? volumes : undefined
        };
      }

      const result = await apiClient.addTemplate(templateData as any);

      if (result.ok) {
        success('模板添加成功', `模板 "${newTemplate.name}" 已成功创建`);
        setShowAddModal(false);
        resetNewTemplate();

        // 重新加载模板列表
        await loadTemplates();
      } else {
        showError('添加失败', result.error || '未知错误');
      }
    } catch (err) {
      showError('添加失败', err instanceof Error ? err.message : '网络错误');
    }
  };

  const handleUseTemplate = async (templateName: string) => {
    try {
      const result = await apiClient.createService(templateName);
      if (result.ok) {
        success('服务创建成功', `使用模板 "${templateName}" 创建服务成功`);
      } else {
        showError('创建失败', result.error || '未知错误');
      }
    } catch (err) {
      showError('创建失败', err instanceof Error ? err.message : '网络错误');
    }
  };

  const handleEditTemplate = (template: ServiceTemplate) => {
    // Ensure other dialogs are closed to avoid focus traps
    try { setEnvFixOpen(false); } catch {}
    try { setDiagOpen(false); } catch {}
    setEditingTemplate(template);
    setNewTemplate({
      name: template.name,
      description: template.description || '',
      transport: template.transport as any,
      version: template.version as any,
      command: '', // 需要从后端获取
      args: []
    });
    // 初始化沙盒状态（基于已有 env）
    const env = (template as any).env || {};
    setSandboxEnabled(env.SANDBOX === 'portable');
    setSandboxNodeDir(env.SANDBOX_NODE_DIR || '');
    setSandboxPythonDir(env.SANDBOX_PYTHON_DIR || '');
    // Initialize container block
    const container = (template as any).container || {};
    const isContainer = env.SANDBOX === 'container' || !!container.image;
    setContainerEnabled(isContainer);
    setContainerImage(container.image || '');
    setContainerWorkdir(container.workdir || '');
    setContainerNetwork(container.network || 'none');
    setContainerReadonly(Boolean(container.readonlyRootfs ?? true));
    setContainerCpus(String(container.resources?.cpus || '1'));
    setContainerMemory(String(container.resources?.memory || '512m'));
    const volumesText = Array.isArray(container.volumes) ? container.volumes.map((v: any) => `${v.hostPath}:${v.containerPath}${v.readOnly ? ':ro' : ''}`).join('\n') : '';
    setContainerVolumesText(volumesText);
    setShowEditModal(true);
  };

  const handleUpdateTemplate = async () => {
    if (!editingTemplate || !newTemplate.name) {
      showError('输入验证失败', '请填写完整信息');
      return;
    }
    if (!newTemplate.command) {
      showError('输入验证失败', `${newTemplate.transport === 'stdio' ? '命令' : '服务 URL'}为必填`);
      return;
    }
    const errs = validateContainerInputs({ enabled: containerEnabled, image: containerImage, transport: newTemplate.transport, volumesText: containerVolumesText });
    setContainerFormErrors(errs.inline);
    if (errs.messages.length) {
      showError('输入验证失败', errs.messages.join('\n'));
      return;
    }

    try {
      // 先删除旧模板
      const deleteResult = await apiClient.deleteTemplate(editingTemplate.name);
      if (!deleteResult.ok) {
        showError('更新失败', `删除原模板失败: ${deleteResult.error}`);
        return;
      }

      // 然后添加新模板
      const templateData: any = {
        name: newTemplate.name,
        description: newTemplate.description,
        transport: newTemplate.transport,
        version: newTemplate.version,
        command: newTemplate.command,
        args: newTemplate.args || [],
        env: sandboxEnabled ? {
          SANDBOX: 'portable',
          ...(sandboxNodeDir ? { SANDBOX_NODE_DIR: sandboxNodeDir } : {}),
          ...(sandboxPythonDir ? { SANDBOX_PYTHON_DIR: sandboxPythonDir } : {})
        } : ((editingTemplate as any).env || {})
      };

      if (containerEnabled) {
        templateData.env = { ...(templateData.env || {}), SANDBOX: 'container' };
        const volumes = parseVolumes(containerVolumesText);
        templateData.container = {
          image: containerImage,
          workdir: containerWorkdir || undefined,
          network: containerNetwork || undefined,
          readonlyRootfs: containerReadonly,
          resources: { cpus: containerCpus || undefined, memory: containerMemory || undefined },
          volumes: volumes.length ? volumes : undefined
        };
      }

      const result = await apiClient.addTemplate(templateData as any);

      if (result.ok) {
        success('模板更新成功', `模板 "${newTemplate.name}" 已成功更新`);
        setShowEditModal(false);
        setEditingTemplate(null);
        resetNewTemplate();
        await loadTemplates();
      } else {
        showError('更新失败', result.error || '未知错误');
      }
    } catch (err) {
      showError('更新失败', err instanceof Error ? err.message : '网络错误');
    }
  };

  const handleDeleteTemplate = async (templateName: string) => {
    if (!confirm(`确定要删除模板 "${templateName}" 吗？此操作无法撤销。`)) {
      return;
    }

    try {
      const result = await apiClient.deleteTemplate(templateName);
      if (result.ok) {
        success('模板删除成功', `模板 "${templateName}" 已成功删除`);
        await loadTemplates();
      } else {
        showError('删除失败', result.error || '未知错误');
      }
    } catch (err) {
      showError('删除失败', err instanceof Error ? err.message : '网络错误');
    }
  };

  // ---------- Template ENV helpers ----------
  function requiredEnvForTemplate(tpl: ServiceTemplate): string[] {
    const name = (tpl.name || '').toLowerCase()
    const argsStr = Array.isArray((tpl as any).args) ? ((tpl as any).args as string[]).join(' ').toLowerCase() : ''
    if (name.includes('brave')) return ['BRAVE_API_KEY']
    if (name.includes('github')) return ['GITHUB_TOKEN']
    if (name.includes('openai') || argsStr.includes('openai')) return ['OPENAI_API_KEY']
    if (name.includes('azure-openai') || argsStr.includes('azure-openai')) return ['AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT']
    if (name.includes('anthropic') || argsStr.includes('anthropic')) return ['ANTHROPIC_API_KEY']
    if (name.includes('ollama') || argsStr.includes('ollama')) return []
    if (argsStr.includes('@modelcontextprotocol/server-brave-search')) return ['BRAVE_API_KEY']
    if (argsStr.includes('@modelcontextprotocol/server-github')) return ['GITHUB_TOKEN']
    if (argsStr.includes('@modelcontextprotocol/server-openai')) return ['OPENAI_API_KEY']
    if (argsStr.includes('@modelcontextprotocol/server-anthropic')) return ['ANTHROPIC_API_KEY']
    // Extended common providers
    if (name.includes('gemini') || name.includes('google') || argsStr.includes('gemini') || argsStr.includes('google-genai') || argsStr.includes('@modelcontextprotocol/server-google') || argsStr.includes('@modelcontextprotocol/server-gemini')) return ['GOOGLE_API_KEY']
    if (name.includes('cohere') || argsStr.includes('cohere') || argsStr.includes('@modelcontextprotocol/server-cohere')) return ['COHERE_API_KEY']
    if (name.includes('groq') || argsStr.includes('groq') || argsStr.includes('@modelcontextprotocol/server-groq')) return ['GROQ_API_KEY']
    if (name.includes('openrouter') || argsStr.includes('openrouter') || argsStr.includes('@modelcontextprotocol/server-openrouter')) return ['OPENROUTER_API_KEY']
    if (name.includes('together') || argsStr.includes('together') || argsStr.includes('@modelcontextprotocol/server-together')) return ['TOGETHER_API_KEY']
    if (name.includes('fireworks') || argsStr.includes('fireworks') || argsStr.includes('@modelcontextprotocol/server-fireworks')) return ['FIREWORKS_API_KEY']
    if (name.includes('deepseek') || argsStr.includes('deepseek') || argsStr.includes('@modelcontextprotocol/server-deepseek')) return ['DEEPSEEK_API_KEY']
    if (name.includes('mistral') || argsStr.includes('mistral') || argsStr.includes('@modelcontextprotocol/server-mistral')) return ['MISTRAL_API_KEY']
    if (name.includes('perplexity') || argsStr.includes('perplexity') || argsStr.includes('@modelcontextprotocol/server-perplexity')) return ['PERPLEXITY_API_KEY']
    if (name.includes('replicate') || argsStr.includes('replicate') || argsStr.includes('@modelcontextprotocol/server-replicate')) return ['REPLICATE_API_TOKEN']
    if (name.includes('serpapi') || argsStr.includes('serpapi') || argsStr.includes('@modelcontextprotocol/server-serpapi')) return ['SERPAPI_API_KEY']
    if (name.includes('huggingface') || name.includes('hugging-face') || argsStr.includes('huggingface') || argsStr.includes('@modelcontextprotocol/server-huggingface')) return ['HF_TOKEN']
    return []
  }

  function getMissingEnvKeysTemplate(tpl: ServiceTemplate): string[] {
    const req = requiredEnvForTemplate(tpl)
    const provided = Object.keys(((tpl as any).env || {}) as Record<string, string>)
    return req.filter(k => !provided.includes(k))
  }

  function openTplEnvFix(tpl: ServiceTemplate) {
    const missing = getMissingEnvKeysTemplate(tpl)
    const entries: Array<{ key: string; value: string }> = []
    if (missing.length) missing.forEach(k => entries.push({ key: k, value: '' }))
    else entries.push({ key: '', value: '' })
    setEnvEntries(entries)
    setEnvFixTemplate(tpl)
    setEnvFixOpen(true)
  }

  function openTplEnvFixWith(tpl: ServiceTemplate, keys: string[]) {
    const entries: Array<{ key: string; value: string }> = []
    if (keys && keys.length) keys.forEach(k => entries.push({ key: k, value: '' }))
    else entries.push({ key: '', value: '' })
    setEnvEntries(entries)
    setEnvFixTemplate(tpl)
    setEnvFixOpen(true)
  }

  async function diagnoseTemplate(tpl: ServiceTemplate) {
    try {
      setDiagLoading(true)
      setDiagFor(tpl)
      setDiagOpen(true)
      const res = await apiClient.diagnoseTemplate(tpl.name)
      if (!res.ok) {
        // Soft-fail: keep dialog open with message, avoid blocking focus
        setDiagResult({ required: [], provided: [], missing: [], transport: tpl.transport })
        showError('诊断失败', res.error || '无法获取诊断结果')
      } else {
        const data = res.data as any
        setDiagResult({ required: data.required || [], provided: data.provided || [], missing: data.missing || [], transport: data.transport })
      }
    } catch (e) {
      showError('诊断失败', e instanceof Error ? e.message : '网络错误')
    } finally {
      setDiagLoading(false)
    }
  }

  function updateEnvEntry(idx: number, field: 'key'|'value', v: string) {
    setEnvEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: v } : e))
  }

  function addEnvRow() { setEnvEntries(prev => [...prev, { key: '', value: '' }]) }
  function removeEnvRow(i: number) { setEnvEntries(prev => prev.filter((_, idx) => idx !== i)) }

  async function saveTplEnvFix() {
    if (!envFixTemplate) return
    try {
      // Merge env and call env-only API
      const full = (templates.find(t => t.name === envFixTemplate.name) as any) || (envFixTemplate as any)
      const currentEnv = ((full?.env || {}) as Record<string, string>)
      const patch: Record<string, string> = { ...currentEnv }
      for (const { key, value } of envEntries) {
        const k = (key || '').trim(); if (!k) continue; patch[k] = value ?? ''
      }
      const add = await apiClient.updateTemplateEnv(envFixTemplate.name, patch)
      if (!add.ok) { showError('保存失败', add.error || '更新模板环境变量失败'); return }
      success('模板环境变量已更新', envFixTemplate.name)
      setEnvFixOpen(false); setEnvFixTemplate(null); setEnvEntries([])
      await loadTemplates()
    } catch (e) {
      showError('保存失败', e instanceof Error ? e.message : '网络错误')
    }
  }

  const resetNewTemplate = () => {
    setNewTemplate({
      name: '',
      description: '',
      transport: 'stdio',
      version: '2024-11-26',
      command: '',
      args: []
    });
  };

  // toggle handled inline to improve stability with Radix Checkbox

  const selectAllTemplates = () => {
    if (selectedTemplates.size === templates.length) {
      setSelectedTemplates(new Set());
    } else {
      setSelectedTemplates(new Set(templates.map(t => t.name)));
    }
  };

  const batchDeleteTemplates = async () => {
    if (selectedTemplates.size === 0) {
      showError('未选择模板', '请先选择要删除的模板');
      return;
    }

    if (!confirm(`确定要删除选中的 ${selectedTemplates.size} 个模板吗？此操作无法撤销。`)) {
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const templateName of selectedTemplates) {
      try {
        const result = await apiClient.deleteTemplate(templateName);
        if (result.ok) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (err) {
        errorCount++;
      }
    }

    if (errorCount === 0) {
      success('批量删除成功', `成功删除 ${successCount} 个模板`);
    } else if (successCount === 0) {
      showError('批量删除失败', `${errorCount} 个模板删除失败`);
    } else {
      showError('部分删除失败', `成功删除 ${successCount} 个，失败 ${errorCount} 个`);
    }

    setSelectedTemplates(new Set());
    await loadTemplates();
  };

  // 一键切换为容器模式（预填镜像）
  const suggestDefaultImage = (tpl: any): string => {
    const cmd = (tpl?.command || '').toLowerCase();
    if (cmd.includes('npm') || cmd.includes('node')) return 'node:20-alpine';
    if (cmd.includes('python')) return 'python:3.11-alpine';
    if (cmd.includes('go')) return 'golang:1.22-alpine';
    return 'alpine:3';
  };

  const isContainerTpl = (tpl: any): boolean => {
    const env = tpl?.env || {};
    return env.SANDBOX === 'container' || !!tpl?.container;
  };

  const isContainerImageMissing = (tpl: any): boolean => {
    if (!isContainerTpl(tpl)) return false;
    return !tpl?.container || !tpl?.container?.image;
  };

  const switchToContainer = async (tpl: any) => {
    try {
      const img = suggestDefaultImage(tpl);
      const updated: any = {
        ...tpl,
        env: { ...(tpl.env || {}), SANDBOX: 'container' },
        container: {
          image: img,
          readonlyRootfs: true
        }
      };

      // 先删除旧模板，再以同名覆盖
      const del = await apiClient.deleteTemplate(tpl.name);
      if (!del.ok) {
        showError('切换失败', del.error || '删除旧模板失败');
        return;
      }
      const add = await apiClient.addTemplate(updated);
      if (!add.ok) {
        showError('切换失败', add.error || '写入新模板失败');
        return;
      }
      success('已切换为容器模式', `镜像：${img}`);
      await loadTemplates();
    } catch (err) {
      showError('切换失败', err instanceof Error ? err.message : '未知错误');
    }
  };

  const switchToPortable = async (tpl: any) => {
    try {
      const updated: any = { ...tpl };
      // remove container mode
      updated.env = { ...(tpl.env || {}) };
      if (updated.env.SANDBOX === 'container') delete updated.env.SANDBOX;
      if (Object.keys(updated.env).length === 0) delete updated.env;
      if (updated.container) delete updated.container;

      const del = await apiClient.deleteTemplate(tpl.name);
      if (!del.ok) { showError('切换失败', del.error || '删除旧模板失败'); return; }
      const add = await apiClient.addTemplate(updated);
      if (!add.ok) { showError('切换失败', add.error || '写入新模板失败'); return; }
      success('已切换为便携模式', 'SANDBOX=portable/未设置');
      await loadTemplates();
    } catch (err) {
      showError('切换失败', err instanceof Error ? err.message : '未知错误');
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SandboxBanner />
      <PageHeader
        title={t('tpl.title')}
        description={t('tpl.subtitle')}
        actions={(
          <div className="flex items-center gap-2">
          {/* 批量操作按钮 */}
          {templates.length > 0 && (
            <Button variant="outline" onClick={selectAllTemplates} className="gap-2">
              {t('tpl.selectAll')}
            </Button>
          )}
          <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                {t('tpl.add')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('tpl.addTitle')}</DialogTitle>
                <DialogDescription>
                  {t('tpl.addDesc')}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">{t('tpl.nameLabel')} *</label>
                  <Input
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                    placeholder={t('tpl.namePlaceholder')}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">{t('tpl.descLabel')}</label>
                  <Input
                    value={newTemplate.description}
                    onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                    placeholder={t('tpl.descPlaceholder')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium">{t('tpl.transport')}</label>
                    <Select value={newTemplate.transport} onValueChange={(value) => setNewTemplate({ ...newTemplate, transport: value as any })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">Standard I/O</SelectItem>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">{t('tpl.version')}</label>
                    <Select value={newTemplate.version} onValueChange={(value) => setNewTemplate({ ...newTemplate, version: value as any })}>
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
                </div>
                <div>
                  <label className="text-sm font-medium">
                    {newTemplate.transport === 'stdio' ? `${t('tpl.commandLabel')} *` : `${t('tpl.urlLabel')} *`}
                  </label>
                  <Input
                    value={newTemplate.command}
                    onChange={(e) => setNewTemplate({ ...newTemplate, command: e.target.value })}
                    placeholder={newTemplate.transport === 'stdio' ? '例如: npm exec -y @modelcontextprotocol/server-filesystem' : '例如: https://your-mcp-server/endpoint'}
                  />
                  {(!newTemplate.name || !newTemplate.command) && (
                    <div className="text-xs text-red-500 mt-1">{t('tpl.nameAndCmdRequired')}</div>
                  )}
                </div>
                {/* Sandbox options */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('tpl.sandboxSettings')}</label>
                  <div className="flex items-center gap-3 mb-2">
                    <input id="sbx" type="checkbox" className="h-4 w-4" checked={sandboxEnabled} onChange={(e) => setSandboxEnabled(e.target.checked)} />
                    <label htmlFor="sbx" className="text-sm">{t('tpl.enablePortableSandbox')}</label>
                    {sandboxEnabled && (
                      <Badge variant="secondary" className="ml-2">{t('tpl.sandboxBadge')}</Badge>
                    )}
                  </div>
                  {sandboxEnabled && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm">{t('tpl.nodeDirOpt')}</label>
                        <Input
                          value={sandboxNodeDir}
                          onChange={(e) => setSandboxNodeDir(e.target.value)}
                          placeholder="例如：F:\\pb\\paper-burner\\mcp-sandbox\\runtimes\\nodejs"
                        />
                      </div>
                      <div>
                        <label className="text-sm">{t('tpl.pyDirOpt')}</label>
                        <Input
                          value={sandboxPythonDir}
                          onChange={(e) => setSandboxPythonDir(e.target.value)}
                          placeholder="例如：F:\\pb\\paper-burner\\mcp-sandbox\\runtimes\\python"
                        />
                      </div>
                    </div>
                  )}
                  {/* Container sandbox */}
                  <div className="mt-3">
                    <div className="flex items-center gap-3 mb-2">
                      <input id="ct" type="checkbox" className="h-4 w-4" checked={containerEnabled} onChange={(e) => setContainerEnabled(e.target.checked)} />
                      <label htmlFor="ct" className="text-sm">{t('tpl.container.enable')}</label>
                    </div>
                    {containerEnabled && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm">{t('tpl.container.image')} *</label>
                          <Input value={containerImage} onChange={(e) => setContainerImage(e.target.value)} placeholder="node:20-alpine 或自定义镜像" />
                          {containerFormErrors.image && <div className="text-xs text-red-500 mt-1">{containerFormErrors.image}</div>}
                          {!containerImage && <div className="text-xs text-amber-600 mt-1">容器模式需要填写镜像，否则无法启动</div>}
                        </div>
                        <div>
                          <label className="text-sm">{t('tpl.container.workdir')}</label>
                          <Input value={containerWorkdir} onChange={(e) => setContainerWorkdir(e.target.value)} placeholder="容器内工作目录（可选）" />
                        </div>
                        <div>
                          <label className="text-sm">{t('tpl.container.network')}</label>
                          <Input value={containerNetwork} onChange={(e) => setContainerNetwork(e.target.value)} placeholder="none/bridge/自定义网络" />
                        </div>
                        <div className="flex items-center gap-2 mt-6">
                          <input id="ct-ro" type="checkbox" className="h-4 w-4" checked={containerReadonly} onChange={(e) => setContainerReadonly(e.target.checked)} />
                          <label htmlFor="ct-ro" className="text-sm">{t('tpl.container.readonly')}</label>
                        </div>
                        <div>
                          <label className="text-sm">{t('tpl.container.cpus')}</label>
                          <Input value={containerCpus} onChange={(e) => setContainerCpus(e.target.value)} placeholder="1/2/0.5 等" />
                        </div>
                        <div>
                          <label className="text-sm">{t('tpl.container.memory')}</label>
                          <Input value={containerMemory} onChange={(e) => setContainerMemory(e.target.value)} placeholder="512m/1g 等" />
                        </div>
                        <div className="md:col-span-2">
                          <label className="text-sm">{t('tpl.container.volumes')}</label>
                          <textarea className="w-full min-h-20 p-2 rounded border text-xs font-mono" placeholder={t('tpl.container.volumesPh') || ''} value={containerVolumesText} onChange={(e) => setContainerVolumesText(e.target.value)} />
                          {containerFormErrors.volumes && <div className="text-xs text-red-500 mt-1 whitespace-pre-wrap">{containerFormErrors.volumes}</div>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => {
                    setShowAddModal(false);
                    resetNewTemplate();
                  }}>
                    {t('common.cancel')}
                  </Button>
                  <Button onClick={handleAddTemplate}>
                    {t('tpl.add')}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
            <Button
              variant="secondary"
              onClick={async () => {
                const res = await apiClient.repairTemplateImages();
                if (res.ok) {
                  const data: any = res.data || {};
                  success('已修复容器镜像缺失', `修复 ${data.fixed || 0} 个模板`);
                  await loadTemplates();
                } else {
                  showError('修复失败', res.error || '未知错误');
                }
              }}
              className="gap-2"
            >
              <Hammer className="h-4 w-4" />
              一键修复容器镜像
            </Button>
            <Button variant="secondary" onClick={async () => { await apiClient.repairTemplates(); await loadTemplates(); }} className="gap-2">
              <Hammer className="h-4 w-4" />
              {t('tpl.repairTemplates')}
            </Button>
            <Button variant="outline" onClick={loadTemplates} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              {t('common.refresh')}
            </Button>
          </div>
        )}
      />

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="pt-6">
            <p className="text-red-800 dark:text-red-200">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="rounded-lg border">
            <div className="grid grid-cols-[40px_1fr_220px_160px_200px] gap-2 px-3 py-2 text-[12px] leading-6 text-muted-foreground">
              <div className="flex items-center">
                <TableCheckbox
                  checked={selectedTemplates.size > 0 && selectedTemplates.size === templates.length}
                  onChange={(on) => {
                    setSelectedTemplates(on ? new Set(templates.map(t => t.name)) : new Set());
                  }}
                  ariaLabel="Select all"
                />
              </div>
              <div>{t('tpl.nameLabel')}</div>
              <div>{t('tpl.descLabel')}</div>
              <div>{t('tpl.transport')}</div>
              <div className="text-right">{t('common.actions')}</div>
            </div>
            <div className="px-3 py-2 flex items-center gap-2">
              <Input
                placeholder="搜索模板…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 max-w-[280px]"
              />
            </div>
            <Separator />
            {(templates.filter(t => {
              const q = query.trim().toLowerCase();
              if (!q) return true;
              const hay = `${t.name} ${(t.description||'')}`.toLowerCase();
              return hay.includes(q);
            })).map((tpl) => (
              <div key={tpl.name} className="grid grid-cols-[40px_1fr_220px_160px_200px] gap-2 px-3 py-3 items-center hover:bg-muted/40">
                <div className="flex items-center">
                  <TableCheckbox
                    checked={selectedTemplates.has(tpl.name)}
                    onChange={(on) => {
                      setSelectedTemplates(prev => {
                        const ns = new Set(prev);
                        if (on) ns.add(tpl.name); else ns.delete(tpl.name);
                        return ns;
                      });
                    }}
                    ariaLabel={`Select ${tpl.name}`}
                  />
                </div>
                <div className="truncate flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  {tpl.name}
                </div>
                <div className="truncate text-muted-foreground">{tpl.description || t('tpl.noDesc')}</div>
                <div className="truncate flex items-center gap-1 text-[12px] text-muted-foreground">
                  <Settings className="h-3 w-3" />
                  {tpl.transport}
                  {isContainerTpl(tpl) && (
                    <Badge variant="secondary" className="ml-2 text-indigo-700 bg-indigo-50 border-indigo-200">容器</Badge>
                  )}
                  {isContainerImageMissing(tpl) && (
                    <Badge variant="secondary" className="ml-1 text-amber-700 bg-amber-50 border-amber-200">镜像缺失</Badge>
                  )}
                  {(() => { const miss = getMissingEnvKeysTemplate(tpl); return miss.length ? (
                    <Badge variant="secondary" className="ml-2 text-amber-700 bg-amber-50 border-amber-200">缺少环境变量</Badge>
                  ) : null })()}
                </div>
                <div className="flex items-center justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="px-2">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setTimeout(() => handleUseTemplate(tpl.name), 0)}><Play className="h-3 w-3 mr-2" />{t('tpl.useTemplate')}</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTimeout(() => diagnoseTemplate(tpl), 0)}>诊断</DropdownMenuItem>
                      {(() => { const miss = getMissingEnvKeysTemplate(tpl); return miss.length ? (
                        <DropdownMenuItem onClick={() => setTimeout(() => openTplEnvFix(tpl), 0)}>配置</DropdownMenuItem>
                      ) : null })()}
                      {isContainerTpl(tpl) ? (
                        <DropdownMenuItem onClick={() => setTimeout(() => switchToPortable(tpl), 0)}>切回便携模式</DropdownMenuItem>
                      ) : ((tpl as any)?.transport === 'stdio') ? (
                        <DropdownMenuItem onClick={() => setTimeout(() => switchToContainer(tpl), 0)}>容器模式</DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onClick={() => setTimeout(() => handleEditTemplate(tpl), 0)}><Edit className="h-3 w-3 mr-2" />{t('common.edit')}</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTimeout(() => handleDeleteTemplate(tpl.name), 0)} className="text-red-600"><Trash2 className="h-3 w-3 mr-2" />{t('common.delete')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
            {templates.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">{t('tpl.emptyTitle')}</div>
            )}
      </div>

      <div className="mt-3">
            <Button variant="destructive" disabled={selectedTemplates.size === 0} onClick={batchDeleteTemplates}>
              <Trash2 className="mr-2 size-4" />
              {t('tpl.deleteSelected')}
            </Button>
      </div>

      {templates.length === 0 && !error && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="h-12 w-12 text-slate-400 mb-4" />
            <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2">
              {t('tpl.emptyTitle')}
            </h3>
            <p className="text-slate-600 dark:text-slate-400 text-center mb-4">
              {t('tpl.emptyHint')}
            </p>
            <Button onClick={() => setShowAddModal(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              {t('tpl.add')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Edit Template Dialog */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('tpl.edit')}</DialogTitle>
            <DialogDescription>
              {t('tpl.editing')} "{editingTemplate?.name}" {t('tpl.config')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('tpl.nameLabel')} *</label>
              <Input
                value={newTemplate.name}
                onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                placeholder={t('tpl.namePlaceholder')}
              />
              {!newTemplate.name && (
                <div className="text-xs text-red-500 mt-1">{t('tpl.nameRequired')}</div>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">{t('tpl.descLabel')}</label>
              <Input
                value={newTemplate.description}
                onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                placeholder={t('tpl.descPlaceholder')}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">{t('tpl.transport')}</label>
                <Select value={newTemplate.transport} onValueChange={(value) => setNewTemplate({ ...newTemplate, transport: value as any })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">Standard I/O</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">{t('tpl.version')}</label>
                <Select value={newTemplate.version} onValueChange={(value) => setNewTemplate({ ...newTemplate, version: value as any })}>
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
            </div>
            {/* 编辑对话框中的命令/URL 与沙盒设置，与新增保持一致 */}
            <div>
              <label className="text-sm font-medium">
                {newTemplate.transport === 'stdio' ? `${t('tpl.commandLabel')} *` : `${t('tpl.urlLabel')} *`}
              </label>
              <Input
                value={newTemplate.command}
                onChange={(e) => setNewTemplate({ ...newTemplate, command: e.target.value })}
                placeholder={newTemplate.transport === 'stdio' ? '例如: npm exec -y @modelcontextprotocol/server-filesystem' : '例如: https://your-mcp-server/endpoint'}
              />
              {(!newTemplate.name || !newTemplate.command) && (
                <div className="text-xs text-red-500 mt-1">{t('tpl.nameAndCmdRequired')}</div>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('tpl.sandboxSettings')}</label>
              <div className="flex items-center gap-3 mb-2">
                <input id="sbx-edit" type="checkbox" className="h-4 w-4" checked={sandboxEnabled} onChange={(e) => setSandboxEnabled(e.target.checked)} />
                <label htmlFor="sbx-edit" className="text-sm">{t('tpl.enablePortableSandbox')}</label>
              </div>
              {sandboxEnabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm">{t('tpl.nodeDirOpt')}</label>
                    <Input
                      value={sandboxNodeDir}
                      onChange={(e) => setSandboxNodeDir(e.target.value)}
                      placeholder="例如：F:\\pb\\paper-burner\\mcp-sandbox\\runtimes\\nodejs"
                    />
                  </div>
                  <div>
                    <label className="text-sm">{t('tpl.pyDirOpt')}</label>
                    <Input
                      value={sandboxPythonDir}
                      onChange={(e) => setSandboxPythonDir(e.target.value)}
                      placeholder="例如：F:\\pb\\paper-burner\\mcp-sandbox\\runtimes\\python"
                    />
                  </div>
                </div>
              )}
              {/* Container sandbox (edit) */}
              <div className="mt-3">
                  <div className="flex items-center gap-3 mb-2">
                    <input id="ct-edit" type="checkbox" className="h-4 w-4" checked={containerEnabled} onChange={(e) => setContainerEnabled(e.target.checked)} />
                    <label htmlFor="ct-edit" className="text-sm">{t('tpl.container.enable')}</label>
                  </div>
                  {containerEnabled && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm">{t('tpl.container.image')} *</label>
                      <Input value={containerImage} onChange={(e) => setContainerImage(e.target.value)} placeholder="node:20-alpine 或自定义镜像" />
                    </div>
                    <div>
                      <label className="text-sm">{t('tpl.container.workdir')}</label>
                      <Input value={containerWorkdir} onChange={(e) => setContainerWorkdir(e.target.value)} placeholder="容器内工作目录（可选）" />
                    </div>
                    <div>
                      <label className="text-sm">{t('tpl.container.network')}</label>
                      <Input value={containerNetwork} onChange={(e) => setContainerNetwork(e.target.value)} placeholder="none/bridge/自定义网络" />
                    </div>
                    <div className="flex items-center gap-2 mt-6">
                      <input id="ct-ro-edit" type="checkbox" className="h-4 w-4" checked={containerReadonly} onChange={(e) => setContainerReadonly(e.target.checked)} />
                      <label htmlFor="ct-ro-edit" className="text-sm">{t('tpl.container.readonly')}</label>
                    </div>
                    <div>
                      <label className="text-sm">{t('tpl.container.cpus')}</label>
                      <Input value={containerCpus} onChange={(e) => setContainerCpus(e.target.value)} placeholder="1/2/0.5 等" />
                    </div>
                    <div>
                      <label className="text-sm">{t('tpl.container.memory')}</label>
                      <Input value={containerMemory} onChange={(e) => setContainerMemory(e.target.value)} placeholder="512m/1g 等" />
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-sm">{t('tpl.container.volumes')}</label>
                      <textarea className="w-full min-h-20 p-2 rounded border text-xs font-mono" placeholder={t('tpl.container.volumesPh') || ''} value={containerVolumesText} onChange={(e) => setContainerVolumesText(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => {
                setShowEditModal(false);
                setEditingTemplate(null);
                resetNewTemplate();
              }}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleUpdateTemplate}>
                {t('tpl.confirmUpdate')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Diagnose Result Dialog */}
      <Dialog open={diagOpen} onOpenChange={(open) => { if (!open) { setDiagOpen(false); setDiagFor(null); setDiagResult(null); setDiagLoading(false); } }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>创建前诊断</DialogTitle>
            <DialogDescription>
              {diagFor ? `模板 "${diagFor.name}" 的环境变量检查` : '环境变量检查'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {diagLoading && (<div className="text-muted-foreground">正在诊断…</div>)}
            {!diagLoading && diagResult && (
              <>
                <div>
                  <div className="font-medium mb-1">必需变量</div>
                  <div className="flex flex-wrap gap-2">{(diagResult.required.length ? diagResult.required : ['(无)']).map((k, i) => (
                    <Badge key={i} variant="secondary">{k}</Badge>
                  ))}</div>
                </div>
                <div>
                  <div className="font-medium mb-1">已提供</div>
                  <div className="flex flex-wrap gap-2">{(diagResult.provided.length ? diagResult.provided : ['(无)']).map((k, i) => (
                    <Badge key={i} variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">{k}</Badge>
                  ))}</div>
                </div>
                <div>
                  <div className="font-medium mb-1">缺失</div>
                  <div className="flex flex-wrap gap-2">{(diagResult.missing.length ? diagResult.missing : ['(无)']).map((k, i) => (
                    <Badge key={i} variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200">{k}</Badge>
                  ))}</div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDiagOpen(false)}>关闭</Button>
                  {!!diagResult.missing?.length && diagFor && (
                    <Button onClick={() => { setDiagOpen(false); openTplEnvFixWith(diagFor, diagResult.missing); }}>一键配置缺失项</Button>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Quick ENV Fix Dialog for template */}
      <Dialog open={envFixOpen} onOpenChange={(open) => { if (!open) { setEnvFixOpen(false); setEnvFixTemplate(null); setEnvEntries([]); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('tpl.edit') || '配置环境变量'}</DialogTitle>
            <DialogDescription>
              {envFixTemplate ? `模板 "${envFixTemplate.name}" 的环境变量` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {envEntries.map((e, idx) => (
              <div key={idx} className="grid grid-cols-2 gap-2 items-center">
                <input className="border rounded px-2 py-1 text-sm" placeholder="KEY" value={e.key} onChange={(ev) => updateEnvEntry(idx, 'key', ev.target.value)} />
                <input className="border rounded px-2 py-1 text-sm" placeholder="VALUE" value={e.value} onChange={(ev) => updateEnvEntry(idx, 'value', ev.target.value)} />
                <div className="col-span-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => removeEnvRow(idx)}>删除</Button>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between mt-2">
              <Button variant="outline" size="sm" onClick={addEnvRow}>{t('common.add') || '新增'}</Button>
              <div className="space-x-2">
                <Button variant="outline" size="sm" onClick={() => { setEnvFixOpen(false); setEnvFixTemplate(null); setEnvEntries([]); }}>{t('common.cancel')}</Button>
                <Button size="sm" onClick={saveTplEnvFix}>{t('common.save')}</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default Templates;

// Quick ENV Fix Dialog for template
// Placed after default export for clarity; real UI rendered above using Dialog from shadcn

// Robust volume spec parsing supporting Windows drive letters
function parseVolumes(text: string): Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> {
  const lines = (text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> = [];
  for (const l of lines) {
    let hostPath = '';
    let rest = '';
    // Heuristic: Windows drive path like C:\... starts with letter + ':'
    if (/^[A-Za-z]:\\/.test(l) || /^[A-Za-z]:\//.test(l)) {
      const idx = l.indexOf(':', 2); // first colon after drive letter
      if (idx === -1) continue;
      hostPath = l.slice(0, idx);
      rest = l.slice(idx + 1);
    } else {
      const idx = l.indexOf(':');
      if (idx === -1) continue;
      hostPath = l.slice(0, idx);
      rest = l.slice(idx + 1);
    }
    let readOnly = false;
    let containerPath = rest;
    if (/:ro$/i.test(rest)) {
      readOnly = true;
      containerPath = rest.replace(/:ro$/i, '');
    } else if (/:rw$/i.test(rest)) {
      readOnly = false;
      containerPath = rest.replace(/:rw$/i, '');
    }
    hostPath = hostPath.trim();
    containerPath = containerPath.trim();
    if (!hostPath || !containerPath) continue;
    out.push({ hostPath, containerPath, readOnly });
  }
  return out;
}

function validateContainerInputs(opts: { enabled: boolean; image: string; transport: string; volumesText: string }): { messages: string[]; inline: { image?: string; volumes?: string } } {
  const messages: string[] = [];
  const inline: { image?: string; volumes?: string } = {};
  if (!opts.enabled) return { messages, inline };
  if (!opts.image || !opts.image.trim()) {
    inline.image = '容器镜像为必填';
    messages.push('容器镜像为必填');
  }
  if (opts.transport !== 'stdio') {
    messages.push('容器模式仅支持 stdio 传输');
  }
  const vols = parseVolumes(opts.volumesText);
  if (opts.volumesText.trim() && vols.length === 0) {
    inline.volumes = '卷格式无效，请按示例填写：C:\\data\\logs:/app/logs[:ro]';
    messages.push('卷格式无效');
  }
  return { messages, inline };
}
