import { useState, useRef, useEffect } from 'react'
import { useI18n } from '@/i18n'
import PageHeader from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Wand2,
  Check,
  AlertCircle,
  Download,
  FileCode2,
  Sparkles,
  Loader2,
  Lightbulb,
  Zap,
  BookOpen,
  Settings,
  Play,
  ChevronRight,
  ChevronDown,
  Target,
  TrendingUp,
  Users,
  Clock,
  Star,
  ArrowRight,
  ExternalLink,
  BarChart3,
  Globe,
  Rocket
} from 'lucide-react'
import { useToastHelpers } from '@/components/ui/toast'

// 预设模板
const PRESET_TEMPLATES = {
  'weather-api': {
    name: 'weather-api',
    description: '天气API服务',
    markdown: `# Weather API

Get current weather information for any city.

## 端点
- URL: https://api.weatherapi.com/v1/current.json
- Method: GET
- Auth: API Key (query parameter: key)

## 参数
- q (string, required): 城市名称，例如 "Beijing" 或 "London"
- aqi (string, optional): 是否返回空气质量数据 (yes/no)

## 响应示例
\`\`\`json
{
  "location": {
    "name": "Beijing",
    "country": "China"
  },
  "current": {
    "temp_c": 15,
    "condition": {
      "text": "Partly cloudy"
    }
  }
}
\`\`\`
`
  },
  'github-api': {
    name: 'github-api',
    description: 'GitHub API服务',
    markdown: `# GitHub API

Access GitHub repositories, issues, and user information.

## 端点
- URL: https://api.github.com/repos/{owner}/{repo}
- Method: GET
- Auth: Bearer Token (header: Authorization)

## 参数
- owner (string, required): Repository owner username
- repo (string, required): Repository name

## 响应示例
\`\`\`json
{
  "id": 1296269,
  "name": "Hello-World",
  "full_name": "octocat/Hello-World",
  "description": "This is your first repository!"
}
\`\`\`
`
  },
  'todo-api': {
    name: 'todo-api',
    description: 'Todo任务管理API',
    markdown: `# Todo API

Manage your daily tasks and todos.

## 端点
- URL: https://jsonplaceholder.typicode.com/todos
- Method: GET, POST, PUT, DELETE
- Auth: None (demo API)

## 参数
- id (number, optional): Todo item ID
- title (string, required): Todo title
- completed (boolean, optional): Completion status

## 响应示例
\`\`\`json
{
  "id": 1,
  "title": "Learn TypeScript",
  "completed": false
}
\`\`\`
`
  }
}

