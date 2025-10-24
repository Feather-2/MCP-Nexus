#!/usr/bin/env node
/**
 * Paper Burner MCP Gateway - 快速开始示例
 * 
 * 这个脚本演示了如何使用 MCP Gateway 的基本功能
 */

import { createGateway } from './dist/PbMcpGateway.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function quickStart() {
  console.log('🚀 Paper Burner MCP Gateway - 快速开始示例\n');

  // 创建网关实例
  console.log('📋 步骤 1: 创建网关实例...');
  const gateway = createGateway({
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    logLevel: 'info',
    configPath: join(__dirname, 'config', 'gateway.json')
  });

  try {
    // 启动网关
    console.log('🔄 步骤 2: 启动网关服务...');
    await gateway.start();
    console.log('✅ 网关启动成功！');
    console.log(`🌐 HTTP API: http://localhost:19233`);
    console.log(`📊 健康检查: http://localhost:19233/health\n`);

    // 查看内置模板
    console.log('📦 步骤 3: 查看可用的服务模板:');
    const templates = await gateway.listTemplates();
    templates.forEach((template, index) => {
      console.log(`  ${index + 1}. ${template.name}`);
      console.log(`     传输方式: ${template.transport}`);
      console.log(`     描述: ${template.description || 'N/A'}`);
      console.log(`     能力: ${template.capabilities?.join(', ') || 'N/A'}\n`);
    });

    // 创建一个示例服务
    console.log('🛠️  步骤 4: 创建内存存储服务...');
    const serviceId = await gateway.createService('memory');
    console.log(`✅ 服务创建成功！服务ID: ${serviceId}`);

    // 生成认证令牌
    console.log('\n🔐 步骤 5: 生成访问令牌...');
    const token = await gateway.generateToken('demo-user', ['read', 'write'], 1);
    console.log(`✅ Token 生成成功: ${token.substring(0, 20)}...`);

    // 查看系统状态
    console.log('\n📊 步骤 6: 系统运行状态:');
    const services = await gateway.listServices();
    const health = await gateway.getHealthStatus();
    
    console.log(`  网关状态: ${health.gateway.status}`);
    console.log(`  运行时间: ${Math.round(health.gateway.uptime / 1000)}秒`);
    console.log(`  活跃服务: ${services.length}个`);
    console.log(`  健康服务: ${health.metrics.healthyServices}/${health.metrics.totalServices}`);

    console.log('\n🎉 快速开始完成！');
    console.log('\n📝 接下来你可以:');
    console.log('  1. 访问 http://localhost:19233/health 查看系统健康状态');
    console.log('  2. 使用 curl 调用 REST API');
    console.log('  3. 运行 npm run cli 使用命令行工具');
    console.log('  4. 查看 README.md 了解更多功能');

    // 等待用户输入然后关闭
    console.log('\n按 Enter 键停止网关...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', async () => {
      console.log('\n🔄 正在停止网关...');
      await gateway.stop();
      console.log('✅ 网关已停止，再见！');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ 发生错误:', error.message);
    console.error('\n💡 解决建议:');
    console.error('  1. 确保端口 19233 没有被占用');
    console.error('  2. 检查是否已运行 npm run build');
    console.error('  3. 查看详细错误信息进行调试');
    process.exit(1);
  }
}

// 优雅退出处理
process.on('SIGINT', () => {
  console.log('\n👋 收到退出信号，正在清理...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 收到终止信号，正在清理...');
  process.exit(0);
});

// 启动快速开始
quickStart().catch((error) => {
  console.error('❌ 快速开始失败:', error);
  process.exit(1);
});