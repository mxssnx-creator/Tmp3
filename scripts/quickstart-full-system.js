#!/usr/bin/env node

const http = require('http')

const BASE_URL = 'http://localhost:3002'
let connectionId = null

// Helper to make HTTP requests
function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }

    const req = http.request(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, data })
        }
      })
    })

    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function quickstart() {
  console.log('\n==========================================')
  console.log('QUICKSTART: FULL PROGRESSION & LIVE TRADING')
  console.log('==========================================\n')

  try {
    // Step 1: Check dev server
    console.log('[1/5] Checking dev server...')
    try {
      const res = await makeRequest('GET', '/')
      if (res.status !== 200 && res.status !== 404) throw new Error('Server not ready')
      console.log('✓ Dev server running at ' + BASE_URL)
    } catch (e) {
      console.error('Error: Dev server not running at ' + BASE_URL)
      console.error('Please run "npm run dev" first')
      process.exit(1)
    }

    // Step 2: Fetch active connections
    console.log('\n[2/5] Fetching active connections...')
    const connRes = await makeRequest('GET', '/api/settings/connections?enabled=true')
    const connections = connRes.data
    
    if (!Array.isArray(connections) || connections.length === 0) {
      console.error('Error: No active connections found')
      console.error('Please configure a BingX or Bybit connection first')
      process.exit(1)
    }
    
    connectionId = connections[0].id
    console.log(`✓ Found ${connections.length} active connection(s)`)
    console.log(`  Using: ${connectionId}`)
    console.log(`  Exchange: ${connections[0].exchange}`)

    // Step 3: Check engine status
    console.log('\n[3/5] Checking engine status...')
    const statusRes = await makeRequest('GET', '/api/trade-engine/status')
    const engineStatus = statusRes.data
    console.log(`  Current status: ${engineStatus.status || 'unknown'}`)
    console.log(`  Progress: ${engineStatus.progress || 0}%`)

    // Step 4: Enable live trading
    console.log('\n[4/5] Enabling live trading...')
    const liveRes = await makeRequest('POST', `/api/settings/connections/${connectionId}/live-trade`, {
      enabled: true,
    })
    if (liveRes.status === 200) {
      console.log('✓ Live trading enabled')
    } else {
      console.warn('⚠ Live trading toggle may have failed, continuing...')
    }

    // Step 5: Start engine
    console.log('\n[5/5] Starting engine with full progression...')
    const startRes = await makeRequest('POST', '/api/trade-engine/start', {
      connectionId,
      autoScaleLeverage: true,
    })
    
    if (startRes.status === 200 || startRes.status === 201) {
      console.log('✓ Engine started')
    } else {
      console.error('Error: Failed to start engine')
      console.error('Response:', startRes.data)
      process.exit(1)
    }

    // Completion message
    console.log('\n==========================================')
    console.log('QUICKSTART COMPLETE - ENGINE RUNNING')
    console.log('==========================================\n')

    console.log(`Dashboard: ${BASE_URL}`)
    console.log(`Connection: ${connectionId}\n`)

    console.log('Real-time monitoring (updating every 3 seconds):\n')

    // Monitor engine progress
    let cycleCount = 0
    let lastProgress = 0
    let positionCount = 0

    const monitor = setInterval(async () => {
      try {
        cycleCount++

        // Get engine status
        const status = await makeRequest('GET', '/api/trade-engine/status')
        const engine = status.data

        // Get statistics
        const statsRes = await makeRequest('GET', '/api/main/system-stats-v3')
        const stats = statsRes.data

        // Get strategy evaluation
        const stratRes = await makeRequest('GET', '/api/main/strategies-evaluation')
        const strats = stratRes.data

        // Get positions
        const posRes = await makeRequest('GET', `/api/exchange-positions/symbols-stats?connection_id=${connectionId}`)
        const positions = posRes.data

        // Display progress
        if (engine.progress !== lastProgress) {
          console.log(`\n[CYCLE ${cycleCount}] Engine Progress: ${engine.progress}%`)
          console.log(`Status: ${engine.status}`)

          if (engine.progress >= 5 && engine.progress < 8) {
            console.log('  Phase: Market Data Loading...')
          } else if (engine.progress >= 8 && engine.progress < 15) {
            console.log('  Phase: Historical Data Processing...')
          } else if (engine.progress >= 15 && engine.progress < 60) {
            console.log('  Phase: Calculating Indicators...')
          } else if (engine.progress >= 60 && engine.progress < 75) {
            console.log('  Phase: Evaluating Strategies...')
          } else if (engine.progress >= 75) {
            console.log('  Phase: Live Trading Ready')
          }

          lastProgress = engine.progress
        }

        // Show market data
        if (stats.exchangeConnections) {
          console.log(`\nActive Connections: ${stats.exchangeConnections.total}`)
        }

        // Show indicators
        if (stats.indicationsStats) {
          console.log(
            `Indications: ${stats.indicationsStats.created} created, ` +
            `${stats.indicationsStats.passed || 0} passed`
          )
        }

        // Show strategy evaluation
        if (strats.totalEvaluated !== undefined) {
          console.log(`Strategies: ${strats.totalEvaluated} evaluated, ${strats.totalLiveReady} ready for trading`)
        }

        // Show positions
        if (positions.total_open !== undefined) {
          console.log(`Open Positions: ${positions.total_open} (P&L: ${positions.unrealized_pnl || 0})`)
          if (positions.total_open > positionCount) {
            console.log('  ✓ New position(s) created!')
            positionCount = positions.total_open
          }
        }

        // Auto-stop after 60 seconds
        if (cycleCount >= 20) {
          console.log('\n\nMonitoring complete (20 cycles = ~60 seconds)')
          console.log('\nEngine is still running - visit dashboard to monitor live:')
          console.log(`  ${BASE_URL}`)
          clearInterval(monitor)
          process.exit(0)
        }
      } catch (e) {
        console.error('Monitor error:', e.message)
      }
    }, 3000)

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      console.log('\n\nStopping monitor (engine continues running)')
      clearInterval(monitor)
      process.exit(0)
    })
  } catch (error) {
    console.error('Quickstart error:', error.message)
    process.exit(1)
  }
}

quickstart()
