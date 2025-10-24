import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import PageHeader from '@/components/PageHeader'
import { useToastHelpers } from '@/components/ui/toast'
import { FileText, Globe, Archive } from 'lucide-react'
import { apiClient } from '../api/client'
import { useI18n } from '@/i18n'

type CatalogItem = {
  id?: string
  name: string
  repo?: string
  transport: 'stdio' | 'http' | 'streamable-http'
  description: string
  tags: string[]
  template: any // McpServiceConfig compatible
}

const McpCatalog: React.FC = () => {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()
  const [query, setQuery] = useState('')
  const [transport, setTransport] = useState<'all' | 'stdio' | 'http' | 'streamable-http'>('all')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [installing, setInstalling] = useState<string | null>(null)

  useEffect(() => {
    let aborted = false
    const load = async () => {
      try {
        if (query.trim()) {
          const res = await apiClient.searchMarketplace(query.trim())
          if (!aborted && res.ok) {
            const results = (res.data?.results || []).map((it: any) => ({
              id: it.id,
              name: it.name,
              repo: it.repo,
              transport: it.template?.transport || 'stdio',
              description: it.description || '',
              tags: it.tags || [],
              template: it.template || it.config
            })) as CatalogItem[]
            setItems(results)
          }
        } else {
          const res = await apiClient.listMarketplace()
          if (!aborted && res.ok) {
            const list = (res.data?.templates || []).map((it: any) => ({
              id: it.id,
              name: it.name,
              repo: it.repo,
              transport: it.template?.transport || 'stdio',
              description: it.description || '',
              tags: it.tags || [],
              template: it.template || it.config
            })) as CatalogItem[]
            setItems(list)
          }
        }
      } catch {
        // 静默失败，UI保持空列表
      }
    }
    load()
    return () => { aborted = true }
  }, [query])

  const filtered = useMemo(() => {
    return items.filter(i => transport === 'all' || i.transport === transport)
  }, [items, transport])

  const installTemplate = async (item: CatalogItem) => {
    setInstalling(item.name)
    try {
      const result = await apiClient.installMarketplace(item.id || item.name)
      if (result.ok) {
        success(t('catalog.installSuccess'), `${t('catalog.templateAdded')} ${item.name}`)
      } else {
        showError(t('catalog.installFail'), result.error || t('common.unknown'))
      }
    } catch (err) {
      showError(t('catalog.installFail'), err instanceof Error ? err.message : t('common.networkError'))
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('catalog.title')} description={t('catalog.desc')} />

      <Card>
        <CardHeader>
          <CardTitle>{t('catalog.discoverTitle')}</CardTitle>
          <CardDescription>{t('catalog.discoverDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('catalog.searchPlaceholder')} />
            </div>
            <div>
              <Select value={transport} onValueChange={(v) => setTransport(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('catalog.protocolAll')}</SelectItem>
                  <SelectItem value="stdio">Standard I/O</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map(item => (
              <Card key={item.name} className="hover:shadow-md transition-shadow">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-emerald-600" />
                      {item.name}
                    </CardTitle>
                    <Badge variant="secondary">{item.transport}</Badge>
                  </div>
                  <CardDescription>{item.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2 flex-wrap mb-4">
                    {item.tags.map(tag => (
                      <Badge key={tag} variant="outline">{tag}</Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button onClick={() => installTemplate(item)} disabled={installing === item.name} className="gap-2">
                      <Archive className="h-4 w-4" /> {installing === item.name ? t('catalog.installing') : t('catalog.install')}
                    </Button>
                    {item.repo && item.repo.includes('/') && (
                      <a href={`https://github.com/${item.repo}`} target="_blank" rel="noreferrer" className="text-sm text-foreground/70 hover:text-foreground flex items-center gap-1">
                        <Globe className="h-4 w-4" /> {t('catalog.repo')}
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('catalog.secSandboxTitle')}</CardTitle>
          <CardDescription>{t('catalog.secSandboxDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-6 text-sm text-slate-600 dark:text-slate-400 space-y-1">
            <li>
              {t('catalog.sbxBullet1')} <code>mcp-sandbox/runtimes/*</code>
            </li>
            <li>{t('catalog.sbxBullet2')}</li>
            <li>
              {t('catalog.sbxBullet3')} <code>env.SANDBOX</code> {t('catalog.sbxBullet3b')} <code>portable</code> {t('catalog.sbxBullet3c')} <code>container</code>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

export default McpCatalog

