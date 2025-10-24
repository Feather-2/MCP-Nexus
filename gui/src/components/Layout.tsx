import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import './Layout.css';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [isDarkMode, setIsDarkMode] = useState(false);

  const navItems = [
    { path: '/dashboard', label: '仪表板', icon: '📊' },
    { path: '/services', label: '服务管理', icon: '🛠️' },
    { path: '/templates', label: '模板管理', icon: '📋' },
    { path: '/auth', label: '认证管理', icon: '🔐' },
    { path: '/monitoring', label: '监控中心', icon: '📈' },
    { path: '/settings', label: '系统设置', icon: '⚙️' },
  ];

  const toggleTheme = () => {
    const newDarkMode = !isDarkMode;
    setIsDarkMode(newDarkMode);
    document.documentElement.className = newDarkMode ? 'dark' : '';
  };

  return (
    <div className={`app-layout ${isDarkMode ? 'dark' : 'light'}`}>
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">Paper Burner MCP Gateway</span>
          </div>
          
          <div className="header-actions">
            <button className="theme-toggle" onClick={toggleTheme}>
              {isDarkMode ? '🌞' : '🌙'}
            </button>
            <div className="user-menu">
              <span className="user-avatar">👤</span>
            </div>
          </div>
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar */}
        <nav className="sidebar">
          <div className="nav-items">
            {navItems.map(({ path, label, icon }) => (
              <button
                key={path}
                className={`nav-item ${location.pathname === path ? 'active' : ''}`}
                onClick={() => navigate(path)}
              >
                <span className="nav-icon">{icon}</span>
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Main Content */}
        <main className="main-content">
          <div className="content-wrapper">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;