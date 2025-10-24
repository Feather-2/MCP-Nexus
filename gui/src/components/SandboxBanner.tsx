import React, { useEffect, useRef, useState } from 'react'
import { apiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

type Status = {
  nodeReady: boolean
  pythonReady: boolean
  goReady: boolean
  packagesReady: boolean
  details?: Record<string, any>
}

const Dot: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <div className="flex items-center gap-1 text-sm">
    <span className={`inline-block size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
    <span className={ok ? 'text-foreground/80' : 'text-amber-700'}>{label}</span>
  </div>
)

const SandboxBanner: React.FC = () => {
  const { t } = useI18n()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const logEsRef = useRef<EventSource | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [progress, setProgress] = useState(0)
  const [current, setCurrent] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, 'pending'|'installing'|'done'|'error'>>({})
  const [stage, setStage] = useState<{ event?: string; component?: string }>({})

  const refresh = async () => {
    setLoading(true)
    setError(null)
    const res = await apiClient.getSandboxStatus()
    if (res.ok) setStatus(res.data as unknown as Status)
    else setError(res.error || t('sbx.stateFail'))
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])
  useEffect(() => {
    let cancelled = false
    const open = async () => {
      if (!showLogs) {
        // close if open
        if (logEsRef.current) { try { logEsRef.current.close() } catch {} logEsRef.current = null }
        return
      }
      // initial fetch
      const res = await apiClient.getLogs(20)
      if (!cancelled && res.ok) setLogs(res.data || [])
      // stream
      logEsRef.current = apiClient.createLogStream((log) => {
        setLogs(prev => {
          const arr = Array.isArray(prev) ? prev : []
          const next = [...arr, log]
          if (next.length > 200) next.shift()
          return next
        })
      }, () => {})
    }
    open()
    return () => {
      cancelled = true
      if (logEsRef.current) { try { logEsRef.current.close() } catch {} logEsRef.current = null }
    }
  }, [showLogs])

  const needAction = !!status && (!status.nodeReady || !status.packagesReady)

  const onInstallStream = async () => {
    setError(null)
    setStreaming(true)
    setStatuses({ node: 'pending', python: 'pending', go: 'pending', packages: 'pending' })
    setProgress(0)
    setCurrent(null)
    const es = apiClient.createSandboxInstallStream(['node','python','go','packages'], (msg) => {
      if (msg.event === 'start') {
        setProgress(0)
      } else if (msg.event === 'component_start') {
        setCurrent(msg.component)
        setStatuses(s => ({ ...s, [msg.component]: 'installing' }))
        setStage({ event: undefined, component: undefined })
      } else if (msg.event === 'component_done') {
        setStatuses(s => ({ ...s, [msg.component]: 'done' }))
        setProgress(msg.progress ?? 0)
        setStage({ event: undefined, component: undefined })
      } else if (
        msg.event === 'download_start' || msg.event === 'download_done' ||
        msg.event === 'extract_start' || msg.event === 'extract_done' ||
        msg.event === 'configure_done' || msg.event === 'install_start' || msg.event === 'install_done'
      ) {
        setStage({ event: msg.event, component: msg.component })
      } else if (msg.event === 'error') {
        setStatuses(s => ({ ...s, [msg.component]: 'error' }))
        setError(msg.error || t('common.unknown'))
      } else if (msg.event === 'complete') {
        setProgress(100)
        setStreaming(false)
        refresh()
      }
    }, () => { setStreaming(false) })
    if (!es) {
      setStreaming(false)
      setError(t('sbx.streamFail'))
    }
  }

  const onRepair = async () => {
    setInstalling(true)
    setError(null)
    const res = await apiClient.repairSandbox(['node','python','go','packages'])
    if (!res.ok) setError(res.error || t('common.unknown'))
    await refresh()
    setInstalling(false)
  }

  const onCleanup = async () => {
    setInstalling(true)
    setError(null)
    const res = await apiClient.cleanupSandbox()
    if (!res.ok) setError(res.error || t('common.unknown'))
    await refresh()
    setInstalling(false)
  }

  if (loading && !status) return null
  if (!status || !needAction) return null

  return (
    <div className="mb-4 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="text-sm font-medium">{t('sbx.selfCheck')}</div>
          <Dot ok={status.nodeReady} label={t('sbx.node')} />
          <Dot ok={status.pythonReady} label={t('sbx.python')} />
          <Dot ok={status.goReady} label={t('sbx.go')} />
          <Dot ok={status.packagesReady} label={t('sbx.mcpPackages')} />
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={installing || streaming}>{t('common.refresh')}</Button>
          <Button onClick={onInstallStream} disabled={installing || streaming} className="gap-2">
            {streaming ? t('sbx.installing') : t('sbx.installOneClick')}
          </Button>
          <Button variant="outline" onClick={onRepair} disabled={installing}>{t('sbx.repair')}</Button>
          <Button variant="outline" onClick={onCleanup} disabled={installing}>{t('sbx.cleanup')}</Button>
          <Button variant="outline" onClick={() => setShowLogs(s => !s)}>{showLogs ? t('sbx.hideLogs') : t('sbx.viewLogs')}</Button>
        </div>
      </div>
      {(installing || streaming) && (
        <div className="mt-2">
          <div className="text-xs text-foreground/70 mb-1">{current ? `${t('sbx.installingPrefix')}${current}` : t('sbx.preparing')}</div>
          {stage.event && (
            <div className="text-xs text-foreground/60 mb-1">
              {t(`sbx.stage.${stage.event}`)}{stage.component ? `: ${stage.component}` : ''}
            </div>
          )}
          <div className="h-2 bg-muted rounded w-full overflow-hidden">
            <div className="h-2 bg-emerald-500" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 text-xs text-foreground/60">
            {Object.entries(statuses).map(([k,v]) => (
              <span key={k} className={`mr-3 ${v==='done'?'text-emerald-600': v==='installing'?'text-blue-600': v==='error'?'text-red-600':'text-foreground/60'}`}>{k}:{t(`sbx.status.${v||'pending'}`)}</span>
            ))}
          </div>
        </div>
      )}
      {showLogs && (
        <div className="mt-2 max-h-48 overflow-auto text-xs font-mono bg-muted/30 p-2 rounded">
          {logs.map((l, i) => (
            <div key={i} className="opacity-80">[{l.timestamp}] {l.level}: {l.message}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default SandboxBanner
