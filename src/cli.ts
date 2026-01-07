#!/usr/bin/env node

import { createGateway } from './index.js';
import readline from 'readline';

async function main() {
  console.log('🚀  MCP Nexus CLI');
  console.log('================================');

  const gateway = createGateway({
    logLevel: 'info',
    port: 19233
  });

  // Start the gateway
  try {
    await gateway.start();
    gateway.enableGracefulShutdown(); // Enable signal handling
    console.log('✅ Gateway started successfully');
  } catch (error) {
    console.error('❌ Failed to start gateway:', error);
    process.exit(1);
  }

  // Set up CLI interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'pb-mcp> '
  });

  console.log('\nAvailable commands:');
  console.log('  list          - List all services');
  console.log('  templates     - List available templates');
  console.log('  create <name> - Create service from template');
  console.log('  stop <id>     - Stop a service');
  console.log('  status <id>   - Get service status');
  console.log('  health        - Show health statistics');
  console.log('  help          - Show this help');
  console.log('  exit          - Exit the CLI');
  console.log('');

  rl.prompt();

  rl.on('line', async (line) => {
    const [command, ...args] = line.trim().split(' ');

    try {
      switch (command) {
        case 'list':
          await handleList(gateway);
          break;
        case 'templates':
          await handleTemplates(gateway);
          break;
        case 'create':
          await handleCreate(gateway, args[0]);
          break;
        case 'stop':
          await handleStop(gateway, args[0]);
          break;
        case 'status':
          await handleStatus(gateway, args[0]);
          break;
        case 'health':
          await handleHealth(gateway);
          break;
        case 'help':
          console.log('Available commands: list, templates, create, stop, status, health, help, exit');
          break;
        case 'exit':
          console.log('Shutting down gateway...');
          await gateway.stop();
          process.exit(0);
          break;
        case '':
          // Empty command, just show prompt again
          break;
        default:
          console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
      }
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\nShutting down gateway...');
    gateway.disableGracefulShutdown();
    await gateway.stop();
    process.exit(0);
  });
}

async function handleList(gateway: any) {
  const services = await gateway.listServices();

  if (services.length === 0) {
    console.log('No services running.');
    return;
  }

  console.log('\n📋 Running Services:');
  console.log('─────────────────────');
  for (const service of services) {
    console.log(`• ${service.id}`);
    console.log(`  Template: ${service.config.name}`);
    console.log(`  State: ${service.state}`);
    console.log(`  Started: ${service.startTime?.toLocaleString() || 'N/A'}`);
    console.log(`  Errors: ${service.errorCount}`);
    console.log('');
  }
}

async function handleTemplates(gateway: any) {
  const templates = await gateway.serviceRegistry.listTemplates();

  if (templates.length === 0) {
    console.log('No templates available.');
    return;
  }

  console.log('\n📚 Available Templates:');
  console.log('──────────────────────');
  for (const template of templates) {
    console.log(`• ${template.name}`);
    console.log(`  Version: ${template.version}`);
    console.log(`  Transport: ${template.transport}`);
    console.log(`  Command: ${template.command || 'N/A'}`);
    console.log('');
  }
}

async function handleCreate(gateway: any, templateName: string) {
  if (!templateName) {
    console.log('Usage: create <template-name>');
    return;
  }

  console.log(`Creating service from template: ${templateName}...`);

  try {
    const serviceId = await gateway.createService(templateName);
    console.log(`✅ Service created: ${serviceId}`);
  } catch (error) {
    console.log(`❌ Failed to create service: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleStop(gateway: any, serviceId: string) {
  if (!serviceId) {
    console.log('Usage: stop <service-id>');
    return;
  }

  console.log(`Stopping service: ${serviceId}...`);

  try {
    await gateway.stopService(serviceId);
    console.log(`✅ Service stopped: ${serviceId}`);
  } catch (error) {
    console.log(`❌ Failed to stop service: ${error instanceof Error ? error.message : error}`);
  }
}

async function handleStatus(gateway: any, serviceId: string) {
  if (!serviceId) {
    console.log('Usage: status <service-id>');
    return;
  }

  const status = await gateway.getServiceStatus(serviceId);

  if (!status) {
    console.log(`Service ${serviceId} not found.`);
    return;
  }

  console.log(`\n📊 Status for ${serviceId}:`);
  console.log('──────────────────────────');
  console.log(`Name: ${status.name}`);
  console.log(`State: ${status.state}`);
  console.log(`Healthy: ${status.healthy ? '✅' : '❌'}`);
  console.log(`Started: ${status.startTime?.toLocaleString() || 'N/A'}`);
  console.log(`Error Count: ${status.errorCount}`);
  console.log(`Last Health Check: ${status.lastHealthCheck?.toLocaleString() || 'N/A'}`);
}

async function handleHealth(gateway: any) {
  // Get registry stats
  const registryStats = await gateway.serviceRegistry.getRegistryStats();

  console.log('\n🏥 Health Statistics:');
  console.log('─────────────────────');
  console.log(`Total Templates: ${registryStats.totalTemplates}`);
  console.log(`Total Instances: ${registryStats.totalInstances}`);
  console.log(`Healthy Instances: ${registryStats.healthyInstances}`);

  console.log('\nInstances by State:');
  for (const [state, count] of Object.entries(registryStats.instancesByState)) {
    console.log(`  ${state}: ${count}`);
  }
}

// Run the CLI
main().catch(console.error);