"use client"

import * as React from "react"

interface ThemeProviderProps {
  children: React.ReactNode
  attribute?: string
  defaultTheme?: string
  enableSystem?: boolean
}

export function ThemeProvider({ 
  children, 
  attribute = "class", 
  defaultTheme = "system", 
  enableSystem = true 
}: ThemeProviderProps) {
  React.useEffect(() => {
    // Simple theme detection and application
    const root = document.documentElement
    
    if (defaultTheme === "system" && enableSystem) {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      root.setAttribute(attribute, systemTheme)
    } else {
      root.setAttribute(attribute, defaultTheme)
    }
  }, [attribute, defaultTheme, enableSystem])

  return <>{children}</>
}