import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useI18n } from "@/i18n"
import {
  ActivitySquare,
  Boxes,
  Cable,
  Cog,
  Database,
  FileCode2,
  Home,
  KeySquare,
  LogIn as Logs,
  Plug,
  Wand2,
  Workflow
} from "lucide-react"

type Props = {
  onNavigate?: (
    key: "dashboard" | "services" | "templates" | "auth" | "monitoring" | "catalog" | "console" | "integrations" | "generator" | "orchestrator" | "settings",
  ) => void
  active?: string
}

export function AppSidebar({ onNavigate, active }: Props) {
  const { t } = useI18n()
  const items = [
    { key: "dashboard", title: t('nav.dashboard'), icon: Home },
    { key: "services", title: t('nav.services'), icon: Database },
    { key: "templates", title: t('nav.templates'), icon: FileCode2 },
    { key: "auth", title: t('nav.auth'), icon: KeySquare },
    { key: "monitoring", title: t('nav.monitoring'), icon: ActivitySquare },
    { key: "catalog", title: t('nav.catalog'), icon: Boxes },
    { key: "console", title: t('nav.console'), icon: Cable },
    { key: "integrations", title: t('nav.integrations'), icon: Plug },
    { key: "generator", title: t('nav.generator'), icon: Wand2 },
    { key: "orchestrator", title: t('nav.orchestrator'), icon: Workflow },
    { key: "settings", title: t('nav.settings'), icon: Cog },
  ] as const

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-xs font-bold">
            PB
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <div className="truncate text-base font-semibold tracking-tight">MCP Nexus</div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">Console</span>
              <Badge variant="secondary" className="text-[10px]">Preview</Badge>
            </div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">{t('sidebar.navigation')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton
                    isActive={active === item.key}
                    onClick={() => onNavigate?.(item.key as any)}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span className="group-data-[collapsible=icon]:hidden">{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">{t('sidebar.insights')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="px-2 py-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Logs className="size-4 shrink-0" />
                <span className="group-data-[collapsible=icon]:hidden">{t('sidebar.liveLogs')}</span>
              </div>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          <Separator className="mb-2" />
          {t('nav.footer.hint') || 'Press Ctrl+B to toggle sidebar'}
        </div>
      </SidebarFooter>

    </Sidebar>
  )
}

export { AppSidebar as default }
