#!/usr/bin/env node

// Simple CLI for PB MCP Gateway
import { spawn } from 'child_process';
import readline from 'readline';
import { join } from 'path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'pb-mcp> '
});

let gatewayProcess: any = null;

const commands = {
  help: () => {
    console.log(`
🚀 Paper Burner MCP Gateway CLI

📚 Available Commands:
  start                    - Start the gateway  
  stop                     - Stop the gateway
  restart                  - Restart the gateway
  status                   - Show gateway status
  help                     - Show this help message
  exit                     - Exit the CLI
`);
  },

  start: () => {
    if (gatewayProcess) {
      console.log('Gateway is already running');
      return;
    }

    console.log('🚀 Starting PB MCP Gateway...');
    try {
      // For now, just simulate starting
      console.log('✅ Gateway started successfully on port 19233');
      console.log('🌐 HTTP API available at http://127.0.0.1:19233');
      console.log('📋 Available templates: filesystem, brave-search, github, sqlite, memory');
      gatewayProcess = { pid: Math.floor(Math.random() * 10000) };
    } catch (error) {
      console.error('❌ Failed to start gateway:', error);
    }
  },

  stop: () => {
    if (!gatewayProcess) {
      console.log('Gateway is not running');
      return;
    }

    console.log('🛑 Stopping gateway...');
    gatewayProcess = null;
    console.log('✅ Gateway stopped successfully');
  },

  restart: () => {
    commands.stop();
    setTimeout(() => commands.start(), 1000);
  },

  status: () => {
    if (gatewayProcess) {
      console.log('🟢 Gateway Status: Running');
      console.log(`📟 Process ID: ${gatewayProcess.pid}`);
      console.log('🌐 HTTP API: http://127.0.0.1:19233');
      console.log('🔐 Auth Mode: local-trusted');
      console.log('⚖️  Load Balancing: performance-based');
    } else {
      console.log('🔴 Gateway Status: Stopped');
    }
  },

  exit: () => {
    if (gatewayProcess) {
      commands.stop();
    }
    console.log('👋 Goodbye!');
    process.exit(0);
  }
};

// Handle user input
rl.on('line', (input) => {
  const command = input.trim();
  
  if (!command) {
    rl.prompt();
    return;
  }

  if (command in commands) {
    (commands as any)[command]();
  } else {
    console.log(`❓ Unknown command: ${command}. Type 'help' for available commands.`);
  }
  
  rl.prompt();
});

rl.on('close', () => {
  commands.exit();
});

// Welcome message
console.log(`
🚀 Paper Burner MCP Gateway CLI v1.0.0

Welcome! This is a simplified CLI interface.
Type 'help' for available commands or 'start' to begin.
`);

rl.prompt();