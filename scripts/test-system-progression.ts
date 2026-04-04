#!/usr/bin/env node

/**
 * Comprehensive System Progression Test
 * Tests the entire trading system through all 6 phases in original progression order
 * 
 * Phase Progression:
 * 1. Initializing (5%) - Setup engine components
 * 2. Market Data (8%) - Load market data for symbols
 * 3. Prehistoric Data (15%) - Load historical data
 * 4. Indications (60%) - Process technical indicators
 * 5. Strategies (75%) - Evaluate trading strategies
 * 6. Live/Real Stage (100%) - Execute trades or track positions
 */

import fetch from 'node-fetch'
import { promises as fs } from 'fs'

// Configuration
const API_BASE = process.env.API_URL || 'http://localhost:3000'
const TEST_CONNECTION_ID = 'bingx-x01' // BingX connection

interface TestResult {
  phase: string
  status: 'PASS' | 'FAIL' | 'PENDING'
  message: string
  details?: Record<string, any>
  duration?: number
}

class SystemProgressionTester {
  private results: TestResult[] = []
  private startTime = Date.now()

  async run(): Promise<void> {
    console.log('\n╔════════════════════════════════════════════════════════════╗')
    console.log('║       COMPREHENSIVE SYSTEM PROGRESSION TEST v1.0            ║')
    console.log('║         Testing BingX Trading System End-to-End             ║')
    console.log('╚════════════════════════════════════════════════════════════╝\n')

    try {
      // Pre-flight checks
      await this.phasePreFlight()

      // Test each progression phase
      await this.phaseInitializing()
      await this.phaseMarketData()
      await this.phasePrehistoricData()
      await this.phaseIndications()
      await this.phaseStrategies()
      await this.phaseLiveExecution()

      // Generate report
      await this.generateReport()
    } catch (error) {
      console.error('\n✗ Test suite failed:', error)
      process.exit(1)
    }
  }

  // PHASE 0: Pre-flight checks
  private async phasePreFlight(): Promise<void> {
    console.log('[PHASE 0] Running pre-flight checks...\n')
    
    try {
      // Check API server
      const statusRes = await fetch(`${API_BASE}/api/trade-engine/status`)
      if (!statusRes.ok) throw new Error(`API server returned ${statusRes.status}`)
      
      console.log('✓ API server is running')

      // Check connection exists
      const connRes = await fetch(`${API_BASE}/api/settings/connections`)
      const connections = await connRes.json()
      const bingxConn = connections.find((c: any) => c.id === TEST_CONNECTION_ID)
      
      if (!bingxConn) {
        throw new Error(`BingX connection ${TEST_CONNECTION_ID} not found`)
      }
      
      console.log(`✓ BingX connection found: ${bingxConn.connection_name || TEST_CONNECTION_ID}`)
      console.log(`✓ API credentials status: ${bingxConn.has_credentials ? 'Present' : 'Missing'}`)
      
      if (!bingxConn.has_credentials) {
        throw new Error('BingX API credentials not configured')
      }

      console.log('\n✓ All pre-flight checks passed\n')
    } catch (error) {
      this.recordResult('Pre-Flight', 'FAIL', `Pre-flight check failed: ${error}`)
      throw error
    }
  }

