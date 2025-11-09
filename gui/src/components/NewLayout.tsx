import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PreferencesManager } from '../utils/persistence';
import { UserPreferencesDialog } from './UserPreferencesDialog';
import { Input } from './ui/input';
import { Button } from './ui/button';
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
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开菜单">
                <Menu className="h-5 w-5" />
              </Button>
              <div className="flex items-center justify-center h-8 w-8 rounded-md bg-primary text-primary-foreground">
                <Zap className="h-5 w-5" />
              </div>
              <div className="hidden sm:block">
                <h1 className="text-lg font-semibold tracking-tight">PB MCP Nexus</h1>
              </div>
            </div>
            <div className="flex-1 hidden md:flex items-center max-w-md ml-6">
              <div className="relative w-full">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="搜索..."
                  className="w-full bg-muted/50 pl-9 md:w-[300px] lg:w-[400px] rounded-lg focus-visible:bg-background transition-colors"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowPreferences(true)}
                title="用户偏好设置"
              >
                <User className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                title={isDarkMode ? '切换到明亮模式' : '切换到暗黑模式'}
              >
                {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
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
            <div className="sticky top-20">
              <nav className="space-y-6 px-2">
                <div>
                  <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-foreground/70">总览</div>
                  <div className="space-y-1">
                    {navItems.slice(0,3).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200 ${
                          location.pathname === path
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-foreground/70">MCP</div>
                  <div className="space-y-1">
                    {navItems.slice(3,7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200 ${
                          location.pathname === path
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-foreground/70">系统</div>
                  <div className="space-y-1">
                    {navItems.slice(7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200 ${
                          location.pathname === path
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                        onClick={() => navigate(path)}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </nav>
            </div>
          </aside>

          {/* Main Content */}
          <main className="min-h-[80vh] py-4">
            {children}
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
                <span className="font-semibold">PB MCP Nexus</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
                <X className="h-5 w-5" />
              </Button>
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
          PB MCP Nexus · 简洁 · 高效 · 可视化
        </div>
      </footer>
    </div>
  );
};

export default Layout;