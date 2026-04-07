#!/usr/bin/env node

import fetch from 'node-fetch'
import { setTimeout } from 'timers/promises'

const BASE_URL = 'http://localhost:3002'
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
}

function log(color, ...args) {
  console.log(`${color}${args.join(' ')}${COLORS.reset}`)
}

async function fetchData(path) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (e) {
    return null
  }
}

async function runQuickstart() {
  log(COLORS.cyan, '\n===========================================')
  log(COLORS.cyan, 'QUICKSTART: REAL PROGRESSION & LIVE TRADING')
  log(COLORS.cyan, '===========================================\n')

  // Step 1: Check dev server
  log(COLORS.bright + COLORS.yellow, '[1/6] Checking dev server...')
  for (let i = 0; i < 5; i++) {
    const health = await fetchData('/api/health')
    if (health) {
      log(COLORS.green, '✓ Dev server running at http://localhost:3002')
      break
    }
    if (i < 4) await setTimeout(1000)
  }

  // Step 2: Get connections
  log(COLORS.bright + COLORS.yellow, '\n[2/6] Fetching active connections...')
  const connections = await fetchData('/api/settings/connections/active')
  if (connections && connections.length > 0) {
    log(COLORS.green, `✓ Found ${connections.length} active connection(s)`)
    connections.forEach((conn) => {
      log(COLORS.cyan, `  • ${conn.name || conn.id} (${conn.exchange})`)
    })
  } else {
    log(COLORS.red, '✗ No active connections found')
    return
  }

  // Step 3: Get engine status
  log(COLORS.bright + COLORS.yellow, '\n[3/6] Checking engine status...')
  const engineStatus = await fetchData('/api/trade-engine/status')
  if (engineStatus) {
    log(COLORS.green, `✓ Engine status: ${engineStatus.isRunning ? 'RUNNING' : 'STOPPED'}`)
    log(COLORS.cyan, `  Progression: ${engineStatus.progressPercentage || 0}%`)
    log(COLORS.cyan, `  Current phase: ${engineStatus.currentPhase || 'N/A'}`)
  }

  // Step 4: Start engine if not running
  if (!engineStatus?.isRunning) {
    log(COLORS.bright + COLORS.yellow, '\n[4/6] Starting trade engine...')
    const startResponse = await fetchData('/api/trade-engine/start')
    if (startResponse?.success) {
      log(COLORS.green, '✓ Trade engine started')
    }
  } else {
    log(COLORS.bright + COLORS.yellow, '\n[4/6] Engine already running')
  }

  // Step 5: Monitor real-time progression (30 seconds)
  log(COLORS.bright + COLORS.yellow, '\n[5/6] Monitoring real-time progression for 30 seconds...\n')

  const startTime = Date.now()
  let lastPhase = ''
  let cycles = 0

  while (Date.now() - startTime < 30000) {
    const stats = await fetchData('/api/main/system-stats-v3')
    const positions = await fetchData('/api/exchange-positions/symbols-stats')
    const indications = await fetchData('/api/main/indications-stats')

    if (stats) {
      const phase = stats.enginePhase || 'Unknown'
      const progress = stats.engineProgressPercentage || 0
      const exchanges = stats.exchangeConnections?.total || 0

      if (phase !== lastPhase) {
        log(COLORS.green, `  Phase: ${phase} (${progress}%)`)
        lastPhase = phase
      }

      if (cycles % 5 === 0) {
        // Show data every 5 cycles
        log(COLORS.cyan, `  │ Cycle ${cycles}`)
        log(COLORS.cyan, `  ├─ Progress: ${progress}%`)
        log(COLORS.cyan, `  ├─ Connections: ${exchanges}`)

        if (positions?.total_symbols) {
          log(COLORS.cyan, `  ├─ Symbols: ${positions.total_symbols}`)
          log(COLORS.cyan, `  ├─ Open Positions: ${positions.total_open}`)
          log(COLORS.cyan, `  ├─ Win Rate: ${positions.win_rate}%`)
        }

        if (indications?.ma_count || indications?.rsi_count) {
          log(COLORS.cyan, `  └─ Indications: MA=${indications?.ma_count || 0}, RSI=${indications?.rsi_count || 0}, MACD=${indications?.macd_count || 0}`)
        }
      }

      cycles++
    }

    await setTimeout(1000)
  }

  // Step 6: Final summary
  log(COLORS.bright + COLORS.yellow, '\n[6/6] Generating final report...\n')

  const finalStats = await fetchData('/api/main/system-stats-v3')
  const finalPositions = await fetchData('/api/exchange-positions/symbols-stats')
  const finalStrategies = await fetchData('/api/main/strategies-evaluation')

  log(COLORS.green, '===== SYSTEM REPORT =====\n')

  if (finalStats) {
    log(COLORS.cyan, 'Engine Status:')
    log(COLORS.cyan, `  • Progress: ${finalStats.engineProgressPercentage || 0}%`)
    log(COLORS.cyan, `  • Phase: ${finalStats.enginePhase || 'N/A'}`)
    log(COLORS.cyan, `  • Connections: ${finalStats.exchangeConnections?.total || 0}`)
    log(COLORS.cyan, `  • Total Volume Traded: ${finalStats.totalVolumeFactor || 'N/A'}`)
  }

  if (finalPositions) {
    log(COLORS.cyan, '\nPosition Statistics:')
    log(COLORS.cyan, `  • Total Symbols: ${finalPositions.total_symbols || 0}`)
    log(COLORS.cyan, `  • Open Positions: ${finalPositions.total_open || 0}`)
    log(COLORS.cyan, `  • Closed Positions: ${finalPositions.total_closed || 0}`)
    log(COLORS.cyan, `  • Win Rate: ${finalPositions.win_rate || 0}%`)
    log(COLORS.cyan, `  • Average P&L: ${finalPositions.avg_pnl || 'N/A'}`)
  }

  if (finalStrategies) {
    log(COLORS.cyan, '\nStrategy Evaluation:')
    log(COLORS.cyan, `  • MA Strategy: ${finalStrategies.ma_passed || 0}/${finalStrategies.ma_total || 0}`)
    log(COLORS.cyan, `  • RSI Strategy: ${finalStrategies.rsi_passed || 0}/${finalStrategies.rsi_total || 0}`)
    log(COLORS.cyan, `  • MACD Strategy: ${finalStrategies.macd_passed || 0}/${finalStrategies.macd_total || 0}`)
    log(COLORS.cyan, `  • BB Strategy: ${finalStrategies.bb_passed || 0}/${finalStrategies.bb_total || 0}`)
  }

  log(COLORS.green, '\n✓ Quickstart completed successfully!\n')
  log(COLORS.cyan, 'Dashboard: http://localhost:3002')
  log(COLORS.cyan, 'Engine will continue running in background\n')
}

runQuickstart().catch((err) => {
  log(COLORS.red, 'Error:', err.message)
  process.exit(1)
})
