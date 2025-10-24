import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { useI18n } from "@/i18n"
import { type OrchestratorConfig } from "@/api/client"

interface BudgetTabProps {
  config: OrchestratorConfig
  onConfigChange: (config: OrchestratorConfig) => void
  onSave: () => Promise<void>
  saving: boolean
}

export default function BudgetTab({ config, onConfigChange, onSave, saving }: BudgetTabProps) {
  const { t } = useI18n()
  const budget = config.budget || {}

  const updateBudget = (key: string, value: any) => {
    onConfigChange({
      ...config,
      budget: { ...(config.budget || {}), [key]: value }
    })
  }

  return (
    <div className="space-y-6">
      {/* 预算限制 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.budget.limits.title")}</CardTitle>
          <CardDescription>{t("orch.budget.limits.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>{t("orch.budget.maxTokens")}</Label>
              <Input
                type="number"
                value={budget.maxTokens || 100000}
                onChange={(e) => updateBudget("maxTokens", parseInt(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t("orch.budget.maxTokens.hint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("orch.budget.maxTime")}</Label>
              <Input
                type="number"
                value={budget.maxTimeMs || 30000}
                onChange={(e) => updateBudget("maxTimeMs", parseInt(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t("orch.budget.maxTime.hint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("orch.budget.maxCost")}</Label>
              <Input
                type="number"
                step="0.01"
                value={budget.maxCostUsd || 1.0}
                onChange={(e) => updateBudget("maxCostUsd", parseFloat(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t("orch.budget.maxCost.hint")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 并发控制 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.budget.concurrency.title")}</CardTitle>
          <CardDescription>{t("orch.budget.concurrency.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("orch.budget.globalConcurrency")}</Label>
              <Input
                type="number"
                value={budget.globalConcurrency || 5}
                onChange={(e) => updateBudget("globalConcurrency", parseInt(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t("orch.budget.globalConcurrency.hint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("orch.budget.perSubagent")}</Label>
              <Input
                type="number"
                value={budget.perSubagentConcurrency || 2}
                onChange={(e) => updateBudget("perSubagentConcurrency", parseInt(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                {t("orch.budget.perSubagent.hint")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 降级策略 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.budget.degradation.title")}</CardTitle>
          <CardDescription>{t("orch.budget.degradation.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("orch.budget.degradation.at80")}</Label>
                <span className="text-sm text-muted-foreground">80%</span>
              </div>
              <Select
                value={budget.degradation?.at80 || "summary"}
                onValueChange={(value) => updateBudget("degradation", {
                  ...(budget.degradation || {}),
                  at80: value
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("orch.budget.degradation.none")}</SelectItem>
                  <SelectItem value="summary">{t("orch.budget.degradation.summary")}</SelectItem>
                  <SelectItem value="ref">{t("orch.budget.degradation.ref")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("orch.budget.degradation.at90")}</Label>
                <span className="text-sm text-muted-foreground">90%</span>
              </div>
              <Select
                value={budget.degradation?.at90 || "ref"}
                onValueChange={(value) => updateBudget("degradation", {
                  ...(budget.degradation || {}),
                  at90: value
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="summary">{t("orch.budget.degradation.summary")}</SelectItem>
                  <SelectItem value="ref">{t("orch.budget.degradation.ref")}</SelectItem>
                  <SelectItem value="stop">{t("orch.budget.degradation.stop")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="pt-4 space-y-2">
            <div className="text-sm font-medium">{t("orch.budget.degradation.preview")}</div>
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>{t("orch.budget.degradation.tokenUsage")}</span>
                  <span className="font-mono">45,000 / 100,000</span>
                </div>
                <Progress value={45} className="h-2" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>{t("orch.budget.degradation.timeUsage")}</span>
                  <span className="font-mono">12,000 / 30,000 ms</span>
                </div>
                <Progress value={40} className="h-2" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span>{t("orch.budget.degradation.costUsage")}</span>
                  <span className="font-mono">$0.35 / $1.00</span>
                </div>
                <Progress value={35} className="h-2" />
              </div>
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
