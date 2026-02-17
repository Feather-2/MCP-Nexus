import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import PageHeader from "@/components/PageHeader"
import { apiClient } from "../api/client"
import { useToastHelpers } from "../components/ui/toast"
import { useI18n } from "@/i18n"
import { RefreshCw, Zap, Database, Activity, Trash2 } from "lucide-react"

type PerformanceStats = {
  adapterPool: { size: number; maxSize: number }
  toolListCache: { size: number; hits: number; misses: number; hitRate: number }
  router: any
  timestamp: number
}

function getHitRateColor(hitRate: number): string {
  if (hitRate > 0.8) return "text-emerald-600"
  if (hitRate > 0.5) return "text-amber-600"
  return "text-rose-600"
}

export default function PerformanceSection() {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()
  const [stats, setStats] = useState<PerformanceStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)

  const loadPerformanceStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const result = await apiClient.getPerformanceStats()
      if (result.ok && result.data) {
        setStats(result.data)
      } else if (!silent) {
        showError("Failed to load performance stats", result.error || "Unknown error")
      }
    } catch (error) {
      if (!silent) {
        showError("Failed to load performance stats", error instanceof Error ? error.message : "Unknown error")
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [showError])

  useEffect(() => {
    void loadPerformanceStats()
    const intervalId = window.setInterval(() => {
      void loadPerformanceStats(true)
    }, 5000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadPerformanceStats])

  const handleRefresh = useCallback(async () => {
    await loadPerformanceStats()
  }, [loadPerformanceStats])

  const handleClearCache = useCallback(async () => {
    setClearingCache(true)
    try {
      const result = await apiClient.clearToolListCache()
      if (result.ok && result.data?.success) {
        success("Tool cache cleared", result.data.message)
        await loadPerformanceStats(true)
      } else {
        showError("Failed to clear tool cache", result.error || result.data?.message || "Unknown error")
      }
    } catch (error) {
      showError("Failed to clear tool cache", error instanceof Error ? error.message : "Unknown error")
    } finally {
      setClearingCache(false)
    }
  }, [loadPerformanceStats, showError, success])

  const poolSize = stats?.adapterPool?.size ?? 0
  const poolMaxSize = stats?.adapterPool?.maxSize ?? 0
  const poolUtilization = poolMaxSize > 0 ? Math.min(100, (poolSize / poolMaxSize) * 100) : 0

  const cacheSize = stats?.toolListCache?.size ?? 0
  const cacheHits = stats?.toolListCache?.hits ?? 0
  const cacheMisses = stats?.toolListCache?.misses ?? 0
  const cacheTotal = cacheHits + cacheMisses
  const cacheHitRate = stats?.toolListCache?.hitRate ?? 0
  const cacheHitRatePercentage = Math.min(100, Math.max(0, cacheHitRate * 100))

  const routerTotalRequests =
    typeof stats?.router?.totalRequests === "number" ? stats.router.totalRequests : null
  const lastRefreshLabel = stats?.timestamp ? new Date(stats.timestamp).toLocaleTimeString() : "No data"
  const hitRateColorClass = getHitRateColor(cacheHitRate)

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav.performance") || "Performance"}
        description="Observe adapter pool, tool cache efficiency, and router load in real time."
        icon={<Zap className="h-6 w-6 text-primary" />}
        actions={
          <Button variant="outline" onClick={() => void handleRefresh()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh") || "Refresh"}
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Adapter Pool</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="font-mono text-2xl font-bold">{stats ? `${poolSize} / ${poolMaxSize}` : "—"}</div>
            <p className="text-sm text-muted-foreground">{stats ? `${poolSize} / ${poolMaxSize} active` : "No data"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Tool Cache</CardTitle>
            <Badge variant="outline" className={hitRateColorClass}>
              {stats ? `${cacheHitRatePercentage.toFixed(1)}%` : "No data"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className={`font-mono text-2xl font-bold ${hitRateColorClass}`}>
              {stats ? `${cacheHitRatePercentage.toFixed(1)}%` : "—"}
            </div>
            <p className="text-sm text-muted-foreground">
              {stats ? `${cacheSize} entries • ${cacheHits} hits / ${cacheMisses} misses` : "No data"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Router</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="font-mono text-2xl font-bold">{routerTotalRequests ?? "—"}</div>
            <p className="text-sm text-muted-foreground">
              {routerTotalRequests !== null ? "total requests routed" : "No data"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Cache Details</CardTitle>
          <Button variant="outline" size="sm" onClick={() => void handleClearCache()} disabled={clearingCache}>
            {clearingCache ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Clear Cache
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {stats ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Hit rate</span>
                  <span className={`font-medium ${hitRateColorClass}`}>{`${cacheHitRatePercentage.toFixed(1)}%`}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${cacheHitRatePercentage.toFixed(0)}%` }}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-sm text-muted-foreground">Hits</p>
                  <p className="font-mono text-2xl font-bold">{cacheHits}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Misses</p>
                  <p className="font-mono text-2xl font-bold">{cacheMisses}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total</p>
                  <p className="font-mono text-2xl font-bold">{cacheTotal}</p>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No data</p>
          )}

          <p className="text-sm text-muted-foreground">Last refresh: {lastRefreshLabel}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Adapter Pool</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {stats ? (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Current utilization</p>
                  <p className="font-mono text-2xl font-bold">
                    {poolSize} / {poolMaxSize}
                  </p>
                </div>
                <span className="text-sm font-medium text-muted-foreground">{poolUtilization.toFixed(0)}%</span>
              </div>

              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${poolUtilization.toFixed(0)}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No data</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
