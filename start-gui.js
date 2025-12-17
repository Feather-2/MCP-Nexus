#!/usr/bin/env node
/**
 * MCP Nexus - Gateway Launcher
 */

import { createGateway } from './dist/PbMcpGateway.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

const banner = `
${c.cyan}${c.bold}    __  __  ____  ____       _   _
${c.cyan}   |  \\/  |/ ___||  _ \\     | \\ | | _____  ___   _ ___
${c.magenta}   | |\\/| | |    | |_) |____|  \\| |/ _ \\ \\/ / | | / __|
${c.magenta}   | |  | | |___ |  __/_____|   | |  __/>  <| |_| \\__ \\
${c.blue}   |_|  |_|\\____||_|        |_|\\_|\\___/_/\\_\\\\__,_|___/
${c.reset}
${c.dim}   Intelligent MCP Gateway with Three-Tier Routing${c.reset}
`;

function log(icon, msg, color = c.reset) {
  console.log(`${c.dim}│${c.reset} ${icon} ${color}${msg}${c.reset}`);
}

function divider() {
  console.log(`${c.dim}├${'─'.repeat(50)}${c.reset}`);
}

async function startGUI() {
  console.log(banner);
  console.log(`${c.dim}╭${'─'.repeat(50)}${c.reset}`);
  log('⚡', 'Initializing gateway...', c.yellow);

  const gateway = createGateway({
    port: 19233,
    host: '127.0.0.1',
    authMode: 'local-trusted',
    logLevel: 'info',
    configPath: join(__dirname, 'config', 'gateway.json')
  });

  try {
    await gateway.start();

    divider();
    log('✓', 'Gateway started successfully', c.green);
    log('🌐', `Web UI: ${c.bold}${c.cyan}http://localhost:19233${c.reset}`);
    log('📡', `API:    ${c.cyan}http://localhost:19233/api${c.reset}`);
    divider();
    log('🎯', `${c.bold}Features${c.reset}`);
    log('  ', `${c.dim}Dashboard${c.reset}  │ Services │ Templates │ Monitoring`);
    log('  ', `${c.dim}Auth${c.reset}       │ Settings │ Generator │ Orchestrator`);
    console.log(`${c.dim}╰${'─'.repeat(50)}${c.reset}`);
    console.log(`\n${c.dim}Press ${c.bold}Ctrl+C${c.reset}${c.dim} to stop${c.reset}\n`);

    const exitHandler = async (signal) => {
      console.log(`\n${c.yellow}⏹ Shutting down...${c.reset}`);
      try {
        await gateway.stop();
        console.log(`${c.green}✓ Stopped${c.reset}\n`);
        process.exit(0);
      } catch (error) {
        console.error(`${c.red}✗ Error: ${error.message}${c.reset}`);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => exitHandler('SIGINT'));
    process.on('SIGTERM', () => exitHandler('SIGTERM'));
    process.stdin.resume();

  } catch (error) {
    console.log(`${c.dim}╰${'─'.repeat(50)}${c.reset}`);
    console.error(`\n${c.red}${c.bold}✗ Failed to start${c.reset}`);
    console.error(`${c.dim}  ${error.message}${c.reset}\n`);
    console.error(`${c.yellow}Hints:${c.reset}`);
    console.error(`${c.dim}  • Run ${c.reset}npm run build${c.dim} first`);
    console.error(`  • Check if port 19233 is in use${c.reset}\n`);
    process.exit(1);
  }
}

startGUI().catch((error) => {
  console.error(`${c.red}Fatal: ${error.message}${c.reset}`);
  process.exit(1);
});
