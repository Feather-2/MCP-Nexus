"use client"

import type React from "react"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { Activity, LayoutGrid, ShieldHalf, Terminal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { apiClient, type ServiceInstance, type ServiceTemplate, type HealthStatus, type OrchestratorStatus } from '../api/client';
import { useI18n } from "@/i18n"

import { CardDescription } from "@/components/ui/card"

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
  const orchReason = orchestrator?.reason ?? (!orchestrator ? t('dash.orchestratorStatusUnavailable') : undefined)
  const orchSubagents = orchestrator?.subagentsDir ?? t('dash.orchestratorNoSubagents')

  return (
    <div className="space-y-6">
      <Card className="rounded-2xl p-6 bg-gradient-to-br from-emerald-50 to-background border">
        <CardHeader className="p-0">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{t('dash.welcome')}</h1>
              <CardDescription>{t('dash.subtitle')}</CardDescription>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="secondary" onClick={refresh} disabled={loading}>
                <Activity className={cn("mr-2 size-4", loading && "animate-spin")} />
                {t('dashboard.refresh') || t('common.refresh')}
              </Button>
              <Button variant="default" onClick={() => onNavigate?.("services")}>
                <Terminal className="mr-2 size-4" />
                {t('dash.createService')}
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] text-muted-foreground">{t('dash.runningServices')}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">
            {runningServices}{" "}
            <span className="text-base text-muted-foreground">/ {totalServices}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] text-muted-foreground">{t('dash.templates')}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{templates.length}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] text-muted-foreground">{t('dash.apiKeys')}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{health?.apiKeys ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[13px] text-muted-foreground">{t('dash.sandboxInstalled')}</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{health?.sandboxInstalled ? t('common.yes') : t('common.no')}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t('dash.healthOverview')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center text-muted-foreground py-12">
              {t('dash.systemOk')}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('dash.quickActions')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ActionItem
              icon={<LayoutGrid className="size-4" />}
              title={t('dash.manageTemplates')}
              desc={t('dash.manageTemplatesDesc')}
              onClick={() => onNavigate?.("templates")}
            />
            <Separator />
            <ActionItem
              icon={<ShieldHalf className="size-4" />}
              title={t('dash.generateToken')}
              desc={t('dash.generateTokenDesc')}
              onClick={() => onNavigate?.("auth")}
            />
            <Separator />
            <ActionItem
              icon={<Activity className="size-4" />}
              title={t('dash.openMonitoring')}
              desc={t('dash.openMonitoringDesc')}
              onClick={() => onNavigate?.("monitoring")}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('dash.orchestratorStatus')}</CardTitle>
          <CardDescription>{t('dash.orchestratorStatusDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={orchestrator?.enabled ? "default" : "secondary"} className="uppercase tracking-wide">
              {orchStatusLabel}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t('dash.orchestratorModeLabel')}{' '}
              <span className="font-medium text-foreground">{orchModeLabel}</span>
            </span>
          </div>
          {orchReason && (
            <p className="text-sm text-muted-foreground">
              {t('dash.orchestratorReasonLabel')}{orchReason}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {t('dash.orchestratorSubagentsLabel')}
              <code className="ml-1 text-xs text-foreground bg-muted/70 px-1.5 py-0.5 rounded">
                {orchSubagents}
              </code>
            </span>
            <Button variant="outline" size="sm" onClick={() => onNavigate?.("orchestrator")}>
              {t('dash.configureOrchestrator')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dash.overview')}</CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-muted-foreground mb-2">{t('dash.recentServices')}</div>
            <ul className="space-y-1.5">
              {services.slice(0, 5).map((s) => (
                <li key={s.id} className="text-sm flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/40">
                  <span className="truncate">
                    {s.config?.name || s.id}{" "}
                    <span className="text-muted-foreground">
                      {" · "}
                      {s.config?.transport || t('common.unknown')}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded-full border",
                      s.state === "running"
                        ? "text-emerald-600 border-emerald-200 bg-emerald-50"
                        : "text-rose-600 border-rose-200 bg-rose-50",
                    )}
                  >
                    {s.state}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-2">{t('dash.recentTemplates')}</div>
            <ul className="space-y-1.5">
              {templates.slice(0, 5).map((tpl) => (
                <li key={tpl.name} className="text-sm flex items-center justify-between rounded-md px-2 py-1 hover:bg-muted/40">
                  <span className="truncate">{tpl.name}</span>
                  <span className="text-[12px] text-muted-foreground">{tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleString() : '-'}</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ActionItem({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  onClick?: () => void
}) {
  return (
    <button onClick={onClick} className="w-full text-left rounded-xl border p-3 hover:bg-muted/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="mt-1">{icon}</div>
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
    </button>
  )
}
