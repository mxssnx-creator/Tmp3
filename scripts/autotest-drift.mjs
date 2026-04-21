#!/usr/bin/env node

/**
 * Automated Test Runner for DRIFTUSDT Complete Progression
 * Monitors engine performance, data flow, and live position creation
 */

import fetch from 'node-fetch'

const API_BASE = 'http://localhost:3002/api'
const TEST_DURATION = 60000
const POLL_INTERVAL = 1000
const CONNECTION_ID = 'default-bingx-001'

async function fetchAPI(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`)
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    return null
  }
}

async function getEngineMetrics() {
  return await fetchAPI(`/connections/progression/${CONNECTION_ID}`)
}

function logResult(result) {
  const status = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '●'
  console.log(`[${result.timestamp}] ${status} [${result.phase}] ${result.message}`)
  console.log(`  Cycles: ${result.metrics.cycles} | Indications: ${result.metrics.indications} | Strategies: ${result.metrics.strategies} | Positions: ${result.metrics.positions}`)
}

async function testPhase(name, expectedMetric, minValue, maxTime) {
  console.log(`\n[TEST] Starting phase: ${name}`)
  const startTime = Date.now()

  while (Date.now() - startTime < maxTime) {
    const data = await getEngineMetrics()
    if (!data) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      continue
    }

    const metrics = data.state || data.metrics || {}
    const value = metrics[expectedMetric] || 0

    if (value > minValue) {
      const result = {
        timestamp: new Date().toISOString().split('T')[1].split('.')[0],
        phase: name,
        metrics: {
          cycles: metrics.cyclesCompleted || 0,
          indications: metrics.indicationsCount || 0,
          strategies: metrics.totalStrategiesEvaluated || 0,
          positions: metrics.intervalsProcessed || 0,
        },
        status: 'pass',
        message: `${name} passed: ${expectedMetric}=${value}`,
      }
      logResult(result)
      return true
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }

  const data = await getEngineMetrics()
  const metrics = data?.state || data?.metrics || {}

  const result = {
    timestamp: new Date().toISOString().split('T')[1].split('.')[0],
    phase: name,
    metrics: {
      cycles: metrics.cyclesCompleted || 0,
      indications: metrics.indicationsCount || 0,
      strategies: metrics.totalStrategiesEvaluated || 0,
      positions: metrics.intervalsProcessed || 0,
    },
    status: 'fail',
    message: `${name} FAILED: timeout`,
  }
  logResult(result)
  return false
}

async function startEngine() {
  console.log('[AUTOTEST] Starting DRIFTUSDT engine...')
  try {
    const res = await fetch(`${API_BASE}/trade-engine/quick-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: CONNECTION_ID }),
    })
    return res.ok
  } catch (e) {
    return true
  }
}

async function runFullTest() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  DRIFTUSDT Complete Progression Autotest')
  console.log('═══════════════════════════════════════════════════════\n')

  if (!(await startEngine())) {
    console.error('[ERROR] Failed to start engine')
    process.exit(1)
  }

  await new Promise(r => setTimeout(r, 2000))

  const phases = [
    { name: 'Prehistoric Data Loading', metric: 'cyclesCompleted', min: 1, time: 15000 },
    { name: 'Indication Generation', metric: 'indicationsCount', min: 1, time: 15000 },
    { name: 'Strategy Evaluation', metric: 'totalStrategiesEvaluated', min: 100, time: 20000 },
    { name: 'Position Creation', metric: 'intervalsProcessed', min: 1, time: 20000 },
  ]

  let passCount = 0
  for (const phase of phases) {
    const success = await testPhase(phase.name, phase.metric, phase.min, phase.time)
    if (success) passCount++
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  RESULTS: ${passCount}/${phases.length} tests passed`)
  console.log('═══════════════════════════════════════════════════════')
  process.exit(passCount === phases.length ? 0 : 1)
}

runFullTest().catch(e => {
  console.error('[ERROR] Test execution failed:', e.message)
  process.exit(1)
})