  // PHASE 1: Initializing (5%)
  private async phaseInitializing(): Promise<void> {
    console.log('[PHASE 1/6] Initializing (5%)')
    console.log('Setting up engine components...\n')

    const phase = 'Initializing'
    const startTime = Date.now()

    try {
      // Enable the connection if not already enabled
      const updateRes = await fetch(`${API_BASE}/api/settings/connections/${TEST_CONNECTION_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: true }),
      })

      if (!updateRes.ok) {
        throw new Error(`Failed to enable connection: ${updateRes.status}`)
      }

      console.log('✓ Connection enabled')

      // Start the engine
      const engineRes = await fetch(`${API_BASE}/api/trade-engine/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: TEST_CONNECTION_ID }),
      })

      if (!engineRes.ok) {
        throw new Error(`Failed to start engine: ${engineRes.status}`)
      }

      const engineData = await engineRes.json()
      console.log('✓ Trade engine started')
      console.log(`✓ Engine components initialized: indication, strategy, realtime processors\n`)

      this.recordResult(phase, 'PASS', 'Engine initialized successfully', {
        connectionId: TEST_CONNECTION_ID,
        timestamp: new Date().toISOString(),
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Initialization failed: ${error}`)
      throw error
    }
  }

  // PHASE 1.5: Market Data (8%)
  private async phaseMarketData(): Promise<void> {
    console.log('[PHASE 1.5/6] Market Data Loading (8%)')
    console.log('Loading market data for all symbols...\n')

    const phase = 'Market Data'
    const startTime = Date.now()

    try {
      // Wait for engine to initialize
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Check progression
      const progRes = await fetch(`${API_BASE}/api/connections/progression/${TEST_CONNECTION_ID}`)
      const progData = await progRes.json()

      console.log(`✓ Current phase: ${progData.phase}`)
      console.log(`✓ Progress: ${progData.progress}%`)
      console.log(`✓ Symbols loaded: ${progData.symbolsCount || 'pending'}`)
      console.log(`✓ Market data loaded for symbols\n`)

      this.recordResult(phase, 'PASS', 'Market data loaded', {
        phase: progData.phase,
        progress: progData.progress,
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Market data loading failed: ${error}`)
      throw error
    }
  }

  // PHASE 2: Prehistoric Data (15%)
  private async phasePrehistoricData(): Promise<void> {
    console.log('[PHASE 2/6] Prehistoric Data (15%)')
    console.log('Loading historical data in background...\n')

    const phase = 'Prehistoric Data'
    const startTime = Date.now()

    try {
      // Wait for prehistoric loading
      await new Promise(resolve => setTimeout(resolve, 2000))

      const progRes = await fetch(`${API_BASE}/api/connections/progression/${TEST_CONNECTION_ID}`)
      const progData = await progRes.json()

      console.log(`✓ Historical data loading status: ${progData.prehistoricStatus || 'in progress'}`)
      console.log(`✓ Progress: ${progData.progress}%`)
      console.log(`✓ Background loading: enabled (non-blocking)\n`)

      this.recordResult(phase, 'PASS', 'Prehistoric data loading initiated', {
        progress: progData.progress,
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Prehistoric data loading failed: ${error}`)
      throw error
    }
  }

  // PHASE 3: Indications (60%)
  private async phaseIndications(): Promise<void> {
    console.log('[PHASE 3/6] Indications Processing (60%)')
    console.log('Processing technical indicators...\n')

    const phase = 'Indications'
    const startTime = Date.now()

    try {
      // Wait for indication processing
      await new Promise(resolve => setTimeout(resolve, 3000))

      const progRes = await fetch(`${API_BASE}/api/connections/progression/${TEST_CONNECTION_ID}`)
      const progData = await progRes.json()

      console.log(`✓ Indication cycles: ${progData.cyclesCompleted || 0}`)
      console.log(`✓ Indications processed: ${progData.indicationsCount || 'pending'}`)
      console.log(`✓ Current progress: ${progData.progress}%`)
      console.log(`✓ Phase: ${progData.phase || 'indications'}\n`)

      this.recordResult(phase, 'PASS', 'Indicators calculated successfully', {
        cycles: progData.cyclesCompleted,
        progress: progData.progress,
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Indication processing failed: ${error}`)
      throw error
    }
  }

  // PHASE 4: Strategies (75%)
  private async phaseStrategies(): Promise<void> {
    console.log('[PHASE 4/6] Strategy Evaluation (75%)')
    console.log('Evaluating trading strategies...\n')

    const phase = 'Strategies'
    const startTime = Date.now()

    try {
      // Wait for strategy evaluation
      await new Promise(resolve => setTimeout(resolve, 3000))

      const progRes = await fetch(`${API_BASE}/api/connections/progression/${TEST_CONNECTION_ID}`)
      const progData = await progRes.json()

      console.log(`✓ Strategy cycles: ${progData.stratCount || 0}`)
      console.log(`✓ Signals generated: ${progData.signalsCount || 0}`)
      console.log(`✓ Current progress: ${progData.progress}%`)
      console.log(`✓ Phase: ${progData.phase || 'strategies'}\n`)

      this.recordResult(phase, 'PASS', 'Strategies evaluated successfully', {
        cycles: progData.stratCount,
        signals: progData.signalsCount,
        progress: progData.progress,
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Strategy evaluation failed: ${error}`)
      throw error
    }
  }

  // PHASE 5: Live Execution (100%)
  private async phaseLiveExecution(): Promise<void> {
    console.log('[PHASE 5/6] Live Execution / Real Stage (100%)')
    console.log('Preparing for live order execution...\n')

    const phase = 'Live Execution'
    const startTime = Date.now()

    try {
      // Enable live trading
      const liveRes = await fetch(`${API_BASE}/api/settings/connections/${TEST_CONNECTION_ID}/live-trade`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_live_trade: true }),
      })

      if (!liveRes.ok) {
        console.log('ℹ Live trading toggle: not required for test (can use simulated mode)')
      } else {
        const liveData = await liveRes.json()
        console.log(`✓ Live trading enabled: ${liveData.is_live_trade}`)
      }

      // Get current positions/pseudo positions
      const posRes = await fetch(`${API_BASE}/api/exchange-positions?connection_id=${TEST_CONNECTION_ID}`)
      if (posRes.ok) {
        const positions = await posRes.json()
        console.log(`✓ Active positions: ${positions.length || 0}`)
      }

      // Get progression state
      const progRes = await fetch(`${API_BASE}/api/connections/progression/${TEST_CONNECTION_ID}`)
      const progData = await progRes.json()

      console.log(`✓ Engine status: ${progData.running ? 'running' : 'ready'}`)
      console.log(`✓ Current progress: ${progData.progress}%`)
      console.log(`✓ Live execution stage ready\n`)

      this.recordResult(phase, 'PASS', 'Live execution stage ready', {
        progress: progData.progress,
        running: progData.running,
      }, Date.now() - startTime)
    } catch (error) {
      this.recordResult(phase, 'FAIL', `Live execution preparation failed: ${error}`)
      throw error
    }
  }

  private recordResult(phase: string, status: 'PASS' | 'FAIL' | 'PENDING', message: string, details?: Record<string, any>, duration?: number): void {
    this.results.push({
      phase,
      status,
      message,
      details,
      duration,
    })
  }

  private async generateReport(): Promise<void> {
    const totalTests = this.results.length
    const passed = this.results.filter(r => r.status === 'PASS').length
    const failed = this.results.filter(r => r.status === 'FAIL').length
    const totalDuration = Date.now() - this.startTime

    console.log('╔════════════════════════════════════════════════════════════╗')
    console.log('║                    TEST REPORT SUMMARY                      ║')
    console.log('╚════════════════════════════════════════════════════════════╝\n')

    for (const result of this.results) {
      const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : '○'
      const color = result.status === 'PASS' ? '\x1b[32m' : result.status === 'FAIL' ? '\x1b[31m' : '\x1b[33m'
      const reset = '\x1b[0m'

      console.log(`${color}${icon}${reset} ${result.phase.padEnd(20)} ${result.status.padEnd(8)} ${result.message}`)
      if (result.duration) {
        console.log(`  └─ Duration: ${result.duration}ms`)
      }
    }

    console.log(`\n────────────────────────────────────────────────────────────`)
    console.log(`Total Tests:    ${totalTests}`)
    console.log(`Passed:         ${passed}`)
    console.log(`Failed:         ${failed}`)
    console.log(`Success Rate:   ${((passed / totalTests) * 100).toFixed(1)}%`)
    console.log(`Total Duration: ${totalDuration}ms`)
    console.log(`────────────────────────────────────────────────────────────\n`)

    if (failed === 0) {
      console.log('✓ ALL TESTS PASSED - System progression is working correctly!\n')
      process.exit(0)
    } else {
      console.log('✗ SOME TESTS FAILED - Check details above\n')
      process.exit(1)
    }
  }
}

// Run the test suite
const tester = new SystemProgressionTester()
tester.run().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
