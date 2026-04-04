#!/usr/bin/env node

/**
 * Quick Live Trading Verification & Setup Script
 * 
 * This script verifies all prerequisites for live trading and provides
 * step-by-step instructions to get positions going live.
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const protocol = url.protocol === 'https:' ? https : http;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = protocol.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function checkSystemHealth() {
  console.log('\n📊 Checking System Health...\n');

  try {
    // Check engine status
    const engineRes = await makeRequest('GET', '/api/engine/system-status');
    console.log('✓ Engine Status:', engineRes.data.data?.status || 'unknown');

    // Check live trading status
    const liveStatusRes = await makeRequest('GET', '/api/settings/connections/live-trade-status');
    const liveData = liveStatusRes.data;
    console.log(`✓ Total Connections: ${liveData.total}`);
    console.log(`✓ Live Trading Active: ${liveData.live_trading_active}`);

    if (liveData.active_live_trading?.length > 0) {
      console.log('\n  Active Live Trades:');
      for (const conn of liveData.active_live_trading) {
        console.log(`    • ${conn.name} (${conn.exchange})`);
      }
    }

    return {
      engineRunning: engineRes.data.data?.status === 'running',
      connectionsTotal: liveData.total,
      liveTradesActive: liveData.live_trading_active,
    };
  } catch (error) {
    console.error('✗ Error checking system health:', error.message);
    return null;
  }
}

async function checkConnections() {
  console.log('\n🔌 Checking Available Connections...\n');

  try {
    const connectionsRes = await makeRequest('GET', '/api/settings/connections/available');
    const connections = connectionsRes.data.data || [];

    if (connections.length === 0) {
      console.log('⚠ No connections available. Add a connection first.');
      return [];
    }

    console.log(`Found ${connections.length} connection(s):\n`);
    for (const conn of connections) {
      const isEnabled = conn.is_enabled === '1' || conn.is_enabled === true;
      const isDashboard = conn.is_enabled_dashboard === '1' || conn.is_enabled_dashboard === true;
      const isLiveTrade = conn.is_live_trade === '1' || conn.is_live_trade === true;

      console.log(`  📍 ${conn.name || conn.id}`);
      console.log(`     Exchange: ${conn.exchange}`);
      console.log(`     Enabled: ${isEnabled ? '✓' : '✗'}`);
      console.log(`     Dashboard: ${isDashboard ? '✓' : '✗'}`);
      console.log(`     Live Trade: ${isLiveTrade ? '✓' : '✗'}`);
      console.log();
    }

    return connections;
  } catch (error) {
    console.error('✗ Error checking connections:', error.message);
    return [];
  }
}

async function checkPositions(connectionId) {
  console.log(`\n📊 Checking Positions for ${connectionId}...\n`);

  try {
    const posRes = await makeRequest('GET', `/api/exchange-positions?connection_id=${connectionId}`);
    const positions = posRes.data.data || [];

    if (positions.length === 0) {
      console.log('  No open positions yet.');
      return;
    }

    console.log(`Found ${positions.length} position(s):\n`);
    for (const pos of positions) {
      console.log(`  💰 ${pos.symbol} ${pos.direction?.toUpperCase()}`);
      console.log(`     Qty: ${pos.quantity}`);
      console.log(`     Entry: ${pos.entryPrice}`);
      console.log(`     Status: ${pos.status}`);
      if (pos.exchangeData?.unrealizedPnl !== undefined) {
        const pnl = parseFloat(pos.exchangeData.unrealizedPnl);
        const sign = pnl >= 0 ? '+' : '';
        console.log(`     P&L: ${sign}${pnl.toFixed(2)} USDT`);
      }
      console.log();
    }
  } catch (error) {
    console.error('✗ Error checking positions:', error.message);
  }
}

async function enableLiveTrading(connectionId) {
  console.log(`\n🚀 Enabling Live Trading for ${connectionId}...\n`);

  try {
    const res = await makeRequest('POST', `/api/settings/connections/${connectionId}/live-trade`, {
      is_live_trade: true,
    });

    if (res.data.success) {
      console.log('✓ Live Trading Enabled!');
      console.log(`  Connection: ${res.data.connectionName}`);
      console.log(`  Exchange: ${res.data.exchange}`);
      console.log(`  Engine Status: ${res.data.engineStatus}`);
      console.log(`  Message: ${res.data.message}`);
      return true;
    } else {
      console.log('✗ Failed to enable live trading:');
      console.log(`  Error: ${res.data.error}`);
      if (res.data.hint) {
        console.log(`  Hint: ${res.data.hint}`);
      }
      return false;
    }
  } catch (error) {
    console.error('✗ Error enabling live trading:', error.message);
    return false;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  Live Trading Setup & Verification    ║');
  console.log('║  v0 Trading System                    ║');
  console.log('╚════════════════════════════════════════╝');

  // Step 1: Check system health
  const health = await checkSystemHealth();

  if (!health) {
    console.log('\n⚠ Could not connect to system. Make sure the server is running.');
    console.log(`  Base URL: ${BASE_URL}`);
    process.exit(1);
  }

  // Step 2: Check if engine is running
  if (!health.engineRunning) {
    console.log('\n⚠ Global Trade Engine is NOT running!');
    console.log('\nTo start the engine:');
    console.log('  1. Go to Dashboard');
    console.log('  2. Click "Start" button in control panel');
    console.log('  3. Wait for "Engine Running" status\n');
    console.log('Or use API:');
    console.log('  curl -X POST http://localhost:3000/api/engine/startup\n');
  }

  // Step 3: Get connections
  const connections = await checkConnections();

  if (connections.length === 0) {
    console.log('\n⚠ No connections found. Please add a connection first.\n');
    process.exit(1);
  }

  // Find a connection to use
  const inactiveConn = connections.find(c =>
    (c.is_enabled !== '1' && c.is_enabled !== true)
  );

  if (inactiveConn) {
    console.log('\n📋 Next Steps:\n');
    console.log('1. Enable Connection (if not already):');
    console.log(`   → Go to Settings → ${inactiveConn.name}`);
    console.log('   → Toggle Enable switch\n');
    console.log('2. Start Global Engine (if not running):');
    console.log('   → Go to Dashboard → Control Panel');
    console.log('   → Click "Start" button\n');
    console.log('3. Enable Live Trading:');
    console.log(`   → Go to Dashboard → ${inactiveConn.name}`);
    console.log('   → Toggle "Live Trade" switch\n');
  }

  // Check positions for first live-trade enabled connection
  const liveConn = connections.find(c => c.is_live_trade === '1' || c.is_live_trade === true);
  if (liveConn) {
    await checkPositions(liveConn.id);
  }

  console.log('\n📚 For detailed information, see: LIVE_TRADING_GUIDE.md\n');
}

main().catch(console.error);
