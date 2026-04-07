#!/usr/bin/env node

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BASE_URL = 'http://localhost:3002';
const DEMO_MODE = true;

console.log('\n\x1b[36m==========================================\x1b[0m');
console.log('\x1b[36mQUICKSTART: SETUP & REAL PROGRESSION\x1b[0m');
console.log('\x1b[36m==========================================\x1b[0m\n');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(path, options = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      console.error(`[ERR] ${response.status} ${response.statusText}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error(`[ERR] ${e.message}`);
    return null;
  }
}

async function main() {
  // Step 1: Check server
  console.log('\x1b[33m[1/7] Checking dev server...\x1b[0m');
  const health = await makeRequest('/api/health');
  if (!health) {
    console.error('\x1b[31m✗ Dev server not responding\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32m✓ Dev server ready\x1b[0m');

  // Step 2: Create test connection
  console.log('\n\x1b[33m[2/7] Creating test connection...\x1b[0m');
  const connResult = await makeRequest('/api/settings/connections', {
    method: 'POST',
    body: JSON.stringify({
      exchange: 'bingx',
      name: 'BingX Demo',
      api_key: 'demo_key_' + Math.random().toString(36).substr(2, 9),
      api_secret: 'demo_secret_' + Math.random().toString(36).substr(2, 9),
      testnet: true,
    }),
  });
  
  if (!connResult || !connResult.id) {
    console.log('\x1b[33m⚠ Using existing connections...\x1b[0m');
  } else {
    console.log(`\x1b[32m✓ Connection created: ${connResult.id}\x1b[0m`);
  }

  // Step 3: Get active connections
  console.log('\n\x1b[33m[3/7] Loading connections...\x1b[0m');
  const connections = await makeRequest('/api/settings/connections');
  if (!connections || connections.length === 0) {
    console.log('\x1b[33m⚠ No connections found - using demo data\x1b[0m');
  } else {
    console.log(`\x1b[32m✓ Found ${connections.length} connections:\x1b[0m`);
    connections.forEach((conn, i) => {
      console.log(`  ${i + 1}. ${conn.name || conn.exchange} (${conn.id})`);
    });
  }

  // Step 4: Get engine status
  console.log('\n\x1b[33m[4/7] Checking engine status...\x1b[0m');
  const engineStatus = await makeRequest('/api/trade-engine/status');
  if (engineStatus) {
    console.log(`\x1b[32m✓ Engine status:\x1b[0m`);
    console.log(`  Progress: ${engineStatus.progress}%`);
    console.log(`  Phase: ${engineStatus.phase}`);
    console.log(`  Active: ${engineStatus.is_active ? 'YES' : 'NO'}`);
  }

  // Step 5: Get system stats
  console.log('\n\x1b[33m[5/7] Loading system statistics...\x1b[0m');
  const stats = await makeRequest('/api/main/system-stats-v3');
  if (stats) {
    console.log('\x1b[32m✓ System Statistics:\x1b[0m');
    console.log(`  Active Connections: ${stats.exchangeConnections?.total || 0}`);
    console.log(`  Total Symbols: ${stats.indications?.totalSymbols || 0}`);
    console.log(`  Open Positions: ${stats.positions?.openCount || 0}`);
    console.log(`  Closed Positions: ${stats.positions?.closedCount || 0}`);
    console.log(`  Total P&L: $${(stats.trading?.totalPnL || 0).toFixed(2)}`);
    console.log(`  Win Rate: ${(stats.trading?.winRate || 0).toFixed(1)}%`);
  }

  // Step 6: Get trading statistics
  console.log('\n\x1b[33m[6/7] Loading trading statistics...\x1b[0m');
  const tradingStats = await makeRequest('/api/trading/stats');
  if (tradingStats) {
    console.log('\x1b[32m✓ Trading Performance:\x1b[0m');
    console.log(`  Total Trades: ${tradingStats.totalTrades || 0}`);
    console.log(`  Winning Trades: ${tradingStats.winningTrades || 0}`);
    console.log(`  Losing Trades: ${tradingStats.losingTrades || 0}`);
    console.log(`  Avg Profit Factor: ${(tradingStats.avgProfitFactor || 0).toFixed(2)}`);
    console.log(`  Avg Drawdown: ${(tradingStats.avgDrawdown || 0).toFixed(1)}%`);
  }

  // Step 7: Get strategy evaluation
  console.log('\n\x1b[33m[7/7] Loading strategy evaluation...\x1b[0m');
  const strategies = await makeRequest('/api/main/strategies-evaluation');
  if (strategies) {
    console.log('\x1b[32m✓ Strategy Results:\x1b[0m');
    if (strategies.strategies && strategies.strategies.length > 0) {
      strategies.strategies.forEach((strat, i) => {
        console.log(`  ${i + 1}. ${strat.type}: ${strat.total} created, ${strat.passed} passed (${strat.profitFactor?.toFixed(2) || 'N/A'} PF)`);
      });
    } else {
      console.log('  No strategies evaluated yet');
    }
  }

  // Display dashboard URL
  console.log('\n\x1b[36m==========================================\x1b[0m');
  console.log('\x1b[32m✓ QUICKSTART COMPLETE\x1b[0m');
  console.log('\x1b[36m==========================================\x1b[0m\n');
  console.log('\x1b[33mDashboard:\x1b[0m http://localhost:3002');
  console.log('\x1b[33mEngine will auto-progress through 6 phases every 1000ms\x1b[0m\n');
  
  // Real-time monitoring
  console.log('\x1b[36mMonitoring system in real-time (10 seconds)...\x1b[0m\n');
  
  let lastProgress = -1;
  for (let i = 0; i < 10; i++) {
    const status = await makeRequest('/api/trade-engine/status');
    if (status && status.progress !== lastProgress) {
      lastProgress = status.progress;
      const bar = '█'.repeat(Math.floor(status.progress / 5)) + '░'.repeat(20 - Math.floor(status.progress / 5));
      console.log(`[${new Date().toLocaleTimeString()}] Progress: [${bar}] ${status.progress}% - Phase: ${status.phase}`);
    }
    
    const systemStats = await makeRequest('/api/main/system-stats-v3');
    if (systemStats) {
      process.stdout.write(`\r  Positions: ${systemStats.positions?.openCount || 0} open | P&L: $${(systemStats.trading?.totalPnL || 0).toFixed(2)} | Win Rate: ${(systemStats.trading?.winRate || 0).toFixed(1)}%`);
    }
    
    await sleep(1000);
  }
  
  console.log('\n\n\x1b[32m✓ System is running and monitoring data in real-time\x1b[0m');
  console.log('\x1b[33mRefresh dashboard for live updates: http://localhost:3002\x1b[0m\n');
}

main().catch(err => {
  console.error('\x1b[31m✗ Error:\x1b[0m', err.message);
  process.exit(1);
});
