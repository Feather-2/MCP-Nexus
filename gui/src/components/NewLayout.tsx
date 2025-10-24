import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PreferencesManager } from '../utils/persistence';
import { UserPreferencesDialog } from './UserPreferencesDialog';
import { Input } from './ui/input';
import {
  BarChart3,
  Settings,
  FileText,
  Shield,
  Activity,
  Cog,
  Zap,
  Sun,
  Moon,
  User,
  Terminal,
  ShoppingBag,
  Menu,
  X,
  Search
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [showPreferences, setShowPreferences] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const preferences = PreferencesManager.getPreferences();
    return preferences.theme === 'dark' ||
           (preferences.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  const navItems = [
    { path: '/dashboard', label: '仪表板', icon: BarChart3 },
    { path: '/services', label: '服务管理', icon: Settings },
    { path: '/templates', label: '模板管理', icon: FileText },
    { path: '/catalog', label: 'MCP 市场', icon: ShoppingBag },
    { path: '/auth', label: '认证管理', icon: Shield },
    { path: '/monitoring', label: '监控中心', icon: Activity },
    { path: '/mcp', label: 'MCP 控制台', icon: Terminal },
    { path: '/settings', label: '系统设置', icon: Cog },
  ];

  // Initialize theme on component mount
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  // Listen for system theme changes
  useEffect(() => {
    const preferences = PreferencesManager.getPreferences();
    if (preferences.theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        setIsDarkMode(e.matches);
      };
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, []);

  const toggleTheme = () => {
    const newDarkMode = !isDarkMode;
    setIsDarkMode(newDarkMode);
    document.documentElement.classList.toggle('dark', newDarkMode);

    // Save theme preference
    PreferencesManager.setPreferences({
      theme: newDarkMode ? 'dark' : 'light'
    });
  };

  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      {/* Topbar */}
      <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button className="md:hidden p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setSidebarOpen(true)} aria-label="打开菜单">
                <Menu className="h-5 w-5" />
              </button>
              <Zap className="h-5 w-5 text-primary" />
              <div className="hidden sm:block">
                <h1 className="text-[17px] font-semibold text-foreground tracking-tight">PB MCP Gateway</h1>
              </div>
            </div>
            <div className="flex-1 hidden md:flex items-center max-w-2xl">
              <div className="relative w-full">
                <Input className="pl-10" placeholder="搜索：服务、模板、日志..." />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowPreferences(true)}
                className="p-2 rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 transition-colors"
                title="用户偏好设置"
              >
                <User className="h-5 w-5" />
              </button>
              <button
                onClick={toggleTheme}
                className="p-2 rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 transition-colors"
                title={isDarkMode ? '切换到明亮模式' : '切换到暗黑模式'}
              >
                {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>
              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-foreground/70">
                <User className="h-4 w-4" />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Layout */}
      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6 py-6">
          {/* Sidebar desktop */}
          <aside className="hidden md:block">
            <div className="sticky top-24 p-3 bg-card rounded-lg border">
              <nav className="space-y-4">
                <div>
                  <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">总览</div>
                  <div className="mt-2 space-y-1">
                    {navItems.slice(0,3).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group w-full flex items-center gap-3 px-3 py-2 text-left transition-colors duration-150 border-l-2 ${
                          location.pathname === path
                            ? 'border-l-primary text-foreground bg-muted/20'
                            : 'border-l-transparent text-foreground/80 hover:bg-muted/30 hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4.5 w-4.5" />
                        <span className="text-sm">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">MCP</div>
                  <div className="mt-2 space-y-1">
                    {navItems.slice(3,7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group w-full flex items-center gap-3 px-3 py-2 text-left transition-colors duration-150 border-l-2 ${
                          location.pathname === path
                            ? 'border-l-primary text-foreground bg-muted/20'
                            : 'border-l-transparent text-foreground/80 hover:bg-muted/30 hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4.5 w-4.5" />
                        <span className="text-sm">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">系统</div>
                  <div className="mt-2 space-y-1">
                    {navItems.slice(7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group w-full flex items-center gap-3 px-3 py-2 text-left transition-colors duration-150 border-l-2 ${
                          location.pathname === path
                            ? 'border-l-primary text-foreground bg-muted/20'
                            : 'border-l-transparent text-foreground/80 hover:bg-muted/30 hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4.5 w-4.5" />
                        <span className="text-sm">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </nav>
            </div>
          </aside>

          {/* Main Content */}
          <main className="min-h-[70vh]">
            <div className="p-6 md:p-8 bg-card rounded-lg border">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-card border-r shadow-xl p-4 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Zap className="h-5 w-5" />
                </div>
                <span className="font-semibold">PB MCP Gateway</span>
              </div>
              <button className="p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setSidebarOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-1 overflow-auto">
              {navItems.map(({ path, label, icon: Icon }) => (
                <button
                  key={path}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors duration-150 border-l-2 ${
                    location.pathname === path
                      ? 'border-l-primary text-foreground bg-muted/30'
                      : 'border-l-transparent text-foreground/80 hover:bg-muted/30 hover:text-foreground'
                  }`}
                  onClick={() => { navigate(path); setSidebarOpen(false); }}
                >
                  <Icon className="h-5 w-5" />
                  <span className="font-medium">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* User Preferences Dialog */}
      <UserPreferencesDialog open={showPreferences} onOpenChange={setShowPreferences} />

      {/* Footer */}
      <footer className="border-t py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
          PB MCP Gateway · 简洁 · 高效 · 可视化
        </div>
      </footer>
    </div>
  );
};

export default Layout;