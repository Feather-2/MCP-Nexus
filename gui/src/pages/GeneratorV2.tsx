import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import PageHeader from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
import { apiClient } from '@/api/client'
import { useToastHelpers } from '@/components/ui/toast'
import { Loader2, Send, Wand2, History as HistoryIcon, Trash2 } from 'lucide-react'

type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string }

const GeneratorV2: React.FC = () => {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try { return JSON.parse(localStorage.getItem('genv2_messages') || '[]') } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [markdown, setMarkdown] = useState<string>(() => localStorage.getItem('genv2_markdown') || '')
  const [result, setResult] = useState<any>(null)
  const [generating, setGenerating] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [streaming, setStreaming] = useState(true)
  const streamRef = useRef<EventSource | null>(null)
  const [acting, setActing] = useState(false)

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
    })
  }

  useEffect(() => { scrollToBottom() }, [messages])

  const persist = (msgs: ChatMsg[], md?: string) => {
    try {
      localStorage.setItem('genv2_messages', JSON.stringify(msgs))
      if (typeof md === 'string') localStorage.setItem('genv2_markdown', md)
    } catch {}
  }

  const clearHistory = () => {
    setMessages([])
    setMarkdown('')
    persist([],'')
  }

  const send = async () => {
    if (!input.trim()) return
    const next = [...messages, { role: 'user', content: input.trim() } as ChatMsg]
    setMessages(next)
    setInput('')
    setSending(true)
    try {
      if (streaming) {
        let acc = ''
        streamRef.current = apiClient.createAiChatStream(next[next.length-1].content, (delta) => {
          acc += delta
          setMarkdown(acc)
        }, () => {
          const assistant: ChatMsg = { role: 'assistant', content: acc }
          const doneMsgs = [...next, assistant]
          setMessages(doneMsgs)
          persist(doneMsgs, acc)
          streamRef.current = null
          setSending(false)
        }, (err) => {
          showError(t('genv2.chatFail'), err.message)
          streamRef.current = null
          setSending(false)
        })
        return
      } else {
        const res = await apiClient.aiChat(next)
        if (res.ok) {
          const assistant = (res.data as any)?.message || { role: 'assistant', content: '收到。' }
          const doneMsgs = [...next, assistant]
          setMessages(doneMsgs)
          const text = String(assistant.content || '')
          setMarkdown(text)
          persist(doneMsgs, text)
        } else {
          showError(t('genv2.chatFail'), res.error || t('common.unknownError'))
        }
      }
    } catch (err) {
      showError(t('genv2.chatFail'), err instanceof Error ? err.message : t('common.networkError'))
    } finally {
      if (!streaming) setSending(false)
    }
  }

  const buildFromMarkdown = async () => {
    if (!markdown.trim()) {
      showError(t('genv2.noMarkdown'), t('genv2.noMarkdownDesc'))
      return
    }
    setGenerating(true)
    setResult(null)
    try {
      const resp = await fetch('/api/generator/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { type: 'markdown', content: markdown }, options: { autoRegister: false, transport: 'auto', testMode: true } })
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setResult(data)
      success(t('genv2.generateOk'))
    } catch (err) {
      showError(t('genv2.generateFail'), err instanceof Error ? err.message : t('common.networkError'))
    } finally {
      setGenerating(false)
    }
  }

  const registerTemplate = async () => {
    try {
      if (!result?.template?.config) {
        showError(t('genv2.registerFail'), t('genv2.noResult'))
        return
      }
      setActing(true)
      const res = await apiClient.importTemplateFromJson(result.template.config, { autoRegister: true, overwrite: true })
      if (res.ok) success(t('genv2.registerOk'))
      else showError(t('genv2.registerFail'), res.error || t('common.unknownError'))
    } catch (err) {
      showError(t('genv2.registerFail'), err instanceof Error ? err.message : t('common.networkError'))
    } finally { setActing(false) }
  }

  const exportJson = async () => {
    try {
      const name = result?.template?.name
      if (!name) { showError(t('genv2.exportFail'), t('genv2.noResult')); return }
      setActing(true)
      const res = await apiClient.exportTemplate(name, 'json')
      if (res.ok) {
        // Prefer downloadUrl; else create a blob
        const url = (res.data as any)?.downloadUrl
        if (url) {
          window.open(url, '_blank')
        } else {
          const data = (res.data as any)?.data || result
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `${name}.json`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        }
        success(t('genv2.exportOk'))
      } else {
        showError(t('genv2.exportFail'), res.error || t('common.unknownError'))
      }
    } catch (err) {
      showError(t('genv2.exportFail'), err instanceof Error ? err.message : t('common.networkError'))
    } finally { setActing(false) }
  }

  const previewJson = useMemo(() => {
    if (!result) return ''
    try { return JSON.stringify(result, null, 2) } catch { return '' }
  }, [result])

  return (
    <div className="space-y-6">
      <PageHeader title={t('genv2.title')} description={t('genv2.desc')} icon={<Wand2 className="h-6 w-6 text-primary" />} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 左侧：预览与生成 */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('genv2.markdown')}</CardTitle>
              <CardDescription>{t('genv2.markdownDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea value={markdown} onChange={(e) => { setMarkdown(e.target.value); persist(messages, e.target.value) }} className="min-h-[200px] font-mono" placeholder={t('genv2.mdPlaceholder') || ''} />
              <div className="mt-3 flex gap-2">
                <Button onClick={buildFromMarkdown} disabled={generating} className="gap-2">
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {t('genv2.generate')}
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('genv2.preview')}</CardTitle>
              <CardDescription>{t('genv2.previewDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="text-xs whitespace-pre-wrap break-words bg-muted p-3 rounded min-h-[160px] max-h-[420px] overflow-auto">{previewJson || t('genv2.noResult')}</pre>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" onClick={exportJson} disabled={acting}>{t('genv2.exportJson')}</Button>
                <Button onClick={registerTemplate} disabled={acting}>{t('genv2.register')}</Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧：聊天 */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>{t('genv2.chatTitle')}</CardTitle>
              <CardDescription>{t('genv2.chatDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 h-[560px]">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2"><HistoryIcon className="h-4 w-4" />{t('common.history') || '历史'}</div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="stream-mode" checked={streaming} onCheckedChange={(c) => setStreaming(!!c)} />
                    <Label htmlFor="stream-mode" className="text-xs cursor-pointer">stream</Label>
                  </div>
                  <Button variant="outline" size="sm" onClick={clearHistory} className="gap-1"><Trash2 className="h-3 w-3" />{t('common.clearHistory')}</Button>
                </div>
              </div>
              <div ref={listRef} className="flex-1 overflow-auto rounded border p-2 bg-background">
                {messages.filter(m => m.role !== 'system').map((m, idx) => (
                  <div key={idx} className={`mb-2 p-2 rounded ${m.role === 'user' ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'bg-muted'}`}>
                    <div className="text-[11px] text-muted-foreground">{m.role}</div>
                    <div className="whitespace-pre-wrap text-sm">{m.content}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  placeholder={t('genv2.inputPlaceholder') || ''}
                />
                <Button onClick={send} disabled={sending} className="gap-2">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t('genv2.send')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default GeneratorV2
