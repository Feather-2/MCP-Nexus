import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/i18n"
import { type OrchestratorConfig } from "@/api/client"
import { useState } from "react"

interface RoutingTabProps {
  config: OrchestratorConfig
  onConfigChange: (config: OrchestratorConfig) => void
  onSave: () => Promise<void>
  saving: boolean
}

export default function RoutingTab({ config, onConfigChange, onSave, saving }: RoutingTabProps) {
  const { t } = useI18n()
  const routing = config.routing || {}
  const planner = config.planner || {}

  const [weights, setWeights] = useState({
    cost: routing.weights?.cost || 50,
    performance: routing.weights?.performance || 50
  })

  const updateRouting = (key: string, value: any) => {
    onConfigChange({
      ...config,
      routing: { ...(config.routing || {}), [key]: value }
    })
  }

  const updatePlanner = (key: string, value: any) => {
    onConfigChange({
      ...config,
      planner: { ...(config.planner || {}), [key]: value }
    })
  }

  return (
    <div className="space-y-6">
      {/* 执行链路选择 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.routing.path.title")}</CardTitle>
          <CardDescription>{t("orch.routing.path.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t("orch.routing.path.default")}</Label>
            <Select
              value={routing.defaultPath || "orchestrator"}
              onValueChange={(value) => updateRouting("defaultPath", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">{t("orch.routing.path.direct")}</SelectItem>
                <SelectItem value="orchestrator">{t("orch.routing.path.orchestrator")}</SelectItem>
                <SelectItem value="auto">{t("orch.routing.path.auto")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {routing.defaultPath === "direct" && t("orch.routing.path.direct.hint")}
              {routing.defaultPath === "orchestrator" && t("orch.routing.path.orchestrator.hint")}
              {routing.defaultPath === "auto" && t("orch.routing.path.auto.hint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Planner 配置 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.planner.title")}</CardTitle>
          <CardDescription>{t("orch.planner.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("orch.planner.provider")}</Label>
              <Select
                value={planner.provider || "local"}
                onValueChange={(value) => updatePlanner("provider", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{t("orch.planner.providerLocal")}</SelectItem>
                  <SelectItem value="remote">{t("orch.planner.providerRemote")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("orch.planner.model")}</Label>
              <Input
                value={planner.model || ""}
                onChange={(e) => updatePlanner("model", e.target.value)}
                placeholder="gpt-4"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("orch.planner.maxSteps")}</Label>
              <Input
                type="number"
                value={planner.maxSteps || 10}
                onChange={(e) => updatePlanner("maxSteps", parseInt(e.target.value))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="planner-fallback">{t("orch.planner.fallback")}</Label>
              <Switch
                id="planner-fallback"
                checked={planner.fallback || false}
                onCheckedChange={(checked) => updatePlanner("fallback", checked)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Subagent 选择策略 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.routing.subagent.title")}</CardTitle>
          <CardDescription>{t("orch.routing.subagent.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <Label>{t("orch.routing.subagent.strategy")}</Label>
            <RadioGroup
              value={routing.subagentStrategy || "tags"}
              onValueChange={(value) => updateRouting("subagentStrategy", value)}
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="tags" id="strategy-tags" />
                <Label htmlFor="strategy-tags" className="font-normal cursor-pointer">
                  {t("orch.routing.subagent.byTags")}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="cost" id="strategy-cost" />
                <Label htmlFor="strategy-cost" className="font-normal cursor-pointer">
                  {t("orch.routing.subagent.byCost")}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="performance" id="strategy-performance" />
                <Label htmlFor="strategy-performance" className="font-normal cursor-pointer">
                  {t("orch.routing.subagent.byPerformance")}
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="custom" id="strategy-custom" />
                <Label htmlFor="strategy-custom" className="font-normal cursor-pointer">
                  {t("orch.routing.subagent.custom")}
                </Label>
              </div>
            </RadioGroup>
          </div>

          {routing.subagentStrategy === "custom" && (
            <div className="grid gap-4 md:grid-cols-2 pt-4 border-t">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("orch.routing.weights.cost")}</Label>
                  <span className="text-sm text-muted-foreground">{weights.cost}%</span>
                </div>
                <Slider
                  value={[weights.cost]}
                  onValueChange={(value: number[]) => {
                    const v = value[0]
                    const newWeights = { ...weights, cost: v }
                    setWeights(newWeights)
                    updateRouting("weights", newWeights)
                  }}
                  max={100}
                  step={5}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("orch.routing.weights.performance")}</Label>
                  <span className="text-sm text-muted-foreground">{weights.performance}%</span>
                </div>
                <Slider
                  value={[weights.performance]}
                  onValueChange={(value: number[]) => {
                    const v = value[0]
                    const newWeights = { ...weights, performance: v }
                    setWeights(newWeights)
                    updateRouting("weights", newWeights)
                  }}
                  max={100}
                  step={5}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 数据返回格式 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.routing.format.title")}</CardTitle>
          <CardDescription>{t("orch.routing.format.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t("orch.routing.format.intermediate")}</Label>
            <Select
              value={routing.intermediateFormat || "summary"}
              onValueChange={(value) => updateRouting("intermediateFormat", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">{t("orch.routing.format.full")}</SelectItem>
                <SelectItem value="summary">{t("orch.routing.format.summary")}</SelectItem>
                <SelectItem value="ref">{t("orch.routing.format.ref")}</SelectItem>
                <SelectItem value="custom">{t("orch.routing.format.custom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="auto-simplify">{t("orch.routing.format.autoSimplify")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("orch.routing.format.autoSimplify.hint")}
              </p>
            </div>
            <Switch
              id="auto-simplify"
              checked={routing.autoSimplify !== false}
              onCheckedChange={(checked) => updateRouting("autoSimplify", checked)}
            />
          </div>
        </CardContent>
      </Card>

      {/* 回退策略 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.routing.fallback.title")}</CardTitle>
          <CardDescription>{t("orch.routing.fallback.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="prefer-local">{t("orch.routing.preferLocal")}</Label>
            <Switch
              id="prefer-local"
              checked={routing.preferLocal !== false}
              onCheckedChange={(checked) => updateRouting("preferLocal", checked)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("orch.routing.planDepth")}</Label>
              <Input
                type="number"
                value={routing.planDepthThreshold || 5}
                onChange={(e) => updateRouting("planDepthThreshold", parseInt(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("orch.routing.failRate")}</Label>
              <Input
                type="number"
                step="0.01"
                value={routing.failRateThreshold || 0.3}
                onChange={(e) => updateRouting("failRateThreshold", parseFloat(e.target.value))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 保存按钮 */}
      <div className="flex justify-end gap-3">
        <Button variant="outline">
          {t("common.cancel")}
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving ? t("orch.actions.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  )
}
