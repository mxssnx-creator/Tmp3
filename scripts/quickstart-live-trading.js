#!/usr/bin/env node

/**
 * Quick Start Script - Live Trading Enabled
 * 
 * Initializes CTS v3.2 with:
 * - Auto-connection setup
 * - High volatility screening enabled
 * - Live trading pre-configured
 * - Development server with debug logging
 * 
 * Usage:
 *   npm run quickstart              # Start with normal logging
 *   npm run quickstart:debug        # Start with full debug logging
 *   DEBUG=engine:* npm run quickstart  # Start with engine debug only
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(color, prefix, message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors[color]}[${timestamp}] [${prefix}]${colors.reset} ${message}`);
}

async function initLiveTrading() {
  log('cyan', 'QUICKSTART', 'Initializing CTS v3.2 with Live Trading...');

  // Step 1: Check if Redis is accessible
  log('blue', 'SETUP', 'Verifying Redis connection...');
  try {
    const response = await fetch('http://localhost:3002/api/health', { timeout: 5000 });
    if (!response.ok && response.status !== 404) {
      log('yellow', 'SETUP', 'Health check not ready yet (normal on first start)');
    }
  } catch (e) {
    log('yellow', 'SETUP', 'Server not ready yet - it will be started now');
  }

  // Step 2: Create environment config for live trading
  const envConfig = {
    NEXT_PUBLIC_LIVE_TRADING_ENABLED: 'true',
    NEXT_PUBLIC_AUTO_START_ENGINE: 'true',
    NEXT_PUBLIC_AUTO_SCREEN_VOLATILITY: 'true',
    NEXT_PUBLIC_AUTO_ENABLE_LIVE_TRADING: 'true',
    DEBUG: process.env.DEBUG || 'engine:*,trade:*',
  };

  log('green', 'SETUP', 'Live Trading configuration:');
  Object.entries(envConfig).forEach(([key, value]) => {
    if (value && value !== 'true') {
      log('green', 'SETUP', `  ✓ ${key}`);
    } else if (value === 'true') {
      log('green', 'SETUP', `  ✓ ${key} = ENABLED`);
    }
  });

  // Step 3: Start development server
  log('blue', 'START', 'Starting Next.js development server on port 3002...');
  log('cyan', 'START', 'Live Trading will be available at: http://localhost:3002/live-trading');

  const env = {
    ...process.env,
    ...envConfig,
    NODE_ENV: 'development',
    FORCE_COLOR: '1',
  };

  const dev = spawn('next', ['dev', '-p', '3002'], {
    env,
    stdio: 'inherit',
    cwd: path.dirname(__dirname),
  });

  dev.on('error', (err) => {
    log('red', 'ERROR', `Failed to start development server: ${err.message}`);
    process.exit(1);
  });

  dev.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      log('red', 'ERROR', `Development server exited with code ${code}`);
    }
    process.exit(code || 0);
  });

  // Step 4: Print startup instructions
  setTimeout(() => {
    log('green', 'READY', 'Development server is starting...');
    log('cyan', 'NEXT', 'Waiting for server to be ready (typically 10-15 seconds)...');
  }, 1000);

  setTimeout(() => {
    log('bright', 'INSTRUCTIONS', '');
    log('bright', 'INSTRUCTIONS', '='.repeat(60));
    log('bright', 'INSTRUCTIONS', 'CTS v3.2 - Live Trading Quickstart');
    log('bright', 'INSTRUCTIONS', '='.repeat(60));
    log('green', 'DASHBOARD', 'Open: http://localhost:3002');
    log('green', 'LIVE_TRADING', 'Open: http://localhost:3002/live-trading');
    log('green', 'SETTINGS', 'Configure: http://localhost:3002/settings');
    log('bright', 'INSTRUCTIONS', '');
    log('yellow', 'NEXT_STEPS', '1. Wait for the server to fully start');
    log('yellow', 'NEXT_STEPS', '2. The system will auto-scan for high volatility symbols');
    log('yellow', 'NEXT_STEPS', '3. Top 3 volatile symbols will auto-enable for live trading');
    log('yellow', 'NEXT_STEPS', '4. Open /live-trading to monitor active positions');
    log('bright', 'INSTRUCTIONS', '');
    log('yellow', 'DEBUG', `Debug mode: ${process.env.DEBUG || 'engine:*,trade:*'}`);
    log('yellow', 'DEBUG', 'Watch the console for [v0] debug logs');
    log('bright', 'INSTRUCTIONS', '='.repeat(60));
    log('bright', 'INSTRUCTIONS', '');
  }, 2000);
}

// Initialize
initLiveTrading().catch((err) => {
  log('red', 'INIT', `Initialization failed: ${err.message}`);
  process.exit(1);
});
