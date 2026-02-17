import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import PageHeader from "@/components/PageHeader"
import { apiClient } from "../api/client"
import { useToastHelpers } from "../components/ui/toast"
import { useI18n } from "@/i18n"
import { RefreshCw, Package, Download, HardDrive, Shield, Power } from "lucide-react"

type DeployStatus = {
  diskUsageBytes: number
  activeProcesses: number
  limits: any
}

type DeployPolicy = {
  limits: any
  authorizationMode: string
  activeProcesses: number
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function formatDate(value?: string): string {
  if (!value) return "—"
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return value
  return dt.toLocaleString()
}

function formatLimitsSummary(limits: any): string {
  if (!limits || typeof limits !== "object") return "N/A"
  const entries = Object.entries(limits).filter(([, value]) => value !== undefined && value !== null)
  if (entries.length === 0) return "N/A"
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" • ")
}

export default function DeploymentSection() {
  const { t } = useI18n()
  const { success, error: showError } = useToastHelpers()

  const [resolveSource, setResolveSource] = useState("")
  const [resolveLoading, setResolveLoading] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolvedPackage, setResolvedPackage] = useState<any | null>(null)

  const [installPackageSpec, setInstallPackageSpec] = useState("")
  const [installTimeout, setInstallTimeout] = useState("")
  const [installLoading, setInstallLoading] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installResult, setInstallResult] = useState<{ success: boolean; result: any } | null>(null)

  const [statusLoading, setStatusLoading] = useState(false)
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null)
  const [deployPolicy, setDeployPolicy] = useState<DeployPolicy | null>(null)

  const [instancesLoading, setInstancesLoading] = useState(false)
  const [instances, setInstances] = useState<Record<string, any>>({})
  const [autostartCount, setAutostartCount] = useState(0)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const loadDeployCards = useCallback(async () => {
    setStatusLoading(true)
    try {
      const [statusResult, policyResult] = await Promise.all([
        apiClient.getDeployStatus(),
        apiClient.getDeployPolicy(),
      ])

      if (statusResult.ok && statusResult.data) {
        setDeployStatus(statusResult.data)
      } else {
        showError("Failed to load deployment status", statusResult.error || "Unknown error")
      }

      if (policyResult.ok && policyResult.data) {
        setDeployPolicy(policyResult.data)
      } else {
        showError("Failed to load deployment policy", policyResult.error || "Unknown error")
      }
    } catch (err) {
      showError("Failed to load deployment cards", err instanceof Error ? err.message : "Unknown error")
    } finally {
      setStatusLoading(false)
    }
  }, [showError])

  const loadPersistedInstances = useCallback(async () => {
    setInstancesLoading(true)
    try {
      const result = await apiClient.getPersistedInstances()
      if (result.ok && result.data) {
        setInstances(result.data.instances || {})
        setAutostartCount(result.data.autostartCount || 0)
      } else {
        showError("Failed to load persisted instances", result.error || "Unknown error")
      }
    } catch (err) {
      showError("Failed to load persisted instances", err instanceof Error ? err.message : "Unknown error")
    } finally {
      setInstancesLoading(false)
    }
  }, [showError])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadDeployCards(), loadPersistedInstances()])
  }, [loadDeployCards, loadPersistedInstances])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const handleResolve = async () => {
    const source = resolveSource.trim()
    if (!source) {
      const msg = "Please enter a package source"
      setResolveError(msg)
      showError("Resolve failed", msg)
      return
    }

    setResolveLoading(true)
    setResolveError(null)
    try {
      const result = await apiClient.resolvePackage(source)
      if (result.ok && result.data?.success) {
        setResolvedPackage(result.data.package ?? null)
        success("Package resolved", "Source has been resolved successfully")
      } else {
        const msg = result.error || "Unable to resolve package"
        setResolvedPackage(null)
        setResolveError(msg)
        showError("Resolve failed", msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to resolve package"
      setResolvedPackage(null)
      setResolveError(msg)
      showError("Resolve failed", msg)
    } finally {
      setResolveLoading(false)
    }
  }

  const handleInstall = async () => {
    const packageSpec = installPackageSpec.trim()
    if (!packageSpec) {
      const msg = "Please enter a package spec"
      setInstallError(msg)
      showError("Install failed", msg)
      return
    }

    let timeoutValue: number | undefined
    if (installTimeout.trim()) {
      const parsed = Number(installTimeout.trim())
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const msg = "Timeout must be a positive number"
        setInstallError(msg)
        showError("Install failed", msg)
        return
      }
      timeoutValue = parsed
    }

    setInstallLoading(true)
    setInstallError(null)
    try {
      const result = await apiClient.installPackage(packageSpec, timeoutValue)
      if (result.ok && result.data) {
        setInstallResult({ success: !!result.data.success, result: result.data.result })
        if (result.data.success) {
          success("Package installed", "Installation completed")
        } else {
          const msg = typeof result.data.result?.error === "string" ? result.data.result.error : "Installation failed"
          setInstallError(msg)
          showError("Install failed", msg)
        }
      } else {
        const msg = result.error || "Installation failed"
        setInstallResult(null)
        setInstallError(msg)
        showError("Install failed", msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Installation failed"
      setInstallResult(null)
      setInstallError(msg)
      showError("Install failed", msg)
    } finally {
      setInstallLoading(false)
    }
  }

  const handleAutostartToggle = async (id: string, current: boolean) => {
    setTogglingId(id)
    try {
      const result = await apiClient.setInstanceAutostart(id, !current)
      if (result.ok && result.data?.success) {
        success("Autostart updated", `${id} autostart ${!current ? "enabled" : "disabled"}`)
        await loadPersistedInstances()
      } else {
        showError("Autostart update failed", result.error || "Unknown error")
      }
    } catch (err) {
      showError("Autostart update failed", err instanceof Error ? err.message : "Unknown error")
    } finally {
      setTogglingId(null)
    }
  }

  const persistedEntries = Object.entries(instances)
  const installDir =
    installResult?.result?.installDir ??
    installResult?.result?.result?.installDir ??
    installResult?.result?.path ??
    "—"

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav.deployment") || "Deployment"}
        description="Resolve package sources, install templates, and manage persisted deployment instances."
        icon={<Package className="h-6 w-6 text-primary" />}
        actions={
          <Button variant="outline" onClick={() => void refreshAll()} disabled={statusLoading || instancesLoading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${(statusLoading || instancesLoading) ? "animate-spin" : ""}`} />
            {t("common.refresh") || "Refresh"}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Package Resolver
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="resolve-source">GitHub URL or npm package</Label>
              <Input
                id="resolve-source"
                value={resolveSource}
                onChange={(event) => setResolveSource(event.target.value)}
                placeholder="https://github.com/org/repo or @scope/package"
              />
            </div>
            <Button onClick={handleResolve} disabled={resolveLoading} className="w-full md:w-auto">
              {resolveLoading ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Resolving...
                </>
              ) : (
                "Resolve"
              )}
            </Button>
          </div>

          {resolveError && <p className="text-sm text-destructive">{resolveError}</p>}

          {resolvedPackage && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">name</p>
                  <p className="font-medium break-all">{resolvedPackage.name || "—"}</p>
                </div>
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">transport</p>
                  <p className="font-medium">{resolvedPackage.transport || "—"}</p>
                </div>
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">command</p>
                  <p className="font-medium break-all">{resolvedPackage.command || "—"}</p>
                </div>
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">args</p>
                  <p className="font-medium break-all">
                    {Array.isArray(resolvedPackage.args) ? resolvedPackage.args.join(" ") : "—"}
                  </p>
                </div>
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">source</p>
                  <p className="font-medium break-all">{resolvedPackage.source || "—"}</p>
                </div>
                <div className="p-4 rounded-md border bg-muted/20">
                  <p className="text-muted-foreground">installDir</p>
                  <p className="font-medium break-all">{resolvedPackage.installDir || "—"}</p>
                </div>
              </div>
              <pre className="bg-muted/50 p-3 rounded-md text-sm font-mono overflow-auto max-h-60">
                {JSON.stringify(resolvedPackage, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Package Installer
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-3 items-end">
            <div className="space-y-2">
              <Label htmlFor="install-package">npm package spec</Label>
              <Input
                id="install-package"
                value={installPackageSpec}
                onChange={(event) => setInstallPackageSpec(event.target.value)}
                placeholder="@modelcontextprotocol/server-filesystem"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="install-timeout">Timeout (ms)</Label>
              <Input
                id="install-timeout"
                type="number"
                min={1}
                value={installTimeout}
                onChange={(event) => setInstallTimeout(event.target.value)}
                placeholder="60000"
              />
            </div>
            <Button onClick={handleInstall} disabled={installLoading} className="w-full md:w-auto">
              {installLoading ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Install
                </>
              )}
            </Button>
          </div>

          {installError && <p className="text-sm text-destructive">{installError}</p>}

          {installResult && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={installResult.success ? "secondary" : "destructive"}>
                  {installResult.success ? "Success" : "Failed"}
                </Badge>
                <span className="text-muted-foreground">installDir</span>
                <span className="font-medium break-all">{String(installDir)}</span>
              </div>
              <pre className="bg-muted/50 p-3 rounded-md text-sm font-mono overflow-auto max-h-60">
                {JSON.stringify(installResult, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Sandbox Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Disk Usage</span>
              <span className="font-medium">{formatBytes(deployStatus?.diskUsageBytes || 0)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Active Processes</span>
              <span className="font-medium">{deployStatus?.activeProcesses ?? 0}</span>
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">Limits</p>
              <p className="text-xs text-foreground/80">{formatLimitsSummary(deployStatus?.limits)}</p>
            </div>
            <pre className="bg-muted/50 p-3 rounded-md text-sm font-mono overflow-auto max-h-60">
              {JSON.stringify(deployStatus || {}, null, 2)}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Deployment Policy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Authorization Mode</span>
              <span className="font-medium">{deployPolicy?.authorizationMode || "N/A"}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Active Processes</span>
              <span className="font-medium">{deployPolicy?.activeProcesses ?? deployStatus?.activeProcesses ?? 0}</span>
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">Current Limits</p>
              <p className="text-xs text-foreground/80">{formatLimitsSummary(deployPolicy?.limits)}</p>
            </div>
            <pre className="bg-muted/50 p-3 rounded-md text-sm font-mono overflow-auto max-h-60">
              {JSON.stringify(deployPolicy || {}, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>Persisted Instances</span>
            <Badge variant="secondary">Autostart: {autostartCount}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>ID</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Autostart</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!instancesLoading && persistedEntries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No persisted instances found.
                  </TableCell>
                </TableRow>
              )}

              {instancesLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    Loading persisted instances...
                  </TableCell>
                </TableRow>
              )}

              {!instancesLoading &&
                persistedEntries.map(([id, instance]) => {
                  const isAutostart = !!instance?.autostart
                  const templateName =
                    instance?.templateName ||
                    instance?.template?.name ||
                    instance?.templateId ||
                    instance?.name ||
                    "—"
                  const createdAt = formatDate(instance?.createdAt || instance?.created_at || instance?.created)
                  const lastStartedAt = formatDate(
                    instance?.lastStartedAt || instance?.last_started_at || instance?.lastStarted,
                  )
                  const toggling = togglingId === id

                  return (
                    <TableRow key={id}>
                      <TableCell className="font-mono text-xs">{id}</TableCell>
                      <TableCell>{templateName}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant={isAutostart ? "default" : "outline"}
                          onClick={() => void handleAutostartToggle(id, isAutostart)}
                          disabled={toggling}
                        >
                          {toggling ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Power className="mr-2 h-4 w-4" />
                          )}
                          {isAutostart ? "On" : "Off"}
                        </Button>
                      </TableCell>
                      <TableCell>{createdAt}</TableCell>
                      <TableCell>{lastStartedAt}</TableCell>
                    </TableRow>
                  )
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
