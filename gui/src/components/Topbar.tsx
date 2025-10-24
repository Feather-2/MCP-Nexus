"use client"

import React from 'react'
import { useI18n } from '@/i18n'
import { Bell, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

export const Topbar: React.FC = () => {
  const { t } = useI18n()

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="ml-2 flex w-full max-w-[520px] items-center gap-2 rounded-full border pl-3 pr-1 py-1">
        <Search className="size-4 text-muted-foreground" />
        <Input placeholder={t('header.search') || 'Search services, templates, logs...'} className="border-0 shadow-none focus-visible:ring-0" />
        <Button size="sm" variant="secondary" className="rounded-full">
          {t('dashboard.refresh')}
        </Button>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <LanguageSwitcher />
        <Button variant="ghost" size="icon" className="rounded-full">
          <Bell className="size-5" />
          <span className="sr-only">notifications</span>
        </Button>
        <Avatar className="size-8">
          <AvatarFallback>PB</AvatarFallback>
        </Avatar>
      </div>
    </div>
  )
}

export default Topbar


