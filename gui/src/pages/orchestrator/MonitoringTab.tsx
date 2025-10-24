import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/i18n"
import { type OrchestratorConfig } from "@/api/client"
import { Pause, SkipForward, CheckCircle2, Clock, AlertCircle } from "lucide-react"

interface MonitoringTabProps {
  config: OrchestratorConfig
}

// Mock data for demonstration
const mockTasks = [
  {
    id: "task-1",
    goal: "搜索并总结 TypeScript 5.0 新特性",
    status: "running",
    currentStep: 2,
    totalSteps: 4,
    steps: [
      { name: "搜索新闻", tool: "brave-search", status: "completed", duration: 850 },
      { name: "提取内容", tool: "reader-api", status: "completed", duration: 1200 },
      { name: "分析情感", tool: "sentiment", status: "in-progress", requiresApproval: true },
      { name: "生成报告", tool: "file-write", status: "pending" }
    ],
    tokens: 5400,
    cost: 0.08,
    duration: 2050
  }
]

export default function MonitoringTab({ config }: MonitoringTabProps) {
  const { t } = useI18n()

  if (!config.enabled) {
    return (
      <Card>
        <CardContent className="pt-12 pb-12">
          <div className="text-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>{t("orch.monitoring.disabled")}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* 当前执行任务 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("orch.monitoring.current.title")}</CardTitle>
              <CardDescription>{t("orch.monitoring.current.desc")}</CardDescription>
            </div>
            <Badge>{mockTasks.length} {t("orch.monitoring.active")}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {mockTasks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>{t("orch.monitoring.noTasks")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {mockTasks.map((task) => (
                <Card key={task.id} className="border-2">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base">{task.goal}</CardTitle>
                        <div className="flex gap-3 mt-2 text-sm text-muted-foreground">
                          <span>{t("orch.monitoring.step")} {task.currentStep}/{task.totalSteps}</span>
                          <span>•</span>
                          <span>{task.duration}ms</span>
                          <span>•</span>
                          <span>{task.tokens} tokens</span>
                          <span>•</span>
                          <span>${task.cost.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline">
                          <Pause className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline">
                          <SkipForward className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* 执行时间线 */}
                    <div className="space-y-3">
                      {task.steps.map((step, idx) => (
                        <div key={idx} className="flex items-start gap-3">
                          {/* 状态图标 */}
                          <div className="shrink-0 mt-1">
                            {step.status === "completed" && (
                              <CheckCircle2 className="h-5 w-5 text-green-600" />
                            )}
                            {step.status === "in-progress" && (
                              <div className="h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                            )}
                            {step.status === "pending" && (
                              <div className="h-5 w-5 rounded-full border-2 border-gray-300" />
                            )}
                          </div>

                          {/* 步骤信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{step.name}</span>
                              <Badge variant="outline" className="text-xs">
                                {step.tool}
                              </Badge>
                              {step.duration && (
                                <span className="text-xs text-muted-foreground">
                                  {step.duration}ms
                                </span>
                              )}
                            </div>

                            {/* 需要审批 */}
                            {step.requiresApproval && step.status === "in-progress" && (
                              <div className="mt-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2 text-sm text-amber-900 dark:text-amber-100">
                                    <AlertCircle className="h-4 w-4" />
                                    <span>{t("orch.monitoring.approvalRequired")}</span>
                                  </div>
                                  <div className="flex gap-2">
                                    <Button size="sm" variant="outline">
                                      {t("orch.monitoring.modify")}
                                    </Button>
                                    <Button size="sm">
                                      {t("orch.monitoring.approve")}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* 查看结果 */}
                            {step.status === "completed" && (
                              <Button size="sm" variant="link" className="h-auto p-0 text-xs">
                                {t("orch.monitoring.viewResult")}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 执行历史 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.monitoring.history.title")}</CardTitle>
          <CardDescription>{t("orch.monitoring.history.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>{t("orch.monitoring.history.empty")}</p>
          </div>
        </CardContent>
      </Card>

      {/* 人机协同设置 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.monitoring.collaboration.title")}</CardTitle>
          <CardDescription>{t("orch.monitoring.collaboration.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between p-4 rounded-lg border">
              <div>
                <div className="font-medium">{t("orch.monitoring.collaboration.autoApprove")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("orch.monitoring.collaboration.autoApprove.hint")}
                </div>
              </div>
              <Badge variant="secondary">{t("common.disabled")}</Badge>
            </div>
            <div className="flex items-center justify-between p-4 rounded-lg border">
              <div>
                <div className="font-medium">{t("orch.monitoring.collaboration.pauseOnError")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("orch.monitoring.collaboration.pauseOnError.hint")}
                </div>
              </div>
              <Badge>{t("common.enabled")}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
