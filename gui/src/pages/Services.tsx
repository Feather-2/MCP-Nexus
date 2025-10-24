"use client"

import { useEffect, useMemo, useState } from "react"
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
  const [logsOpenId, setLogsOpenId] = useState<string | null>(null)
  const [live, setLive] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>([])

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
      const result = await apiClient.createService(newSvcTemplate)
      if (result.ok) {
        setCreateOpen(false)
        setNewSvcTemplate("")
        await load()
      } else {
        console.error('Failed to create service:', result.error)
      }
    } catch (error) {
      console.error('Error creating service:', error)
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
        const logItems = result.data.map((l: any) => `${l.timestamp} [${l.level}] ${l.message}`)
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
          onLines([`${time} ${obj.message}`])
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