export default function Generator() {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()

  const [selectedTemplate, setSelectedTemplate] = useState<string>('')
  const [serviceName, setServiceName] = useState('my-api-service')
  const [transport, setTransport] = useState<'auto' | 'http' | 'stdio' | 'streamable-http'>('auto')
  const [autoRegister, setAutoRegister] = useState(true)
  const [enableRealtime, setEnableRealtime] = useState(false)
  const [markdown, setMarkdown] = useState('')

  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  // 加载预设模板
  const loadTemplate = (templateKey: string) => {
    const template = PRESET_TEMPLATES[templateKey as keyof typeof PRESET_TEMPLATES]
    if (template) {
      setServiceName(template.name)
      setMarkdown(template.markdown)
      setSelectedTemplate(templateKey)
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/generator/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: {
            type: 'markdown',
            content: markdown
          },
          options: {
            name: serviceName,
            transport,
            autoRegister
          }
        })
      })

      const data = await response.json()

      if (data.success) {
        setResult(data)
        success(t('generator.success'), t('generator.successDesc'))
      } else {
        setError(data.error || 'Unknown error')
        showError(t('generator.error'), data.error)
      }
    } catch (err: any) {
      setError(err.message)
      showError(t('generator.error'), err.message)
    } finally {
      setGenerating(false)
    }
  }

  const handleExport = async (format: 'json' | 'typescript' | 'npm') => {
    if (!result?.template?.name) return

    try {
      const response = await fetch('/api/generator/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateName: result.template.name,
          format,
          options: {
            includeCode: true
          }
        })
      })

      const data = await response.json()

      if (data.success) {
        // Download file
        if (data.downloadUrl) {
          window.open(data.downloadUrl, '_blank')
        }
        success(t('generator.exportSuccess'), `${format.toUpperCase()} ${t('generator.exportSuccessDesc')}`)
      }
    } catch (err: any) {
      showError(t('generator.exportError'), err.message)
    }
  }

  // 实时预览功能（简化版）
  const getPreviewData = () => {
    if (!markdown || !serviceName) return null

    const lines = markdown.split('\n').filter(line => line.trim())
    const titleLine = lines.find(line => line.startsWith('# '))
    const description = lines.find(line => !line.startsWith('#') && !line.startsWith('-'))

    return {
      name: serviceName,
      title: titleLine ? titleLine.substring(2) : serviceName,
      description: description || 'No description provided',
      endpointCount: lines.filter(line => line.includes('URL:')).length,
      paramCount: lines.filter(line => line.includes('- ')).length
    }
  }

  const previewData = getPreviewData()

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="AI 智能生成器"
        description="通过Markdown描述自动生成MCP服务配置"
        icon={<Wand2 className="size-6 text-primary" />}
      />

      {/* 快速模板选择 */}
      <Card className="border-primary/20">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lightbulb className="size-5 text-yellow-500" />
            快速开始
          </CardTitle>
          <CardDescription>选择预设模板快速开始，或从空白模板开始</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Object.entries(PRESET_TEMPLATES).map(([key, template]) => (
              <Card
                key={key}
                className={`cursor-pointer transition-all hover:shadow-md ${
                  selectedTemplate === key ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'
                }`}
                onClick={() => loadTemplate(key)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <h4 className="font-semibold text-sm">{template.name}</h4>
                    <Badge variant="secondary" className="text-xs">预设</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{template.description}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={(e) => {
                      e.stopPropagation()
                      loadTemplate(key)
                    }}
                  >
                    <Play className="mr-2 size-3" />
                    使用此模板
                  </Button>
                </CardContent>
              </Card>
            ))}

            <Card
              className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50"
              onClick={() => {
                setSelectedTemplate('')
                setServiceName('my-api-service')
                setMarkdown('')
              }}
            >
              <CardContent className="p-4 text-center">
                <FileCode2 className="size-8 mx-auto mb-2 text-muted-foreground" />
                <h4 className="font-semibold text-sm mb-1">空白模板</h4>
                <p className="text-xs text-muted-foreground">从零开始创建</p>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left: Input */}
        <div className="xl:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCode2 className="size-5" />
                配置设置
              </CardTitle>
              <CardDescription>填写服务基本信息</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* 服务名称 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="serviceName" className="text-sm font-medium">服务名称</Label>
                  <Input
                    id="serviceName"
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    placeholder="my-api-service"
                    className="font-mono"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="transport" className="text-sm font-medium">传输方式</Label>
                  <Select value={transport} onValueChange={(value) => setTransport(value as any)}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择传输方式" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动检测</SelectItem>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="stdio">Stdio</SelectItem>
                      <SelectItem value="streamable-http">StreamableHTTP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* 高级选项 */}
              <div className="space-y-4 p-4 bg-muted/50 rounded-lg">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Settings className="size-4" />
                  高级选项
                </h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="autoRegister" className="text-sm">自动注册到模板库</Label>
                    <Switch
                      id="autoRegister"
                      checked={autoRegister}
                      onCheckedChange={setAutoRegister}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="enableRealtime" className="text-sm">实时预览</Label>
                    <Switch
                      id="enableRealtime"
                      checked={enableRealtime}
                      onCheckedChange={setEnableRealtime}
                    />
                  </div>
                </div>
              </div>

              {/* Markdown输入 */}
              <div className="space-y-2">
                <Label htmlFor="markdown" className="text-sm font-medium">API 描述 (Markdown)</Label>
                <Textarea
                  id="markdown"
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  placeholder="使用Markdown格式描述您的API接口..."
                  className="min-h-[400px] font-mono text-sm"
                />
              </div>

              {/* 生成按钮 */}
              <Button
                onClick={handleGenerate}
                disabled={generating || !markdown.trim() || !serviceName.trim()}
                className="w-full"
                size="lg"
              >
                {generating ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    正在生成配置...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 size-4" />
                    生成 MCP 配置
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right: Preview */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="size-5 text-green-500" />
                实时预览
              </CardTitle>
              <CardDescription>配置实时预览</CardDescription>
            </CardHeader>
            <CardContent>
              {enableRealtime && previewData ? (
                <div className="space-y-4">
                  <div className="p-4 bg-muted/50 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-semibold text-sm">{previewData.name}</h4>
                      <Badge variant="outline">{transport}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">{previewData.description}</p>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="text-muted-foreground">端点数量:</span>
                        <div className="font-mono">{previewData.endpointCount}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">参数数量:</span>
                        <div className="font-mono">{previewData.paramCount}</div>
                      </div>
                    </div>
                  </div>

                  {serviceName.trim() && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="size-3 text-green-500" />
                      服务名称有效
                    </div>
                  )}
                  {markdown.trim() && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="size-3 text-green-500" />
                      API描述完整
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Zap className="size-8 mb-3 opacity-20" />
                  <p className="text-sm text-center">
                    {enableRealtime ? '填写配置信息查看预览' : '开启实时预览查看配置'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 生成结果 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Check className="size-5" />
                生成结果
              </CardTitle>
              <CardDescription>配置验证和导出</CardDescription>
            </CardHeader>
            <CardContent>
              {error && (
                <div className="flex items-start gap-2 p-4 rounded-md bg-destructive/10 text-destructive mb-4">
                  <AlertCircle className="size-5 shrink-0 mt-0.5" />
                  <div className="text-sm">{error}</div>
                </div>
              )}

              {result && (
                <div className="space-y-4">
                  {/* 状态指示 */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Check className="size-5 text-green-600" />
                      <span className="font-semibold text-sm">生成成功</span>
                    </div>
                    <Badge variant={result.validation?.valid ? 'default' : 'secondary'}>
                      {result.validation?.valid ? '验证通过' : '验证警告'}
                    </Badge>
                  </div>

                  {/* 元数据 */}
                  <div className="grid grid-cols-2 gap-3 p-3 bg-muted/50 rounded-md text-xs">
                    <div>
                      <div className="text-muted-foreground">服务名称</div>
                      <div className="font-mono">{result.template?.name}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">传输方式</div>
                      <div className="font-mono">{result.template?.config?.transport}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">工具数量</div>
                      <div className="font-mono">{result.template?.tools?.length || 0}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">自动注册</div>
                      <div className="font-mono">{result.registered ? '是' : '否'}</div>
                    </div>
                  </div>

                  {/* 验证警告 */}
                  {result.validation?.warnings?.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium">验证警告</div>
                      {result.validation.warnings.map((warning: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <AlertCircle className="size-3 shrink-0 mt-0.5" />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 导出按钮 */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">导出格式</Label>
                    <div className="grid grid-cols-1 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleExport('json')}
                        className="justify-start"
                      >
                        <Download className="mr-2 size-3" />
                        JSON 配置
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleExport('typescript')}
                        className="justify-start"
                      >
                        <Download className="mr-2 size-3" />
                        TypeScript 定义
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleExport('npm')}
                        className="justify-start"
                      >
                        <Download className="mr-2 size-3" />
                        NPM 包
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {!result && !error && (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Wand2 className="size-12 mb-4 opacity-20" />
                  <p className="text-sm text-center">
                    点击"生成 MCP 配置"开始创建
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 快速参考 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            Markdown 格式说明
          </CardTitle>
          <CardDescription>使用标准Markdown格式描述您的API</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h4 className="text-sm font-semibold mb-3">基本格式</h4>
                <pre className="text-xs bg-muted p-4 rounded-md overflow-auto">
{`# API 名称

API 描述

## 端点
- URL: https://api.example.com/v1/endpoint
- Method: GET/POST/PUT/DELETE/PATCH
- Auth: API Key (header: X-API-Key)

## 参数
- param1 (string, required): 参数描述
- param2 (number, optional): 参数描述

## 响应示例
\`\`\`json
{ "result": "success" }
\`\`\``}
                </pre>
              </div>

              <div>
                <h4 className="text-sm font-semibold mb-3">支持的功能</h4>
                <ul className="text-xs space-y-2">
                  <li className="flex items-start gap-2">
                    <Check className="size-3 text-green-500 mt-0.5 shrink-0" />
                    <span>多个端点描述</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="size-3 text-green-500 mt-0.5 shrink-0" />
                    <span>参数类型和验证</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="size-3 text-green-500 mt-0.5 shrink-0" />
                    <span>认证方式定义</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="size-3 text-green-500 mt-0.5 shrink-0" />
                    <span>响应示例</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="size-3 text-green-500 mt-0.5 shrink-0" />
                    <span>错误处理</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
