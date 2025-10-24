import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useI18n } from "@/i18n"
import { type OrchestratorConfig } from "@/api/client"
import { Wand2, FileEdit, Download, Plus, Settings, Trash2 } from "lucide-react"

interface SubagentsTabProps {
  config: OrchestratorConfig
  onConfigChange: (config: OrchestratorConfig) => void
  onSave: () => Promise<void>
  saving: boolean
}

interface Subagent {
  name: string
  description: string
  tags: string[]
  tools: string[]
  actions: string[]
  maxConcurrency: number
}

export default function SubagentsTab({ config, onConfigChange, onSave, saving }: SubagentsTabProps) {
  const { t } = useI18n()
  const [showAIComposer, setShowAIComposer] = useState(false)
  const [aiDescription, setAiDescription] = useState("")
  const [subagents] = useState<Subagent[]>([
    {
      name: "search",
      description: t("orch.subagents.examples.search.desc"),
      tags: ["web", "search", "internet"],
      tools: ["brave-search"],
      actions: ["search", "extract"],
      maxConcurrency: 2
    },
    {
      name: "knowledge",
      description: t("orch.subagents.examples.knowledge.desc"),
      tags: ["qa", "retrieval", "vector"],
      tools: ["vector-search", "rag-qa"],
      actions: ["retrieve", "qa", "summarize"],
      maxConcurrency: 3
    },
    {
      name: "file",
      description: t("orch.subagents.examples.file.desc"),
      tags: ["filesystem", "io"],
      tools: ["filesystem"],
      actions: ["read", "write", "list"],
      maxConcurrency: 1
    }
  ])

  return (
    <div className="space-y-6">
      {/* Subagent 目录配置 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.subagents.directory.title")}</CardTitle>
          <CardDescription>{t("orch.subagents.directory.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="subagents-dir">{t("orch.basic.subagents")}</Label>
            <Input
              id="subagents-dir"
              value={config.subagentsDir}
              onChange={(e) => onConfigChange({ ...config, subagentsDir: e.target.value })}
              placeholder="./config/subagents"
            />
            <p className="text-xs text-muted-foreground">
              {t("orch.subagents.directory.hint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 创建 Subagent 的方式 */}
      <Card>
        <CardHeader>
          <CardTitle>{t("orch.subagents.create.title")}</CardTitle>
          <CardDescription>{t("orch.subagents.create.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            {/* AI 生成 */}
            <Dialog open={showAIComposer} onOpenChange={setShowAIComposer}>
              <DialogTrigger asChild>
                <Button variant="outline" className="h-auto flex-col items-start p-4 space-y-2">
                  <Wand2 className="h-5 w-5 text-primary" />
                  <div className="font-semibold">{t("orch.subagents.create.ai.title")}</div>
                  <div className="text-xs text-muted-foreground text-left">
                    {t("orch.subagents.create.ai.desc")}
                  </div>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("orch.subagents.ai.dialog.title")}</DialogTitle>
                  <DialogDescription>{t("orch.subagents.ai.dialog.desc")}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>{t("orch.subagents.ai.label")}</Label>
                    <Textarea
                      value={aiDescription}
                      onChange={(e) => setAiDescription(e.target.value)}
                      placeholder={t("orch.subagents.ai.placeholder")}
                      className="min-h-32"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setShowAIComposer(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button onClick={() => {
                      // TODO: AI composition logic
                      setShowAIComposer(false)
                    }}>
                      <Wand2 className="h-4 w-4 mr-2" />
                      {t("orch.subagents.ai.generate")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* 手动创建 */}
            <Button variant="outline" className="h-auto flex-col items-start p-4 space-y-2">
              <FileEdit className="h-5 w-5 text-blue-600" />
              <div className="font-semibold">{t("orch.subagents.create.manual.title")}</div>
              <div className="text-xs text-muted-foreground text-left">
                {t("orch.subagents.create.manual.desc")}
              </div>
            </Button>

            {/* 导入模板 */}
            <Button variant="outline" className="h-auto flex-col items-start p-4 space-y-2">
              <Download className="h-5 w-5 text-green-600" />
              <div className="font-semibold">{t("orch.subagents.create.template.title")}</div>
              <div className="text-xs text-muted-foreground text-left">
                {t("orch.subagents.create.template.desc")}
              </div>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Subagent 列表 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("orch.subagents.list.title")}</CardTitle>
              <CardDescription>{t("orch.subagents.list.desc")}</CardDescription>
            </div>
            <Button size="sm" variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              {t("orch.subagents.add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {subagents.map((agent) => (
              <Card key={agent.name} className="border-2">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="font-semibold text-lg">{agent.name}</div>
                        <div className="flex gap-1">
                          {agent.tags.map(tag => (
                            <Badge key={tag} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {agent.description}
                      </div>
                      <div className="flex gap-4 text-sm">
                        <div className="flex items-center gap-1">
                          <Settings className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">
                            {t("orch.subagents.card.tools")}:
                          </span>
                          <span>{agent.tools.join(", ")}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">
                            {t("orch.subagents.card.concurrency")}:
                          </span>
                          <span>{agent.maxConcurrency}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {agent.actions.map(action => (
                          <Badge key={action} variant="outline" className="text-xs">
                            {action}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost">
                        <FileEdit className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
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
