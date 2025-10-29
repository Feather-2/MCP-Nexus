import React, { useState, useEffect } from 'react';
import SandboxBanner from '@/components/SandboxBanner';
import { apiClient, type ServiceTemplate } from '../api/client';
import { useToastHelpers } from '../components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PageHeader from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Plus,
  RefreshCw,
  FileText,
  Play,
  Settings,
  Edit,
  Trash2,
  Hammer
} from 'lucide-react';
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
    if (containerEnabled && !containerImage) {
      showError('输入验证失败', '容器模式需要提供镜像');
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
        const volumes = (containerVolumesText || '').split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
          const [hp, cp, ro] = l.split(':');
          return { hostPath: hp, containerPath: cp, readOnly: (ro === 'ro') };
        }).filter(v => v.hostPath && v.containerPath);
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
    if (containerEnabled && !containerImage) {
      showError('输入验证失败', '容器模式需要提供镜像');
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
        const volumes = (containerVolumesText || '').split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
          const [hp, cp, ro] = l.split(':');
          return { hostPath: hp, containerPath: cp, readOnly: (ro === 'ro') };
        }).filter(v => v.hostPath && v.containerPath);
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

  const toggleTemplateSelection = (templateName: string) => {
    const newSelected = new Set(selectedTemplates);
    if (newSelected.has(templateName)) {
      newSelected.delete(templateName);
    } else {
      newSelected.add(templateName);
    }
    setSelectedTemplates(newSelected);
  };

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

      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="sr-only">{t('tpl.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <div className="grid grid-cols-[40px_1fr_220px_160px_200px] gap-2 px-3 py-2 text-[12px] leading-6 text-muted-foreground">
              <div className="flex items-center">
                <Checkbox
                  checked={selectedTemplates.size > 0 && selectedTemplates.size === templates.length}
                  onCheckedChange={() => selectAllTemplates()}
                  aria-label="Select all"
                />
              </div>
              <div>{t('tpl.nameLabel')}</div>
              <div>{t('tpl.descLabel')}</div>
              <div>{t('tpl.transport')}</div>
              <div className="text-right">{t('common.actions')}</div>
            </div>
            <Separator />
            {templates.map((tpl) => (
              <div key={tpl.name} className="grid grid-cols-[40px_1fr_220px_160px_200px] gap-2 px-3 py-3 items-center hover:bg-muted/40">
                <div className="flex items-center">
                  <Checkbox
                    checked={selectedTemplates.has(tpl.name)}
                    onCheckedChange={() => toggleTemplateSelection(tpl.name)}
                    aria-label={`Select ${tpl.name}`}
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
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleUseTemplate(tpl.name)}
                  >
                    <Play className="h-4 w-4 mr-1" />
                    {t('tpl.useTemplate')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEditTemplate(tpl)}
                  >
                    <Edit className="h-3 w-3 mr-1" />
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDeleteTemplate(tpl.name)}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {t('common.delete')}
                  </Button>
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
        </CardContent>
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

    </div>
  );
};

export default Templates;
