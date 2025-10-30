// MCP Nexus 使用示例
import { PbMcpGateway, createGateway } from './dist/PbMcpGateway.js';

async function example() {
  console.log('🚀 MCP Nexus 使用示例\n');

  // 1. 创建网关实例
  console.log('1. 创建网关...');
  const gateway = createGateway({
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    logLevel: 'info'
  });

  try {
    // 2. 启动网关
    console.log('2. 启动网关...');
    await gateway.start();
    console.log('✅ 网关启动成功！');

    // 3. 查看可用模板
    console.log('\n3. 可用的服务模板:');
    const templates = await gateway.listTemplates();
    templates.forEach(template => {
      console.log(`  - ${template.name} (${template.transport})`);
      console.log(`    描述: ${template.description || 'N/A'}`);
      console.log(`    能力: ${template.capabilities?.join(', ') || 'N/A'}\n`);
    });

    // 4. 创建一个文件系统服务
    console.log('4. 创建文件系统服务...');
    const serviceId = await gateway.createService('filesystem', {
      env: { ALLOWED_DIRECTORY: 'C:\\temp' }
    });
    console.log(`✅ 服务创建成功，ID: ${serviceId}`);

    // 5. 查看服务状态
    console.log('\n5. 服务列表:');
    const services = await gateway.listServices();
    services.forEach(service => {
      console.log(`  - ${service.id}: ${service.config.name} (${service.state})`);
    });

    // 6. 生成认证token
    console.log('\n6. 生成认证token...');
    const token = await gateway.generateToken('demo-user', ['read', 'write'], 1);
    console.log(`✅ Token: ${token.substring(0, 20)}...`);

    // 7. 查看网关健康状态
    console.log('\n7. 网关健康状态:');
    const health = await gateway.getHealthStatus();
    console.log(`  网关状态: ${health.gateway.status}`);
    console.log(`  运行时间: ${Math.round(health.gateway.uptime/1000)}秒`);
    console.log(`  服务总数: ${health.metrics.totalServices}`);
    console.log(`  健康服务: ${health.metrics.healthyServices}`);

    // 8. 停止网关
    console.log('\n8. 停止网关...');
    await gateway.stop();
    console.log('✅ 网关已停止');

  } catch (error) {
    console.error('❌ 错误:', error.message);
  }
}

// 运行示例
example().catch(console.error);