import { McpGenerator } from './dist/generator/McpGenerator.js';
import { ServiceRegistryImpl } from './dist/gateway/ServiceRegistryImpl.js';
import { ConsoleLogger } from './dist/utils/ConsoleLogger.js';

const logger = new ConsoleLogger('info');
const registry = new ServiceRegistryImpl(logger);

const generator = new McpGenerator({
  logger,
  templateManager: registry.getTemplateManager(),
  registry
});

// 测试生成 Weather API
async function testGenerator() {
  console.log('🚀 测试 MCP Generator...\n');

  const result = await generator.generate({
    source: {
      type: 'markdown',
      content: `
# Weather API

获取指定城市的天气信息

## 端点
- URL: https://api.weatherapi.com/v1/current.json
- Method: GET
- Auth: API Key (query parameter: key)

## 参数
- q (string, required): 城市名称，例如 "Beijing" 或 "London"
- aqi (string, optional): 是否返回空气质量数据 (yes/no)

## 响应示例
\`\`\`json
{
  "location": {
    "name": "Beijing",
    "country": "China"
  },
  "current": {
    "temp_c": 15,
    "condition": {
      "text": "Sunny"
    },
    "humidity": 45
  }
}
\`\`\`
      `
    },
    options: {
      name: 'weather-api',
      transport: 'auto',
      testMode: false,
      autoRegister: true
    }
  });

  console.log('✅ 生成结果:', JSON.stringify(result, null, 2));

  if (result.success) {
    console.log('\n🎉 成功生成 MCP 服务！');
    console.log('📝 模板名称:', result.template?.name);
    console.log('🔧 传输协议:', result.template?.config.transport);
    console.log('🛠️ 工具数量:', result.template?.tools.length);

    if (result.registered) {
      console.log('✅ 已自动注册到网关');
    }

    if (result.validation) {
      console.log('\n📋 验证结果:');
      console.log('  - 有效:', result.validation.valid);
      console.log('  - 错误:', result.validation.errors.length);
      console.log('  - 警告:', result.validation.warnings.length);

      if (result.validation.warnings.length > 0) {
        console.log('\n⚠️ 警告:');
        result.validation.warnings.forEach(w => console.log('  -', w));
      }
    }

    // 测试导出
    console.log('\n📤 测试导出为 JSON...');
    const exportResult = await generator.export({
      templateName: 'weather-api',
      format: 'json',
      options: {
        includeCode: true,
        metadata: {
          author: 'test-user',
          tags: ['weather', 'api', 'test'],
          description: 'Weather API for testing'
        }
      }
    });

    if (exportResult.success) {
      console.log('✅ 导出成功！');
      console.log('📁 下载链接:', exportResult.downloadUrl);
    }
  } else {
    console.error('❌ 生成失败:', result.error);
  }
}

testGenerator().catch(console.error);
