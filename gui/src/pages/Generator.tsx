import { useState } from 'react'
import { useI18n } from '@/i18n'
import PageHeader from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Wand2,
  Check,
  AlertCircle,
  Download,
  Copy,
  FileCode2,
  Sparkles,
  Loader2
} from 'lucide-react'
import { useToastHelpers } from '@/components/ui/toast'

const EXAMPLE_MARKDOWN = `# Weather API

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

export default function Generator() {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()

  const [markdown, setMarkdown] = useState(EXAMPLE_MARKDOWN)
  const [serviceName, setServiceName] = useState('weather-api')
  const [transport, setTransport] = useState<'auto' | 'http' | 'stdio' | 'streamable-http'>('auto')
  const [autoRegister, setAutoRegister] = useState(true)

  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = async () => {
    setGenerating(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch('/api/v1/generator/generate', {
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
      const response = await fetch('/api/v1/generator/export', {
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    success(t('common.copied'), t('common.copiedDesc'))
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title={t('generator.title')}
        description={t('generator.description')}
        icon={<Wand2 className="size-6" />}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Input */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCode2 className="size-5" />
              {t('generator.input')}
            </CardTitle>
            <CardDescription>{t('generator.inputDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Service Name */}
            <div className="space-y-2">
              <Label htmlFor="serviceName">{t('generator.serviceName')}</Label>
              <Input
                id="serviceName"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="my-api-service"
              />
            </div>

            {/* Transport */}
            <div className="space-y-2">
              <Label htmlFor="transport">{t('generator.transport')}</Label>
              <Select value={transport} onValueChange={(v: any) => setTransport(v)}>
                <SelectTrigger id="transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('generator.transportAuto')}</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="stdio">Stdio</SelectItem>
                  <SelectItem value="streamable-http">StreamableHTTP</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Auto Register */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="autoRegister"
                checked={autoRegister}
                onCheckedChange={(c) => setAutoRegister(!!c)}
              />
              <Label htmlFor="autoRegister" className="cursor-pointer font-normal">
                {t('generator.autoRegister')}
              </Label>
            </div>

            {/* Markdown Input */}
            <div className="space-y-2">
              <Label htmlFor="markdown">{t('generator.markdown')}</Label>
              <Textarea
                id="markdown"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={t('generator.markdownPlaceholder')}
                className="font-mono text-xs min-h-[400px]"
              />
            </div>

            {/* Generate Button */}
            <Button
              onClick={handleGenerate}
              disabled={generating || !markdown || !serviceName}
              className="w-full"
              size="lg"
            >
              {generating ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {t('generator.generating')}
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 size-4" />
                  {t('generator.generate')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Right: Output */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="size-5" />
              {t('generator.output')}
            </CardTitle>
            <CardDescription>{t('generator.outputDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="flex items-start gap-2 p-4 rounded-md bg-destructive/10 text-destructive">
                <AlertCircle className="size-5 shrink-0 mt-0.5" />
                <div className="text-sm">{error}</div>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                {/* Status */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check className="size-5 text-green-600" />
                    <span className="font-semibold">{t('generator.success')}</span>
                  </div>
                  <Badge variant={result.validation?.valid ? 'default' : 'secondary'}>
                    {result.validation?.valid ? t('generator.valid') : t('generator.invalid')}
                  </Badge>
                </div>

                {/* Metadata */}
                <div className="grid grid-cols-2 gap-4 p-4 rounded-md bg-muted">
                  <div>
                    <div className="text-xs text-muted-foreground">{t('generator.serviceName')}</div>
                    <div className="font-mono text-sm">{result.template?.name}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('generator.transport')}</div>
                    <div className="font-mono text-sm">{result.template?.config?.transport}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('generator.tools')}</div>
                    <div className="font-mono text-sm">{result.template?.tools?.length || 0}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('generator.registered')}</div>
                    <div className="font-mono text-sm">{result.registered ? t('common.yes') : t('common.no')}</div>
                  </div>
                </div>

                {/* Validation Warnings */}
                {result.validation?.warnings?.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t('generator.warnings')}</div>
                    <div className="space-y-1">
                      {result.validation.warnings.map((warning: string, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <AlertCircle className="size-3 shrink-0 mt-0.5" />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tabs: Config / Tools */}
                <Tabs defaultValue="config" className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="config">{t('generator.config')}</TabsTrigger>
                    <TabsTrigger value="tools">{t('generator.tools')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="config" className="space-y-2">
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(JSON.stringify(result.template?.config, null, 2))}
                      >
                        <Copy className="mr-2 size-3" />
                        {t('common.copy')}
                      </Button>
                    </div>
                    <pre className="p-4 rounded-md bg-muted text-xs overflow-auto max-h-[400px]">
                      {JSON.stringify(result.template?.config, null, 2)}
                    </pre>
                  </TabsContent>

                  <TabsContent value="tools" className="space-y-2">
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(JSON.stringify(result.template?.tools, null, 2))}
                      >
                        <Copy className="mr-2 size-3" />
                        {t('common.copy')}
                      </Button>
                    </div>
                    <pre className="p-4 rounded-md bg-muted text-xs overflow-auto max-h-[400px]">
                      {JSON.stringify(result.template?.tools, null, 2)}
                    </pre>
                  </TabsContent>
                </Tabs>

                {/* Export Buttons */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('json')}
                  >
                    <Download className="mr-2 size-3" />
                    {t('generator.exportJSON')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('typescript')}
                  >
                    <Download className="mr-2 size-3" />
                    {t('generator.exportTS')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport('npm')}
                  >
                    <Download className="mr-2 size-3" />
                    {t('generator.exportNPM')}
                  </Button>
                </div>
              </div>
            )}

            {!result && !error && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Wand2 className="size-12 mb-4 opacity-20" />
                <p className="text-sm">{t('generator.noResult')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Documentation */}
      <Card>
        <CardHeader>
          <CardTitle>{t('generator.docTitle')}</CardTitle>
          <CardDescription>{t('generator.docDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <h4>{t('generator.docMarkdownFormat')}</h4>
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
        </CardContent>
      </Card>
    </div>
  )
}
