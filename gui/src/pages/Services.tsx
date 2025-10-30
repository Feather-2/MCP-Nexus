"use client"

import { useEffect, useMemo, useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Loader2, Plus, RefreshCw, StopCircle, Eye, PlayCircle } from "lucide-react"
import PageHeader from "@/components/PageHeader"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiClient, type ServiceInstance, type ServiceTemplate } from '../api/client';
import { UIStateManager } from "@/utils/persistence";
// import { useI18n } from "@/lib/i18n"
import { useI18n } from "@/i18n"

export default function ServicesSection() {
  const { t } = useI18n()
  const [services, setServices] = useState<ServiceInstance[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newSvcTemplate, setNewSvcTemplate] = useState("")
  const [instanceMode, setInstanceMode] = useState<'keep-alive'|'managed'>('keep-alive')
  const [logsOpenId, setLogsOpenId] = useState<string | null>(null)
  const [live, setLive] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>([])
  // Quick ENV dialog
  const [envFixOpen, setEnvFixOpen] = useState(false)
  const [envFixSvc, setEnvFixSvc] = useState<ServiceInstance | null>(null)
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([])
  const [envHint, setEnvHint] = useState<string | null>(null)

  const [rowClickSelect, setRowClickSelect] = useState<boolean>(() => UIStateManager.getUIState().rowClickSelect ?? false)
  const anySelected = useMemo(() => Object.values(selected).some(Boolean), [selected])

  async function load() {
    setLoading(true)
    try {
      const [svcsResult, tplsResult] = await Promise.all([
        apiClient.getServices(),
        apiClient.getTemplates()
      ])

      if (svcsResult.ok) setServices(svcsResult.data || [])
      if (tplsResult.ok) setTemplates(tplsResult.data || [])
    } catch (error) {
      console.error('Error loading services data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function createService() {
    if (!newSvcTemplate) return

    try {
      const result = await apiClient.createService(newSvcTemplate, { instanceMode })
      if (result.ok) {
        setCreateOpen(false)
        setNewSvcTemplate("")
        setInstanceMode('keep-alive')
        await load()
      } else {
        console.error('Failed to create service:', result.error)
      }
    } catch (error) {
      console.error('Error creating service:', error)
    }
  }

  // --- ENV helpers ---
  function requiredEnvFor(s: ServiceInstance): string[] {
    const name = (s.config?.name || '').toLowerCase()
    const cmd = (s.config?.command || '').toLowerCase()
    const args = (s.config?.args || []).join(' ').toLowerCase()
    // Known mappings
    if (name.includes('brave')) return ['BRAVE_API_KEY']
    if (name.includes('github')) return ['GITHUB_TOKEN']
    if (name.includes('openai') || cmd.includes('openai') || args.includes('openai')) return ['OPENAI_API_KEY']
    if (name.includes('azure-openai') || cmd.includes('azure-openai') || args.includes('azure-openai')) return ['AZURE_OPENAI_API_KEY','AZURE_OPENAI_ENDPOINT']
    if (name.includes('anthropic') || cmd.includes('anthropic') || args.includes('anthropic')) return ['ANTHROPIC_API_KEY']
    if (name.includes('ollama') || cmd.includes('ollama') || args.includes('ollama')) return []
    // Heuristics by package name
    if (args.includes('@modelcontextprotocol/server-brave-search')) return ['BRAVE_API_KEY']
    if (args.includes('@modelcontextprotocol/server-github')) return ['GITHUB_TOKEN']
    if (args.includes('@modelcontextprotocol/server-openai')) return ['OPENAI_API_KEY']
    if (args.includes('@modelcontextprotocol/server-anthropic')) return ['ANTHROPIC_API_KEY']
    // Extended common providers
    if (name.includes('gemini') || name.includes('google') || cmd.includes('gemini') || args.includes('gemini') || args.includes('google-genai') || args.includes('@modelcontextprotocol/server-google') || args.includes('@modelcontextprotocol/server-gemini')) return ['GOOGLE_API_KEY']
    if (name.includes('cohere') || cmd.includes('cohere') || args.includes('cohere') || args.includes('@modelcontextprotocol/server-cohere')) return ['COHERE_API_KEY']
    if (name.includes('groq') || cmd.includes('groq') || args.includes('groq') || args.includes('@modelcontextprotocol/server-groq')) return ['GROQ_API_KEY']
    if (name.includes('openrouter') || cmd.includes('openrouter') || args.includes('openrouter') || args.includes('@modelcontextprotocol/server-openrouter')) return ['OPENROUTER_API_KEY']
    if (name.includes('together') || cmd.includes('together') || args.includes('together') || args.includes('@modelcontextprotocol/server-together')) return ['TOGETHER_API_KEY']
    if (name.includes('fireworks') || cmd.includes('fireworks') || args.includes('fireworks') || args.includes('@modelcontextprotocol/server-fireworks')) return ['FIREWORKS_API_KEY']
    if (name.includes('deepseek') || cmd.includes('deepseek') || args.includes('deepseek') || args.includes('@modelcontextprotocol/server-deepseek')) return ['DEEPSEEK_API_KEY']
    if (name.includes('mistral') || cmd.includes('mistral') || args.includes('mistral') || args.includes('@modelcontextprotocol/server-mistral')) return ['MISTRAL_API_KEY']
    if (name.includes('perplexity') || cmd.includes('perplexity') || args.includes('perplexity') || args.includes('@modelcontextprotocol/server-perplexity')) return ['PERPLEXITY_API_KEY']
    if (name.includes('replicate') || cmd.includes('replicate') || args.includes('replicate') || args.includes('@modelcontextprotocol/server-replicate')) return ['REPLICATE_API_TOKEN']
    if (name.includes('serpapi') || cmd.includes('serpapi') || args.includes('serpapi') || args.includes('@modelcontextprotocol/server-serpapi')) return ['SERPAPI_API_KEY']
    if (name.includes('huggingface') || name.includes('hugging-face') || cmd.includes('huggingface') || args.includes('huggingface') || args.includes('@modelcontextprotocol/server-huggingface')) return ['HF_TOKEN']
    // Default none
    return []
  }

  function extractEnvKeysFromError(err?: string | null): string[] {
    if (!err) return []
    const text = err.trim()
    const keys: string[] = []
    // Match patterns: "XYZ environment variable is required" or "Missing XYZ"
    const re1 = /([A-Z0-9_]+)\s+environment\s+variable\s+is\s+required/i
    const m1 = re1.exec(text)
    if (m1 && m1[1]) keys.push(m1[1].toUpperCase())
    const re2 = /missing\s+([A-Z][A-Z0-9_]+)/i
    const m2 = re2.exec(text)
    if (m2 && m2[1]) keys.push(m2[1].toUpperCase())
    // Common tokens
    const tokenMatch = /(api[_-]?key|token|secret)/i.exec(text)
    if (tokenMatch && !keys.length) {
      // suggest generic
      if (/brave/i.test(text)) keys.push('BRAVE_API_KEY')
      if (/github/i.test(text)) keys.push('GITHUB_TOKEN')
    }
    return Array.from(new Set(keys))
  }

  function getMissingEnvKeys(s: ServiceInstance): string[] {
    const required = requiredEnvFor(s)
    const provided = Object.keys((s.config?.env || {}) as Record<string, string>)
    const missing = required.filter(k => !provided.includes(k))
    // Add from lastProbeError hint
    const hint = ((s.metadata as any)?.lastProbeError as string | undefined) || ''
    const hinted = extractEnvKeysFromError(hint)
    for (const k of hinted) if (!provided.includes(k) && !missing.includes(k)) missing.push(k)
    return missing
  }

  function openEnvFix(s: ServiceInstance) {
    const missing = getMissingEnvKeys(s)
    const entries: Array<{ key: string; value: string }> = []
    if (missing.length) {
      for (const k of missing) entries.push({ key: k, value: '' })
    } else {
      // if nothing inferred, let user add one row
      entries.push({ key: '', value: '' })
    }
    setEnvEntries(entries)
    setEnvFixSvc(s)
    const hint = ((s.metadata as any)?.lastProbeError as string | undefined) || null
    setEnvHint(hint)
    setEnvFixOpen(true)
  }

  function updateEnvEntry(idx: number, field: 'key'|'value', v: string) {
    setEnvEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: v } : e))
  }

  function addEnvRow() {
    setEnvEntries(prev => [...prev, { key: '', value: '' }])
  }

  function removeEnvRow(i: number) {
    setEnvEntries(prev => prev.filter((_, idx) => idx !== i))
  }

  async function saveEnvFix() {
    if (!envFixSvc) return
    const existing = (envFixSvc.config?.env || {}) as Record<string, string>
    const patch: Record<string, string> = { ...existing }
    for (const { key, value } of envEntries) {
      const k = (key || '').trim()
      if (!k) continue
      patch[k] = value ?? ''
    }
    try {
      await apiClient.updateServiceEnv(envFixSvc.id, patch)
      setEnvFixOpen(false)
      setEnvFixSvc(null)
      setEnvEntries([])
      await load()
    } catch (e) {
      console.error('Failed to update env', e)
    }
  }

  async function stopSelected() {
    const ids = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([id]) => id)

    for (const id of ids) {
      try {
        await apiClient.deleteService(id)
      } catch (error) {
        console.error('Error stopping service:', id, error)
      }
    }
    setSelected({})
    await load()
  }

  function toggleAll() {
    if (anySelected) {
      setSelected({})
    } else {
      const all: Record<string, boolean> = {}
      services.forEach((s) => {
        all[s.id] = true
      })
      setSelected(all)
    }
  }

  async function openLogs(id: string) {
    setLogsOpenId(id)

    try {
      const result = await apiClient.getServiceLogs(id)
      if (result.ok && result.data) {
        // De-duplicate consecutive identical lines
        const raw = result.data as Array<{ timestamp: string; level: string; message: string }>
        const logItems: string[] = []
        let last = ''
        for (const l of raw) {
          const line = `${l.timestamp} [${l.level}] ${l.message}`
          if (line !== last) logItems.push(line)
          last = line
        }
        setHistory(logItems)
      } else {
        setHistory([`${new Date().toISOString()} [INFO] 无日志数据`])
      }
    } catch (error) {
      setHistory([`${new Date().toISOString()} [ERROR] 加载日志失败: ${error}`])
    }
    setLive([])
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('svc.title')}
        actions={(
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} />
              {t('common.refresh')}
            </Button>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <input id="row-click-select" type="checkbox" className="h-3 w-3" checked={rowClickSelect}
                onChange={(e) => { setRowClickSelect(e.target.checked); UIStateManager.setUIState({ rowClickSelect: e.target.checked }); }} />
              <label htmlFor="row-click-select">行点击选中</label>
            </div>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="mr-2 size-4" />
                  {t('svc.create')}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('svc.create')}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>{t('svc.template')}</Label>
                    <Select value={newSvcTemplate} onValueChange={setNewSvcTemplate}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t('svc.selectTemplate')} />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map((t) => (
                          <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>实例模式</Label>
                    <Select value={instanceMode} onValueChange={(v) => setInstanceMode(v as any)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="keep-alive / managed" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keep-alive">keep-alive（常驻，参与健康检查）</SelectItem>
                        <SelectItem value="managed">managed（按需，不参与健康检查）</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button onClick={createService} disabled={!newSvcTemplate}>
                    <PlayCircle className="mr-2 size-4" />
                    {t('common.create')}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      />
      <Card>
        <CardContent>
          <div className="rounded-lg border">
            <div className="grid grid-cols-[40px_1fr_200px_160px_160px_200px] gap-2 px-3 py-2 text-[12px] leading-6 text-muted-foreground">
              <div className="flex items-center">
                <Checkbox checked={anySelected} onCheckedChange={toggleAll} aria-label="Select all" />
              </div>
              <div>{t('common.name')}</div>
              <div>{t('svc.template')}</div>
              <div>{t('common.status')}</div>
              <div>{t('common.createdAt')}</div>
              <div className="text-right">{t('common.actions')}</div>
            </div>
            <Separator />
            {services.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[40px_1fr_200px_160px_160px_200px] gap-2 px-3 py-3 items-center hover:bg-muted/40"
                onClick={(ev) => {
                  // 仅在启用“行点击选中”且点击非交互元素区域时切换选中
                  if (!rowClickSelect) return;
                  const tag = (ev.target as HTMLElement).tagName.toLowerCase();
                  const interactive = ['button','a','input','svg','path','textarea','select'].includes(tag);
                  if (interactive) return;
                  setSelected(prev => ({ ...prev, [s.id]: !prev[s.id] }));
                }}
              >
                <div className="flex items-center">
                  <Checkbox
                    checked={!!selected[s.id]}
                    onCheckedChange={(v: boolean) => setSelected((prev) => ({ ...prev, [s.id]: !!v }))}
                    aria-label={`Select ${s.config?.name || s.id}`}
                  />
                </div>
                <div className="truncate">{s.config?.name || s.id}</div>
                <div className="truncate text-[12px] text-muted-foreground">{s.config?.transport || t('common.unknown')}</div>
                <div>
                  {s.state === "running" ? (
                    <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                      {t('status.running')}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-rose-50 text-rose-700 border-rose-200">
                      {t('status.stopped')}
                    </Badge>
                  )}
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {s.startedAt ? new Date(s.startedAt).toLocaleString() : '-'}
                </div>
                <div className="flex items-center gap-2 justify-end">
                  {/* Quick ENV Fix button when missing keys or recent probe error */}
                  {(() => { const missing = getMissingEnvKeys(s); return missing.length || (s.metadata as any)?.lastProbeError ? (
                    <Button variant="outline" size="sm" onClick={() => openEnvFix(s)}>
                      {t('common.configure')}
                    </Button>
                  ) : null })()}
                  <Button variant="outline" size="sm" onClick={() => openLogs(s.id)}>
                    <Eye className="mr-2 size-4" />
                    {t('svc.logs')}
                  </Button>
                  {s.state === "running" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={async () => {
                        try {
                          await apiClient.deleteService(s.id)
                          await load()
                        } catch (error) {
                          console.error('Error stopping service:', error)
                        }
                      }}
                    >
                      <StopCircle className="mr-2 size-4" />
                      {t('common.stop')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {services.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className={`size-4 ${loading ? "animate-spin" : ""}`} />
                {t('svc.empty')}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="destructive" disabled={!anySelected} onClick={stopSelected}>
              <StopCircle className="mr-2 size-4" />
              {t('svc.stopSelected')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!logsOpenId}
        onOpenChange={(open) => {
          if (!open) setLogsOpenId(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('svc.logs')}</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="history">
            <TabsList>
              <TabsTrigger value="history">{t('svc.logHistory')}</TabsTrigger>
              <TabsTrigger value="live">{t('svc.logLive')}</TabsTrigger>
            </TabsList>
            <TabsContent value="history">
              <LogBox lines={history} />
            </TabsContent>
            <TabsContent value="live">
              <LiveLogs serviceId={logsOpenId ?? ""} onLines={(lines) => setLive((prev) => [...prev, ...lines])} />
              <LogBox lines={live} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Quick ENV Fix Dialog */}
      <Dialog open={envFixOpen} onOpenChange={(open) => { if (!open) { setEnvFixOpen(false); setEnvFixSvc(null); setEnvEntries([]); setEnvHint(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('svc.configureEnv') || '配置环境变量'}</DialogTitle>
          </DialogHeader>
          {envHint && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-2">
              {t('svc.lastError') || '最近错误'}: {envHint}
            </div>
          )}
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
                <Button variant="outline" size="sm" onClick={() => { setEnvFixOpen(false); setEnvFixSvc(null); setEnvEntries([]); }}>{t('common.cancel')}</Button>
                <Button size="sm" onClick={saveEnvFix}>{t('common.save')}</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function LogBox({ lines }: { lines: string[] }) {
  const { t } = useI18n()
  return (
    <div className="mt-3 rounded-lg border bg-muted/40 p-3 h-[320px] overflow-auto font-mono text-xs">
      {lines.length === 0 ? (
        <div className="text-muted-foreground">{t('svc.noLogs')}</div>
      ) : (
        <pre className="whitespace-pre-wrap">{lines.join("\n")}</pre>
      )}
    </div>
  )
}

function LiveLogs({ serviceId, onLines }: { serviceId: string; onLines: (l: string[]) => void }) {
  const [running, setRunning] = useState(true)
  const { t } = useI18n()
  const lastRef = useRef<string>('')

  useEffect(() => {
    if (!running) return

    try {
      const es = new EventSource('/api/logs/stream')
      const handler = (e: MessageEvent) => {
        if (!e.data) return
        try {
          const obj = JSON.parse(e.data) as { message: string; serviceId?: string; time?: string; timestamp?: string }
          const time = obj.time || obj.timestamp || new Date().toISOString()
          if (obj.serviceId && obj.serviceId !== serviceId) return
          const line = `${time} ${obj.message}`
          if (lastRef.current !== line) {
            onLines([line])
            lastRef.current = line
          }
        } catch {
          onLines([String(e.data)])
        }
      }
      es.addEventListener("message", handler)
      return () => {
        es.removeEventListener("message", handler)
        es.close()
      }
    } catch (error) {
      console.error('Error setting up live logs:', error)
    }
  }, [running, serviceId, onLines])

  return (
    <div className="mt-2">
      <Button variant={running ? "secondary" : "default"} size="sm" onClick={() => setRunning((v) => !v)}>
        {running ? t('common.pause') : t('common.resume')}
      </Button>
    </div>
  )
}