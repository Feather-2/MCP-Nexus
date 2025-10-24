import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/i18n"
import { type OrchestratorConfig, type OrchestratorMode } from "@/api/client"
import { ArrowRight, Box, MousePointerClick, Info } from "lucide-react"

interface OverviewTabProps {
  config: OrchestratorConfig
  onConfigChange: (config: OrchestratorConfig) => void
}

export default function OverviewTab({ config, onConfigChange }: OverviewTabProps) {
  const { t } = useI18n()
  const [selectedLayer, setSelectedLayer] = useState<number | null>(null)

  return (
    <div className="space-y-6">
      {/* 三层架构可视化 - 可点击查看详情 */}
      <Card className="border-0 shadow-md">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-xl">{t("orch.overview.architecture.title")}</CardTitle>
            <Badge variant="outline" className="text-xs">
              <MousePointerClick className="h-3 w-3 mr-1" />
              {t("orch.overview.clickToLearn")}
            </Badge>
          </div>
          <CardDescription>{t("orch.overview.architecture.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6 relative">
            {/* Layer 3: Meta-Capability */}
            <button
              onClick={() => setSelectedLayer(3)}
              className="relative group text-left w-full"
            >
              <div className="relative rounded-xl border-2 border-primary/30 bg-gradient-to-br from-primary/10 to-primary/5 p-6 hover:border-primary/60 hover:shadow-lg transition-all duration-300 h-full cursor-pointer">
                <div className="absolute -top-3 left-4 bg-background px-2">
                  <Badge variant="default" className="text-xs font-semibold">{t("orch.overview.layer3.badge")}</Badge>
                </div>
                <div className="flex flex-col gap-3 h-full">
                  <div className="flex items-center justify-between">
                    <Box className="h-10 w-10 text-primary shrink-0" />
                    <Info className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="font-semibold text-lg">{t("orch.overview.layer3.title")}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("orch.overview.layer3.shortDesc")}
                  </div>
                </div>
              </div>
            </button>

            {/* 连接箭头 */}
            <div className="hidden md:flex md:absolute md:top-1/2 md:left-1/4 md:-translate-x-1/2 md:-translate-y-1/2 md:z-10">
              <ArrowRight className="h-5 w-5 text-muted-foreground/40" />
            </div>

            {/* Layer 2: Subagent Layer */}
            <button
              onClick={() => setSelectedLayer(2)}
              className="relative group text-left w-full"
            >
              <div className="relative rounded-xl border-2 border-blue-200/50 dark:border-blue-900/40 bg-gradient-to-br from-blue-50/50 to-blue-50/20 dark:from-blue-950/20 dark:to-blue-950/10 p-6 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg transition-all duration-300 h-full cursor-pointer">
                <div className="absolute -top-3 left-4 bg-background px-2">
                  <Badge className="bg-blue-600 text-white text-xs font-semibold">{t("orch.overview.layer2.badge")}</Badge>
                </div>
                <div className="flex flex-col gap-3 h-full">
                  <div className="flex items-center justify-between">
                    <Box className="h-10 w-10 text-blue-600 shrink-0" />
                    <Info className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="font-semibold text-lg">{t("orch.overview.layer2.title")}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("orch.overview.layer2.shortDesc")}
                  </div>
                </div>
              </div>
            </button>

            {/* 连接箭头 */}
            <div className="hidden md:flex md:absolute md:top-1/2 md:right-1/4 md:translate-x-1/2 md:-translate-y-1/2 md:z-10">
              <ArrowRight className="h-5 w-5 text-muted-foreground/40" />
            </div>

            {/* Layer 1: Tool Layer */}
            <button
              onClick={() => setSelectedLayer(1)}
              className="relative group text-left w-full"
            >
              <div className="relative rounded-xl border-2 border-gray-200/50 dark:border-gray-700/40 bg-gradient-to-br from-gray-50/50 to-gray-50/20 dark:from-gray-900/20 dark:to-gray-900/10 p-6 hover:border-gray-400 dark:hover:border-gray-500 hover:shadow-lg transition-all duration-300 h-full cursor-pointer">
                <div className="absolute -top-3 left-4 bg-background px-2">
                  <Badge variant="outline" className="text-xs font-semibold">{t("orch.overview.layer1.badge")}</Badge>
                </div>
                <div className="flex flex-col gap-3 h-full">
                  <div className="flex items-center justify-between">
                    <Box className="h-10 w-10 text-gray-600 dark:text-gray-400 shrink-0" />
                    <Info className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <div className="font-semibold text-lg">{t("orch.overview.layer1.title")}</div>
                  <div className="text-sm text-muted-foreground">
                    {t("orch.overview.layer1.shortDesc")}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* 基础配置 */}
      <Card className="border-0 shadow-md">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl">{t("orch.basic.title")}</CardTitle>
          <CardDescription>{t("orch.basic.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 启用开关 */}
          <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
            <div className="space-y-1 flex-1">
              <Label htmlFor="orch-enabled" className="text-base font-medium cursor-pointer">
                {t("orch.basic.enable")}
              </Label>
              <div className="text-sm text-muted-foreground">
                {t("orch.basic.enableDesc")}
              </div>
            </div>
            <Switch
              id="orch-enabled"
              checked={config.enabled}
              onCheckedChange={(checked) => onConfigChange({ ...config, enabled: checked })}
            />
          </div>

          <Separator />

          {/* 工作模式 */}
          <div className="space-y-4">
            <Label htmlFor="orch-mode" className="text-base font-medium">{t("orch.basic.mode")}</Label>

            <Select
              value={config.mode}
              onValueChange={(value: OrchestratorMode) => onConfigChange({ ...config, mode: value })}
            >
              <SelectTrigger id="orch-mode" className="h-12">
                <SelectValue placeholder={t("orch.basic.modePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager-only">
                  <div className="py-1">
                    <div className="font-medium">{t("orch.mode.managerOnly.label")}</div>
                    <div className="text-xs text-muted-foreground mt-1">{t("orch.mode.managerOnly.shortDesc")}</div>
                  </div>
                </SelectItem>
                <SelectItem value="auto">
                  <div className="py-1">
                    <div className="font-medium">{t("orch.mode.auto.label")}</div>
                    <div className="text-xs text-muted-foreground mt-1">{t("orch.mode.auto.shortDesc")}</div>
                  </div>
                </SelectItem>
                <SelectItem value="wrapper-prefer">
                  <div className="py-1">
                    <div className="font-medium">{t("orch.mode.wrapperPrefer.label")}</div>
                    <div className="text-xs text-muted-foreground mt-1">{t("orch.mode.wrapperPrefer.shortDesc")}</div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>

            {/* 当前模式的详细说明 */}
            <div className="p-4 rounded-lg bg-muted/50 border">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <div className="font-medium text-sm">
                    {config.mode === "manager-only" && t("orch.mode.managerOnly.label")}
                    {config.mode === "auto" && t("orch.mode.auto.label")}
                    {config.mode === "wrapper-prefer" && t("orch.mode.wrapperPrefer.label")}
                  </div>
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    {config.mode === "manager-only" && t("orch.mode.managerOnly.fullDesc")}
                    {config.mode === "auto" && t("orch.mode.auto.fullDesc")}
                    {config.mode === "wrapper-prefer" && t("orch.mode.wrapperPrefer.fullDesc")}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Layer 详情对话框 */}
      <Dialog open={selectedLayer !== null} onOpenChange={() => setSelectedLayer(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedLayer === 3 && (
                <>
                  <Badge variant="default">{t("orch.overview.layer3.badge")}</Badge>
                  {t("orch.overview.layer3.title")}
                </>
              )}
              {selectedLayer === 2 && (
                <>
                  <Badge className="bg-blue-600 text-white">{t("orch.overview.layer2.badge")}</Badge>
                  {t("orch.overview.layer2.title")}
                </>
              )}
              {selectedLayer === 1 && (
                <>
                  <Badge variant="outline">{t("orch.overview.layer1.badge")}</Badge>
                  {t("orch.overview.layer1.title")}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {selectedLayer === 3 && t("orch.overview.layer3.desc")}
              {selectedLayer === 2 && t("orch.overview.layer2.desc")}
              {selectedLayer === 1 && t("orch.overview.layer1.desc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            {selectedLayer === 3 && (
              <>
                <div>
                  <h4 className="font-semibold mb-3 text-sm">{t("orch.overview.capabilities")}</h4>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
                      <Badge variant="outline" className="mt-0.5">{t("orch.overview.layer3.capability1")}</Badge>
                      <span className="text-sm text-muted-foreground">{t("orch.overview.layer3.capability1.desc")}</span>
                    </div>
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
                      <Badge variant="outline" className="mt-0.5">{t("orch.overview.layer3.capability2")}</Badge>
                      <span className="text-sm text-muted-foreground">{t("orch.overview.layer3.capability2.desc")}</span>
                    </div>
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
                      <Badge variant="outline" className="mt-0.5">{t("orch.overview.layer3.capability3")}</Badge>
                      <span className="text-sm text-muted-foreground">{t("orch.overview.layer3.capability3.desc")}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
            {selectedLayer === 2 && (
              <>
                <div>
                  <h4 className="font-semibold mb-3 text-sm">{t("orch.overview.exampleSubagents")}</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Badge variant="secondary">search</Badge>
                    <Badge variant="secondary">knowledge</Badge>
                    <Badge variant="secondary">file</Badge>
                    <Badge variant="secondary">web</Badge>
                    <Badge variant="secondary">database</Badge>
                    <Badge variant="secondary">analytics</Badge>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {t("orch.overview.layer2.detail")}
                </div>
              </>
            )}
            {selectedLayer === 1 && (
              <>
                <div>
                  <h4 className="font-semibold mb-3 text-sm">{t("orch.overview.exampleTools")}</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Badge variant="outline">brave-search</Badge>
                    <Badge variant="outline">reader-api</Badge>
                    <Badge variant="outline">filesystem</Badge>
                    <Badge variant="outline">sentiment</Badge>
                    <Badge variant="outline">github</Badge>
                    <Badge variant="outline">sqlite</Badge>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  {t("orch.overview.layer1.detail")}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
