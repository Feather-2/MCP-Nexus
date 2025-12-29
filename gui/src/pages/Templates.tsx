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
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Plus,
  RefreshCw,
  FileText,
  Play,
  Edit,
  Trash2,
  Hammer,
  MoreHorizontal,
  Search,
  Box,
  AlertTriangle
} from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/i18n';

const Templates: React.FC = () => {
  const { t, lang } = useI18n();
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
  const [, setContainerFormErrors] = useState<{ image?: string; volumes?: string }>(() => ({}));
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

  const formatSandboxReason = (reason: string) => {
    const r = String(reason || '');
    if (!r) return r;

    if (r === 'service.security.requireContainer') {
      return lang === 'zh'
        ? '模板要求容器运行（security.requireContainer=true）'
        : 'Template requires container (security.requireContainer=true)';
    }
    if (r === 'sandbox.container.prefer') {
      return lang === 'zh'
        ? '网关偏好对非 trusted 模板使用容器（sandbox.container.prefer=true）'
        : 'Gateway prefers containers for non-trusted templates (sandbox.container.prefer=true)';
    }
    if (r.startsWith('sandbox.profile=')) {
      const profile = r.slice('sandbox.profile='.length) || 'default';
      return lang === 'zh'
        ? `网关安全档位：${profile}`
        : `Gateway security profile: ${profile}`;
    }
    if (r.startsWith('trustLevel=')) {
      const lvl = r.slice('trustLevel='.length) || 'unknown';
      return lang === 'zh'
        ? `模板信任级别：${lvl}`
        : `Template trustLevel: ${lvl}`;
    }
    if (r === 'sandbox.portable.auto') {
      return lang === 'zh'
        ? '自动启用便携沙盒（npm/npx）'
        : 'Auto-enable portable sandbox (npm/npx)';
    }
    if (r.startsWith('sandbox.portable.networkPolicy=')) {
      const np = r.slice('sandbox.portable.networkPolicy='.length) || 'local-only';
      return lang === 'zh'
        ? `便携沙盒网络策略：${np}`
        : `Portable sandbox network policy: ${np}`;
    }
    if (r === 'sandbox.portable.cwd') {
      return lang === 'zh'
        ? '便携沙盒工作目录指向 mcp-sandbox/packages'
        : 'Portable sandbox workingDirectory → mcp-sandbox/packages';
    }

    return r;
  };

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
        security: (editingTemplate as any).security,
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

  const toggleAll = () => {
    if (selectedTemplates.size === templates.length) {
      setSelectedTemplates(new Set());
    } else {
      setSelectedTemplates(new Set(templates.map(t => t.name)));
    }
  };

  const toggleSelected = (name: string) => {
    setSelectedTemplates(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
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

  const isContainerTpl = (tpl: any): boolean => {
    const env = tpl?.env || {};
    return env.SANDBOX === 'container' || !!tpl?.container;
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
        description="管理服务模板，快速创建和部署新的 MCP 服务实例。"
        actions={(
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadTemplates} disabled={loading} className="h-9 gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
                  <Hammer className="h-4 w-4" />
                  维护
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>模板维护</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={async () => { await apiClient.repairTemplates(); await loadTemplates(); }}>
                  重置所有内置模板
                </DropdownMenuItem>
                <DropdownMenuItem onClick={async () => {
                  const res = await apiClient.repairTemplateImages();
                  if (res.ok) {
                    const data: any = res.data || {};
                    success('已修复容器镜像缺失', `修复 ${data.fixed || 0} 个模板`);
                    await loadTemplates();
                  } else {
                    showError('修复失败', res.error || '未知错误');
                  }
                }}>
                  修复容器镜像缺失
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-9 gap-2">
                  <Plus className="h-4 w-4" />
                  {t('tpl.add')}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t('tpl.addTitle')}</DialogTitle>
                  <DialogDescription>
                    {t('tpl.addDesc')}
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-6 py-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t('tpl.nameLabel')} <span className="text-red-500">*</span></label>
                      <Input
                        value={newTemplate.name}
                        onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                        placeholder="例如: filesystem"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t('tpl.version')}</label>
                      <Select value={newTemplate.version} onValueChange={(value) => setNewTemplate({ ...newTemplate, version: value as any })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="2024-11-26">2024-11-26 (Latest)</SelectItem>
                          <SelectItem value="2025-03-26">2025-03-26</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t('tpl.descLabel')}</label>
                    <Input
                      value={newTemplate.description}
                      onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                      placeholder="简要描述此服务的功能"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t('tpl.transport')}</label>
                    <Select value={newTemplate.transport} onValueChange={(value) => setNewTemplate({ ...newTemplate, transport: value as any })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">Standard I/O (本地进程)</SelectItem>
                        <SelectItem value="http">HTTP (SSE)</SelectItem>
                        <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      {newTemplate.transport === 'stdio' ? `${t('tpl.commandLabel')} *` : `${t('tpl.urlLabel')} *`}
                    </label>
                    <Input
                      value={newTemplate.command}
                      onChange={(e) => setNewTemplate({ ...newTemplate, command: e.target.value })}
                      placeholder={newTemplate.transport === 'stdio' ? '例如: npx -y @modelcontextprotocol/server-filesystem' : 'https://api.example.com/mcp'}
                      className="font-mono text-[13px]"
                    />
                  </div>

                  <div className="rounded-lg border p-4 space-y-4">
                    <div className="font-medium text-sm">运行环境设置</div>
                    
                    {/* Portable Sandbox */}
                    <div className="flex items-start space-x-3">
                      <Checkbox
                        id="sbx"
                        checked={sandboxEnabled}
                        onCheckedChange={(c) => setSandboxEnabled(!!c)}
                      />
                      <div className="grid gap-1.5 leading-none">
                        <label
                          htmlFor="sbx"
                          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                        >
                          {t('tpl.enablePortableSandbox')}
                        </label>
                        <p className="text-xs text-muted-foreground">
                          使用隔离的 Node.js/Python 环境运行，不依赖系统安装的运行时。
                        </p>
                      </div>
                    </div>

                    {sandboxEnabled && (
                      <div className="grid grid-cols-2 gap-4 pl-7">
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">Node.js 路径 (可选)</label>
                          <Input className="h-8 text-xs" value={sandboxNodeDir} onChange={e => setSandboxNodeDir(e.target.value)} placeholder="默认使用内置" />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">Python 路径 (可选)</label>
                          <Input className="h-8 text-xs" value={sandboxPythonDir} onChange={e => setSandboxPythonDir(e.target.value)} placeholder="默认使用内置" />
                        </div>
                      </div>
                    )}

                    <div className="h-[1px] bg-border my-4" />

                    {/* Container Sandbox */}
                    <div className="flex items-start space-x-3">
                      <Checkbox
                        id="ct"
                        checked={containerEnabled}
                        onCheckedChange={(c) => setContainerEnabled(!!c)}
                      />
                      <div className="grid gap-1.5 leading-none">
                        <label
                          htmlFor="ct"
                          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                        >
                          {t('tpl.container.enable')}
                        </label>
                        <p className="text-xs text-muted-foreground">
                          在 Docker 容器中运行此服务，提供最强的隔离性。
                        </p>
                      </div>
                    </div>

                    {containerEnabled && (
                      <div className="grid gap-4 pl-7">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium">镜像 <span className="text-red-500">*</span></label>
                            <Input className="h-8" value={containerImage} onChange={e => setContainerImage(e.target.value)} placeholder="例如: node:20-alpine" />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium">工作目录</label>
                            <Input className="h-8" value={containerWorkdir} onChange={e => setContainerWorkdir(e.target.value)} placeholder="/app" />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium">挂载卷</label>
                          <Textarea
                            className="min-h-[60px] text-xs font-mono"
                            placeholder={"/host/path:/container/path:ro\n/data:/data"}
                            value={containerVolumesText}
                            onChange={(e) => setContainerVolumesText(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => { setShowAddModal(false); resetNewTemplate(); }}>
                    {t('common.cancel')}
                  </Button>
                  <Button onClick={handleAddTemplate} disabled={!newTemplate.name || !newTemplate.command}>
                    {t('tpl.add')}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      />

      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索模板..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8 w-[250px] h-9"
              />
            </div>
          </div>
          {selectedTemplates.size > 0 && (
            <Button variant="destructive" size="sm" onClick={batchDeleteTemplates} className="h-9 gap-2">
              <Trash2 className="h-4 w-4" />
              删除选中 ({selectedTemplates.size})
            </Button>
          )}
        </div>
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[40px] px-4">
                  <Checkbox
                    checked={templates.length > 0 && selectedTemplates.size === templates.length}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead>{t('tpl.nameLabel')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('tpl.descLabel')}</TableHead>
                <TableHead>{t('tpl.transport')}</TableHead>
                <TableHead className="text-right px-4">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.filter(t => {
                const q = query.trim().toLowerCase();
                if (!q) return true;
                return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
              }).map((tpl) => {
                const missingEnv = getMissingEnvKeysTemplate(tpl);
                const sandboxPolicy = (tpl as any)?.sandboxPolicy || null;
                const effectiveContainer = sandboxPolicy?.effective === 'container';
                const forced = Boolean(sandboxPolicy?.forced) && effectiveContainer;
                const isContainer = sandboxPolicy ? effectiveContainer : isContainerTpl(tpl);
                const reasons: string[] = Array.isArray(sandboxPolicy?.reasons) ? sandboxPolicy.reasons : [];
                const policyError: string | undefined = typeof sandboxPolicy?.error === 'string' ? sandboxPolicy.error : undefined;
                return (
                  <TableRow key={tpl.name} className="hover:bg-muted/50">
                    <TableCell className="px-4">
                      <Checkbox
                        checked={selectedTemplates.has(tpl.name)}
                        onCheckedChange={() => toggleSelected(tpl.name)}
                        aria-label={`Select ${tpl.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Box className="h-4 w-4 text-muted-foreground" />
                        {tpl.name}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground truncate max-w-[300px]">
                      {tpl.description || '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs">
                          {tpl.transport}
                        </Badge>
                        {isContainer && !forced && (
                          <Badge variant="secondary" className="bg-blue-50 text-blue-700 hover:bg-blue-50 border-blue-200">
                            Container
                          </Badge>
                        )}
                        {forced && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="secondary" className="bg-amber-50 text-amber-800 hover:bg-amber-50 border-amber-200 flex gap-1 items-center">
                                <AlertTriangle className="h-3 w-3" />
                                {t('tpl.quarantine')}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={6} className="max-w-[420px]">
                              <div className="font-medium mb-1">{t('tpl.quarantineReason')}</div>
                              <div className="space-y-0.5">
                                {(reasons.length ? reasons : ['(no reason)']).map((r, i) => (
                                  <div key={i}>- {formatSandboxReason(r)}</div>
                                ))}
                                {policyError && (<div className="opacity-90">- ERROR: {policyError}</div>)}
                              </div>
                              <div className="mt-1 opacity-90">{t('tpl.quarantineTip')}</div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {missingEnv.length > 0 && (
                          <Badge variant="secondary" className="bg-amber-50 text-amber-700 hover:bg-amber-50 border-amber-200 flex gap-1 items-center">
                            <AlertTriangle className="h-3 w-3" />
                            配置
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right px-4">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 hover:bg-emerald-50 hover:text-emerald-600" onClick={() => handleUseTemplate(tpl.name)}>
                          <Play className="h-4 w-4" />
                          <span className="sr-only">{t('tpl.useTemplate')}</span>
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">更多操作</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>操作</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => handleUseTemplate(tpl.name)}>
                              <Play className="mr-2 h-4 w-4" /> {t('tpl.useTemplate')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEditTemplate(tpl)}>
                              <Edit className="mr-2 h-4 w-4" /> {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => diagnoseTemplate(tpl)}>
                              诊断配置
                            </DropdownMenuItem>
                            {missingEnv.length > 0 && (
                              <DropdownMenuItem onClick={() => openTplEnvFix(tpl)}>
                                设置环境变量
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDeleteTemplate(tpl.name)} className="text-destructive focus:text-destructive">
                              <Trash2 className="mr-2 h-4 w-4" /> {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {templates.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {t('tpl.emptyHint')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

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

      {/* Edit Template Dialog - Reusing the same structure as Add for consistency */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('tpl.edit')}</DialogTitle>
            <DialogDescription>
              {t('tpl.editing')} "{editingTemplate?.name}"
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-4">
             {/* Name field is read-only in edit mode usually, but here we allow changing it which acts as a rename/recreate */}
             <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">{t('tpl.nameLabel')} <span className="text-red-500">*</span></label>
                  <Input
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">{t('tpl.version')}</label>
                  <Select value={newTemplate.version} onValueChange={(value) => setNewTemplate({ ...newTemplate, version: value as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2024-11-26">2024-11-26</SelectItem>
                      <SelectItem value="2025-03-26">2025-03-26</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">{t('tpl.descLabel')}</label>
                <Input
                  value={newTemplate.description}
                  onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">{t('tpl.transport')}</label>
                <Select value={newTemplate.transport} onValueChange={(value) => setNewTemplate({ ...newTemplate, transport: value as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">Standard I/O</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">
                  {newTemplate.transport === 'stdio' ? `${t('tpl.commandLabel')} *` : `${t('tpl.urlLabel')} *`}
                </label>
                <Input
                  value={newTemplate.command}
                  onChange={(e) => setNewTemplate({ ...newTemplate, command: e.target.value })}
                  className="font-mono text-[13px]"
                />
              </div>

              <div className="rounded-lg border p-4 space-y-4">
                <div className="font-medium text-sm">运行环境设置</div>
                <div className="flex items-start space-x-3">
                  <Checkbox id="sbx-edit" checked={sandboxEnabled} onCheckedChange={(c) => setSandboxEnabled(!!c)} />
                  <div className="grid gap-1.5 leading-none">
                    <label htmlFor="sbx-edit" className="text-sm font-medium leading-none">{t('tpl.enablePortableSandbox')}</label>
                  </div>
                </div>
                {sandboxEnabled && (
                  <div className="grid grid-cols-2 gap-4 pl-7">
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground">Node.js 路径</label>
                      <Input className="h-8 text-xs" value={sandboxNodeDir} onChange={e => setSandboxNodeDir(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground">Python 路径</label>
                      <Input className="h-8 text-xs" value={sandboxPythonDir} onChange={e => setSandboxPythonDir(e.target.value)} />
                    </div>
                  </div>
                )}
                <div className="h-[1px] bg-border my-4" />
                <div className="flex items-start space-x-3">
                  <Checkbox id="ct-edit" checked={containerEnabled} onCheckedChange={(c) => setContainerEnabled(!!c)} />
                  <div className="grid gap-1.5 leading-none">
                    <label htmlFor="ct-edit" className="text-sm font-medium leading-none">{t('tpl.container.enable')}</label>
                  </div>
                </div>
                {containerEnabled && (
                  <div className="grid gap-4 pl-7">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium">镜像</label>
                        <Input className="h-8" value={containerImage} onChange={e => setContainerImage(e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium">工作目录</label>
                        <Input className="h-8" value={containerWorkdir} onChange={e => setContainerWorkdir(e.target.value)} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">挂载卷</label>
                      <Textarea className="min-h-[60px] text-xs font-mono" value={containerVolumesText} onChange={(e) => setContainerVolumesText(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => { setShowEditModal(false); setEditingTemplate(null); resetNewTemplate(); }}>
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
              <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <Input className="h-8 text-xs" placeholder="KEY" value={e.key} onChange={(ev) => updateEnvEntry(idx, 'key', ev.target.value)} />
                <Input className="h-8 text-xs" placeholder="VALUE" value={e.value} onChange={(ev) => updateEnvEntry(idx, 'value', ev.target.value)} />
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => removeEnvRow(idx)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
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
