"use client"

import { useState } from "react"
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "@/components/ui/toaster"

import { ToastProvider } from "@/components/ui/toast"
import { I18nProvider } from "@/i18n"
import Topbar from "@/components/Topbar"

// Import all section components
import DashboardSection from './pages/Dashboard'
import ServicesSection from './pages/Services'
import TemplatesSection from './pages/Templates'
import AuthSection from './pages/Authentication'
import MonitoringSection from './pages/Monitoring'
import CatalogSection from './pages/McpCatalog'
import ConsoleSection from './pages/McpConsole'
import GeneratorSection from './pages/GeneratorV2'
import SettingsSection from './pages/Settings'
import IntegrationsSection from './pages/Integrations'
import OrchestratorSection from './pages/Orchestrator'

type PageKey =
  | "dashboard"
  | "services"
  | "templates"
  | "auth"
  | "monitoring"
  | "catalog"
  | "console"
  | "integrations"
  | "generator"
  | "orchestrator"
  | "settings"

function App() {
  const [currentPage, setCurrentPage] = useState<PageKey>("dashboard")

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard":
        return <DashboardSection onNavigate={setCurrentPage} />
      case "services":
        return <ServicesSection />
      case "templates":
        return <TemplatesSection />
      case "auth":
        return <AuthSection />
      case "monitoring":
        return <MonitoringSection />
      case "catalog":
        return <CatalogSection />
      case "console":
        return <ConsoleSection />
      case "integrations":
        return <IntegrationsSection />
      case "generator":
        return <GeneratorSection />
      case "orchestrator":
        return <OrchestratorSection />
      case "settings":
        return <SettingsSection />
      default:
        return <DashboardSection onNavigate={setCurrentPage} />
    }
  }

  return (
    <I18nProvider>
        <ToastProvider>
          <SidebarProvider>
            <div className="min-h-screen flex w-full bg-background">
              <AppSidebar onNavigate={setCurrentPage} active={currentPage} />
              <main className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center gap-2 p-4 border-b">
                  <SidebarTrigger />
                  <Topbar />
                </div>
                <div className="flex-1 overflow-auto p-6">
                  {renderPage()}
                </div>
              </main>
            </div>
            <Toaster />
          </SidebarProvider>
        </ToastProvider>
      </I18nProvider>
  )
}

export default App
