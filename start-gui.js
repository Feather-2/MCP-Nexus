#!/usr/bin/env node
/**
 *  MCP Nexus - GUI 启动器
 * 使用 GitHub Primer Design System 风格
 */

import { createGateway } from './dist/PbMcpGateway.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startGUI() {
  console.log('🎨  MCP Nexus - GitHub Primer GUI\n');

  // 创建网关实例
  console.log('⚡ 启动网关服务...');
  const gateway = createGateway({
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    logLevel: 'info',
    configPath: join(__dirname, 'config', 'gateway.json')
  });

  try {
    // 启动网关
    await gateway.start();

    console.log('✅ 网关启动成功！');
    console.log(`🌐 Web GUI: http://localhost:19233`);
    console.log(`📋 GitHub Primer Design System 风格界面`);
    console.log('');

    // 显示可用功能
    console.log('🎯 可用功能:');
    console.log('  📊 仪表板        - GitHub Actions 风格的状态展示');
    console.log('  🛠️  服务管理      - GitHub Issues 风格的列表视图');
    console.log('  📋 模板管理      - GitHub Marketplace 风格的卡片');
    console.log('  🔐 认证管理      - GitHub Token 管理风格');
    console.log('  📈 监控中心      - 终端风格的实时日志');
    console.log('  ⚙️  系统设置      - GitHub 设置页面风格');
    console.log('');

    // 显示设计特色
    console.log('🎨 设计特色:');
    console.log('  • 简洁专业的开发者界面');
    console.log('  • GitHub 一致的交互体验');
    console.log('  • 响应式设计，支持各种屏幕');
    console.log('  • 深色/浅色主题自动切换');
    console.log('  • 直观的状态指示和反馈');
    console.log('');

    console.log('🚀 在浏览器中打开 http://localhost:19233 开始使用！');
    console.log('');

    // 等待用户输入退出
    console.log('按 Ctrl+C 停止服务...');

    // 优雅退出处理
    const exitHandler = async (signal) => {
      console.log(`\n📝 收到 ${signal} 信号，正在停止服务...`);
      try {
        await gateway.stop();
        console.log('✅ 服务已停止');
        process.exit(0);
      } catch (error) {
        console.error('❌ 停止服务时发生错误:', error.message);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => exitHandler('SIGINT'));
    process.on('SIGTERM', () => exitHandler('SIGTERM'));

    // 保持进程运行
    process.stdin.resume();

  } catch (error) {
    console.error('❌ 启动 GUI 失败:', error.message);
    console.error('');
    console.error('💡 解决建议:');
    console.error('  1. 确保运行了 npm run build');
    console.error('  2. 检查端口 19233 是否被占用');
    console.error('  3. 确认所有依赖已正确安装');
    process.exit(1);
  }
}

// 显示启动信息
console.log('╭─────────────────────────────────────────────────╮');
console.log('│  🎨  MCP Nexus - GitHub GUI      │');
console.log('│                                                 │');
console.log('│  采用 GitHub Primer Design System              │');
console.log('│  专为开发者设计的现代化管理界面                 │');
console.log('╰─────────────────────────────────────────────────╯');
console.log('');

// 启动 GUI
startGUI().catch((error) => {
  console.error('❌ GUI 启动失败:', error);
  process.exit(1);
});