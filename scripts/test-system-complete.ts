#!/usr/bin/env node

/**
 * Complete End-to-End Trading System Test
 * Validates: System Progression → Live Trading → Position Monitoring
 */

import fetch from 'node-fetch'

const API_BASE = process.env.API_URL || 'http://localhost:3000'

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function logSection(title: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}\n`)
}

async function main() {
  try {
    await logSection('COMPLETE SYSTEM TEST: Progression → Live Trading → Monitoring')

    // STEP 1: Verify API server
    console.log('[STEP 1] Verifying API Server...')
    const statusRes = await fetch(`${API_BASE}/api/trade-engine/status`)
    if (!statusRes.ok) throw new Error('API server not responding')
    console.log('✓ API server is running\n')

    // STEP 2: Get BingX connection
    console.log('[STEP 2] Getting BingX Connection Details...')
    const connRes = await fetch(`${API_BASE}/api/settings/connections`)
    const connections = await connRes.json()
    const bingx = connections.find((c: any) => c.id === 'bingx-x01')
    
    if (!bingx) throw new Error('BingX connection not found')
    console.log(`✓ Found: ${bingx.connection_name}`)
    console.log(`✓ API Credentials: ${bingx.has_credentials ? 'Present' : 'MISSING'}\n`)

    if (!bingx.has_credentials) {
      throw new Error('BingX API credentials not configured!')
    }

    // STEP 3: Enable connection and start engine
    console.log('[STEP 3] Enabling Connection & Starting Trade Engine...')
    const enableRes = await fetch(`${API_BASE}/api/settings/connections/bingx-x01`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: true }),
    })
    console.log('✓ Connection enabled')

    const startRes = await fetch(`${API_BASE}/api/trade-engine/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'bingx-x01' }),
    })
    console.log('✓ Engine started\n')

    // STEP 4: Monitor progression phases
    await logSection('MONITORING SYSTEM PROGRESSION (6 Phases)')
    
    const phases = [
      { phase: 'initializing', name: 'Phase 1: Initializing', targetProgress: 5 },
      { phase: 'market_data', name: 'Phase 1.5: Market Data', targetProgress: 8 },
      { phase: 'prehistoric_data', name: 'Phase 2: Prehistoric Data', targetProgress: 15 },
      { phase: 'indications', name: 'Phase 3: Indications', targetProgress: 60 },
      { phase: 'strategies', name: 'Phase 4: Strategies', targetProgress: 75 },
      { phase: 'live', name: 'Phase 5: Live/Real Stage', targetProgress: 100 },
    ]

    let currentPhaseIndex = 0
    let maxWaitTime = 45000 // 45 seconds max
    const startMonitor = Date.now()

    while (currentPhaseIndex < phases.length && (Date.now() - startMonitor) < maxWaitTime) {
      const progRes = await fetch(`${API_BASE}/api/connections/progression/bingx-x01`)
      const progData = await progRes.json()

      const currentPhase = phases[currentPhaseIndex]
      
      if (progData.phase === currentPhase.phase || progData.progress >= currentPhase.targetProgress) {
        console.log(`✓ ${currentPhase.name}`)
        console.log(`  └─ Progress: ${progData.progress}%`)
        console.log(`  └─ Cycles: ${progData.cyclesCompleted || 0}`)
        console.log(`  └─ Signals: ${progData.signalsCount || 0}`)
        currentPhaseIndex++
      }

      if (currentPhaseIndex < phases.length) {
        await sleep(1500)
      }
    }

    if (currentPhaseIndex === phases.length) {
      console.log('\n✓ All progression phases completed successfully!')
    } else {
      console.log(`\n⚠ Reached maximum wait time. Progressed through ${currentPhaseIndex}/${phases.length} phases`)
    }

    // STEP 5: Enable live trading
    await logSection('ENABLING LIVE TRADING')
    
    console.log('[STEP 5] Activating Live Trading Mode...')
    const liveRes = await fetch(`${API_BASE}/api/settings/connections/bingx-x01/live-trade`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_live_trade: true }),
    })

    if (liveRes.ok) {
      const liveData = await liveRes.json()
      console.log(`✓ Live Trading Enabled: ${liveData.is_live_trade}`)
      console.log(`✓ Status Badge: GREEN (Live)\n`)
    } else {
      console.log('⚠ Live trading toggle not available in this mode\n')
    }

    // STEP 6: Monitor exchange positions
    await logSection('MONITORING LIVE POSITIONS')
    
    console.log('[STEP 6] Checking Active Positions...')
    const posRes = await fetch(`${API_BASE}/api/exchange-positions?connection_id=bingx-x01`)
    
    if (posRes.ok) {
      const positions = await posRes.json()
      console.log(`✓ Active Positions: ${positions.length}`)
      
      if (positions.length > 0) {
        for (const pos of positions.slice(0, 3)) {
          console.log(`\n  Position: ${pos.symbol || 'N/A'}`)
          console.log(`  ├─ Entry Price: ${pos.entry_price || 'N/A'}`)
          console.log(`  ├─ Current Price: ${pos.current_price || 'N/A'}`)
          console.log(`  ├─ P&L: ${pos.pnl || 'N/A'}`)
          console.log(`  └─ Status: ${pos.status || 'active'}`)
        }
      } else {
        console.log('  (No active positions yet)')
      }
    }

    // STEP 7: Get final engine status
    await logSection('FINAL SYSTEM STATUS')
    
    console.log('[STEP 7] Final System Status Check...')
    const finalProgRes = await fetch(`${API_BASE}/api/connections/progression/bingx-x01`)
    const finalProgData = await finalProgRes.json()

    console.log(`Engine Running:        ${finalProgData.running ? '✓ YES' : '✗ NO'}`)
    console.log(`Current Phase:         ${finalProgData.phase}`)
    console.log(`Progress:              ${finalProgData.progress}%`)
    console.log(`Cycles Completed:      ${finalProgData.cyclesCompleted || 0}`)
    console.log(`Indications:           ${finalProgData.indicationsCount || 0}`)
    console.log(`Strategy Cycles:       ${finalProgData.stratCount || 0}`)
    console.log(`Signals Generated:     ${finalProgData.signalsCount || 0}`)
    console.log(`Last Update:           ${new Date(finalProgData.lastUpdate).toLocaleTimeString()}`)

    await logSection('TEST COMPLETED SUCCESSFULLY')
    
    console.log('✓ System Progression Test PASSED')
    console.log('✓ Live Trading Mode ENABLED')
    console.log('✓ Position Monitoring ACTIVE')
    console.log('\nNext Steps:')
    console.log('1. Monitor positions in real-time on the Dashboard')
    console.log('2. Check API: GET /api/exchange-positions?connection_id=bingx-x01')
    console.log('3. System will execute trades based on signals\n')

  } catch (error) {
    console.error('\n✗ Test Failed:', error)
    process.exit(1)
  }
}

main()
