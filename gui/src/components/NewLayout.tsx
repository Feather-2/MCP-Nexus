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
      <header className="sticky top-0 z-40 w-full border-b bg-background">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开菜单">
                <Menu className="h-5 w-5" />
              </Button>
              <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary text-primary-foreground shadow-sm">
                <Zap className="h-4 w-4" />
              </div>
              <div className="hidden sm:block">
                <h1 className="text-lg font-bold tracking-tight">
                  PB MCP Nexus
                </h1>
              </div>
            </div>
            <div className="flex-1 hidden md:flex items-center max-w-md ml-8">
              <div className="relative w-full group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground transition-colors" />
                <Input
                  type="search"
                  placeholder="搜索..."
                  className="w-full bg-muted/40 border-transparent pl-10 md:w-[320px] lg:w-[400px] h-9 rounded-lg focus-visible:bg-background transition-all"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-muted/40 rounded-lg p-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-md h-8 w-8 text-foreground/70"
                  onClick={() => setShowPreferences(true)}
                  title="用户偏好设置"
                >
                  <User className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-md h-8 w-8 text-foreground/70"
                  onClick={toggleTheme}
                  title={isDarkMode ? '切换到明亮模式' : '切换到暗黑模式'}
                >
                  {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </div>
              <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-foreground/40 border">
                <span className="text-[10px] font-bold uppercase">PB</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Layout */}
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-10 py-10">
          {/* Sidebar desktop */}
          <aside className="hidden md:block">
            <div className="sticky top-24">
              <nav className="space-y-6">
                <div>
                  <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30">导航</div>
                  <div className="space-y-0.5">
                    {navItems.slice(0, 3).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors ${location.pathname === path
                          ? 'bg-primary/5 text-primary font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
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
                  <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30">能力</div>
                  <div className="space-y-0.5">
                    {navItems.slice(3, 7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors ${location.pathname === path
                          ? 'bg-primary/5 text-primary font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
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
                  <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/30">系统</div>
                  <div className="space-y-0.5">
                    {navItems.slice(7).map(({ path, label, icon: Icon }) => (
                      <button
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors ${location.pathname === path
                          ? 'bg-primary/5 text-primary font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
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
          <main className="min-h-[85vh]">
            <div className="space-y-8">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-[280px] bg-background border-r shadow-2xl p-6 flex flex-col animate-in slide-in-from-left duration-300">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                  <Zap className="h-6 w-6" />
                </div>
                <span className="font-bold text-lg">Nexus</span>
              </div>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setSidebarOpen(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="space-y-1 overflow-auto flex-1">
              {navItems.map(({ path, label, icon: Icon }) => (
                <button
                  key={path}
                  className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl text-left transition-all duration-200 ${location.pathname === path
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground/70 hover:bg-muted'
                    }`}
                  onClick={() => { navigate(path); setSidebarOpen(false); }}
                >
                  <Icon className="h-5 w-5" />
                  <span className="font-semibold">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* User Preferences Dialog */}
      <UserPreferencesDialog open={showPreferences} onOpenChange={setShowPreferences} />

      {/* Footer */}
      <footer className="border-t mt-12 py-10 text-center relative z-10">
        <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
          <p className="text-sm font-medium text-muted-foreground/60 flex items-center justify-center gap-2">
            <span>PB MCP Nexus</span>
            <span className="h-1 w-1 rounded-full bg-border" />
            <span>2025 Edition</span>
            <span className="h-1 w-1 rounded-full bg-border" />
            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded text-[10px] font-bold">STABLE</span>
          </p>
        </div>
      </footer>
    </div>

  );
};

export default Layout;