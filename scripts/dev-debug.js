#!/usr/bin/env node

/**
 * Debug Wrapper Script
 * 
 * Runs Next.js dev server with comprehensive debug logging
 * 
 * Features:
 * - Engine cycle tracking
 * - Trade execution logs
 * - Indication generation tracking
 * - Position management logs
 * - Real-time data flow logging
 * - Performance metrics
 * 
 * Usage:
 *   npm run dev:debug           # Full engine debug + trade logs
 *   npm run dev:debug:verbose   # Even more verbose (excludes babel)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

function log(color, prefix, message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors[color]}[${timestamp}] ${colors.bright}[${prefix}]${colors.reset}${colors[color]} ${message}${colors.reset}`);
}

// Set up debug environment variables
const debugModules = [
  // Engine
  'engine:*',
  'trade-engine:*',
  'engine-manager:*',
  
  // Indications
  'indication:*',
  'indication-processor:*',
  'indication-generator:*',
  
  // Strategies
  'strategy:*',
  'strategy-processor:*',
  
  // Live trading
  'live-trading:*',
  'position:*',
  'realtime:*',
  
  // Data flow
  'market-data:*',
  'redis-db:*',
  'data-flow:*',
  
  // API
  'api:*',
  'trade-api:*',
  
  // Progression
  'progression:*',
  'cycles:*',
];

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DEBUG: debugModules.join(','),
  FORCE_COLOR: '1',
  // Disable Babel debug to reduce noise
  ...(process.argv[2] === 'verbose' ? {} : { BABEL_DISABLE: '1' }),
};

log('cyan', 'DEBUG', 'Starting Next.js with debug logging...');
log('cyan', 'DEBUG', `Port: 3002`);
log('cyan', 'DEBUG', `Debug modules: ${debugModules.length} active`);
log('yellow', 'DEBUG', 'Watch for [v0] prefixed debug logs');
log('bright', 'DEBUG', '');

const dev = spawn('next', ['dev', '-p', '3002'], {
  env,
  stdio: 'inherit',
  cwd: path.dirname(__dirname),
});

dev.on('error', (err) => {
  log('red', 'ERROR', `Failed to start: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('yellow', 'SHUTDOWN', 'Shutting down dev server...');
  dev.kill('SIGTERM');
});

dev.on('exit', (code) => {
  if (code && code !== 0 && code !== null) {
    log('red', 'EXIT', `Server exited with code ${code}`);
  } else {
    log('green', 'EXIT', 'Server stopped cleanly');
  }
  process.exit(code || 0);
});

// Print debug instructions after a delay
setTimeout(() => {
  log('bright', 'LOGGING', '');
  log('bright', 'LOGGING', '='.repeat(60));
  log('bright', 'LOGGING', 'Debug Output Information');
  log('bright', 'LOGGING', '='.repeat(60));
  log('green', 'PREFIX', 'All debug logs start with: [v0]');
  log('green', 'FILTER', 'Search console for [v0] to see debug logs');
  log('green', 'MODULES', `Monitoring ${debugModules.length} modules`);
  log('bright', 'LOGGING', '');
  log('cyan', 'WATCHING', '[IndicationCycles] - Cycle counting');
  log('cyan', 'WATCHING', '[StrategyCycles] - Strategy processing');
  log('cyan', 'WATCHING', '[RealtimeCycles] - Live position updates');
  log('cyan', 'WATCHING', '[v0] [RealtimeIndication] - Indication processing');
  log('cyan', 'WATCHING', '[v0] [TradeExecution] - Live trades');
  log('bright', 'LOGGING', '');
  log('yellow', 'PERFORMANCE', 'Engine cycles typically run in 800-1000ms');
  log('yellow', 'PERFORMANCE', 'Target: Indications <400ms + Strategies <300ms');
  log('bright', 'LOGGING', '='.repeat(60));
  log('bright', 'LOGGING', '');
}, 3000);
