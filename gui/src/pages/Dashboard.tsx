"use client"

import type React from "react"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Activity, LayoutGrid, ShieldHalf, Terminal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { apiClient, type ServiceInstance, type ServiceTemplate, type HealthStatus, type OrchestratorStatus } from '../api/client';
import { useI18n } from "@/i18n"

type Props = {
  onNavigate?: (
    key:
      | "dashboard"
      | "services"
      | "templates"
      | "auth"
      | "monitoring"
      | "catalog"
      | "console"
      | "settings"
      | "orchestrator",
  ) => void
}

export default function DashboardSection({ onNavigate }: Props) {
  const { t } = useI18n()
  const [services, setServices] = useState<ServiceInstance[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [orchestrator, setOrchestrator] = useState<OrchestratorStatus | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    refresh()
  }, [])

  async function refresh() {
    setLoading(true)
    try {
      const [svcsResult, tplsResult, hResult, orchResult] = await Promise.all([
        apiClient.getServices(),
        apiClient.getTemplates(),
        apiClient.getHealthStatus(),
        apiClient.getOrchestratorStatus(),
      ])

      if (svcsResult.ok) setServices(svcsResult.data || [])
      if (tplsResult.ok) setTemplates(tplsResult.data || [])
      if (hResult.ok) setHealth(hResult.data || null)
      if (orchResult.ok) setOrchestrator(orchResult.data || null)
    } catch (error) {
      console.error('Error refreshing dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  const runningServices = services.filter(s => s.state === 'running').length
  const totalServices = services.length
  const orchModeKey = orchestrator?.mode ?? 'manager-only'
  const orchModeLabel = t(`dash.mode.${orchModeKey}`)
  const orchStatusLabel = orchestrator?.enabled ? t('common.enabled') : t('common.disabled')
  const orchSubagents = orchestrator?.subagentsDir ?? t('dash.orchestratorNoSubagents')

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between rounded-xl bg-muted/30 p-6 border border-muted/50">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dash.welcome')}</h1>
          <p className="text-muted-foreground mt-1">{t('dash.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="h-9">
            <Activity className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            {t('dashboard.refresh') || t('common.refresh')}
          </Button>
          <Button size="sm" onClick={() => onNavigate?.("services")} className="h-9">
            <Terminal className="mr-2 h-4 w-4" />
            {t('dash.createService')}
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.runningServices')}</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {runningServices}
              <span className="text-xs text-muted-foreground font-normal ml-1">/ {totalServices}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.templates')}</CardTitle>
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{templates.length}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.apiKeys')}</CardTitle>
            <ShieldHalf className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{health?.apiKeys ?? 0}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dash.sandboxInstalled')}</CardTitle>
            <Terminal className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{health?.sandboxInstalled ? t('common.yes') : t('common.no')}</div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions & Status */}
      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-4 shadow-sm border-muted/60">
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('dash.quickActions')}</CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-3 gap-4">
            <ActionCard
              icon={<LayoutGrid className="h-5 w-5" />}
              title={t('dash.manageTemplates')}
              onClick={() => onNavigate?.("templates")}
            />
            <ActionCard
              icon={<ShieldHalf className="h-5 w-5" />}
              title={t('dash.generateToken')}
              onClick={() => onNavigate?.("auth")}
            />
            <ActionCard
              icon={<Activity className="h-5 w-5" />}
              title={t('dash.openMonitoring')}
              onClick={() => onNavigate?.("monitoring")}
            />
          </CardContent>
        </Card>

        <Card className="md:col-span-3 shadow-sm border-muted/60">
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('dash.orchestratorStatus')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('dash.orchestratorModeLabel')}</span>
              <Badge variant="outline" className="font-mono text-xs">
                {orchModeLabel}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">状态</span>
              <Badge variant={orchestrator?.enabled ? "default" : "secondary"} className="text-xs">
                {orchStatusLabel}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('dash.orchestratorSubagentsLabel')}</span>
              <span className="text-sm font-medium">{orchSubagents}</span>
            </div>
            <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => onNavigate?.("orchestrator")}>
              {t('dash.configureOrchestrator')}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="shadow-sm border-muted/60">
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('dash.recentServices')}</CardTitle>
          </CardHeader>
          <CardContent>
            {services.length > 0 ? (
              <div className="space-y-1">
                {services.slice(0, 5).map((s) => (
                  <div key={s.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={cn("h-2 w-2 rounded-full shrink-0", s.state === "running" ? "bg-emerald-500" : "bg-rose-500")} />
                      <div className="truncate">
                        <div className="text-sm font-medium truncate">{s.config?.name || s.id}</div>
                        <div className="text-xs text-muted-foreground truncate">{s.config?.transport}</div>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                      {s.state}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-6">暂无服务</div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-muted/60">
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('dash.recentTemplates')}</CardTitle>
          </CardHeader>
          <CardContent>
            {templates.length > 0 ? (
              <div className="space-y-1">
                {templates.slice(0, 5).map((tpl) => (
                  <div key={tpl.name} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <LayoutGrid className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="truncate">
                        <div className="text-sm font-medium truncate">{tpl.name}</div>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                      {tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString() : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-6">暂无模板</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function ActionCard({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border bg-card hover:bg-accent hover:text-accent-foreground transition-colors text-center"
    >
      <div className="p-2 rounded-full bg-primary/10 text-primary">
        {icon}
      </div>
      <span className="text-sm font-medium">{title}</span>
    </button>
  )
}
