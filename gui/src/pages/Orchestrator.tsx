import { useEffect, useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { apiClient, type OrchestratorConfig } from "@/api/client"
import { useToastHelpers } from "@/components/ui/toast"
import { useI18n } from "@/i18n"
import { Network, Layers, Settings as SettingsIcon, Activity, DollarSign } from "lucide-react"
import PageHeader from "@/components/PageHeader"
import { Card, CardContent } from "@/components/ui/card"
import { AlertCircle } from "lucide-react"

// Import tab components
import OverviewTab from "./orchestrator/OverviewTab"
import SubagentsTab from "./orchestrator/SubagentsTab"
import RoutingTab from "./orchestrator/RoutingTab"
import BudgetTab from "./orchestrator/BudgetTab"
import MonitoringTab from "./orchestrator/MonitoringTab"

export default function OrchestratorSection() {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()
  const [config, setConfig] = useState<OrchestratorConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("overview")

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const configRes = await apiClient.getOrchestratorConfig()
      if (configRes.ok && configRes.data?.config) {
        setConfig(configRes.data.config)
      } else {
        setError(configRes.error || t("orch.loadConfigFail"))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orch.loadConfigFail"))
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      const result = await apiClient.updateOrchestratorConfig(config)
      if (result.ok && result.data?.config) {
        setConfig(result.data.config)
        success(t("orch.saveSuccess"), t("orch.saveSuccessDesc"))
        await refresh()
      } else {
        const msg = result.error || t("orch.saveFail")
        setError(msg)
        showError(t("orch.saveFail"), msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("orch.saveFail")
      setError(msg)
      showError(t("orch.saveFail"), msg)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-muted-foreground">
        {t("orch.loading")}
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex flex-col gap-4">
        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-destructive mb-1">{t("common.error")}</div>
                  <div className="text-sm text-muted-foreground">{error}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("orch.title")}
        description={t("orch.description")}
        icon={<Network className="h-6 w-6 text-primary" />}
      />

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-destructive mb-1">{t("common.error")}</div>
                <div className="text-sm text-muted-foreground">{error}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline">{t("orch.tabs.overview")}</span>
          </TabsTrigger>
          <TabsTrigger value="subagents" className="flex items-center gap-2">
            <Network className="h-4 w-4" />
            <span className="hidden sm:inline">{t("orch.tabs.subagents")}</span>
          </TabsTrigger>
          <TabsTrigger value="routing" className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t("orch.tabs.routing")}</span>
          </TabsTrigger>
          <TabsTrigger value="budget" className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            <span className="hidden sm:inline">{t("orch.tabs.budget")}</span>
          </TabsTrigger>
          <TabsTrigger value="monitoring" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            <span className="hidden sm:inline">{t("orch.tabs.monitoring")}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab config={config} onConfigChange={setConfig} />
        </TabsContent>

        <TabsContent value="subagents">
          <SubagentsTab config={config} onConfigChange={setConfig} onSave={handleSave} saving={saving} />
        </TabsContent>

        <TabsContent value="routing">
          <RoutingTab config={config} onConfigChange={setConfig} onSave={handleSave} saving={saving} />
        </TabsContent>

        <TabsContent value="budget">
          <BudgetTab config={config} onConfigChange={setConfig} onSave={handleSave} saving={saving} />
        </TabsContent>

        <TabsContent value="monitoring">
          <MonitoringTab config={config} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
