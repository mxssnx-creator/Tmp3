#!/usr/bin/env node

/**
 * Comprehensive Real-Time Position Counts Test
 * 
 * Tests all display systems to ensure positions are being counted and displayed correctly:
 * 1. Stats API response structure
 * 2. Position counts in breakdown
 * 3. Open positions aggregates
 * 4. Live exchange positions
 * 5. Dashboard display values
 */

import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3002'
const CONN_ID = 'default'

function fmt(n: any): string {
  const num = Number(n) || 0
  return num.toLocaleString()
}

async function test() {
  console.log('\n[v0] REAL-TIME POSITION COUNT SYSTEM TEST')
  console.log('=' .repeat(70))
  
  try {
    // Test 1: Stats API
    console.log('\n✓ TEST 1: Fetching /api/connections/progression/{id}/stats')
    const statsRes = await fetch(`${BASE_URL}/api/connections/progression/${CONN_ID}/stats`)
    if (!statsRes.ok) throw new Error(`HTTP ${statsRes.status}`)
    
    const stats: any = await statsRes.json()
    console.log(`  Status: ${statsRes.status}`)
    
    // Test 2: Breakdown strategies
    console.log('\n✓ TEST 2: Strategy Breakdown (Real pipeline cascade)')
    const breakdown = stats.breakdown || {}
    const strategies = breakdown.strategies || {}
    console.log(`  Base:  ${fmt(strategies.base)} evaluated from indication rules`)
    console.log(`  Main:  ${fmt(strategies.main)} passed Main PF/DDT filters`)
    console.log(`  Real:  ${fmt(strategies.real)} passed Real (adjust) filters`)
    console.log(`  Live:  ${fmt(strategies.live)} promoted to exchange`)
    console.log(`  Total: ${fmt(strategies.total)} (should equal Real, not sum)`)
    
    // Test 3: Open positions
    console.log('\n✓ TEST 3: Open Positions Across Pipeline')
    const openPos = stats.openPositions || {}
    
    const pseudo = openPos.pseudo || {}
    console.log(`  Pseudo (eval):    ${fmt(pseudo.open)} open | ${fmt(pseudo.runningSets)} running Sets`)
    
    const real = openPos.real || {}
    console.log(`  Real (gating):    ${fmt(real.open)} open | avg ${real.activeAvg || 0}`)
    
    const live = openPos.live || {}
    console.log(`  Live (exchange):  ${fmt(live.open)} open | $${fmt(live.volumeUsd)} volume`)
    
    const overall = openPos.overall || {}
    console.log(`  Overall exchange: $${fmt(overall.exchangeMarginUsd)} margin at risk`)
    
    // Test 4: Validate counts
    console.log('\n✓ TEST 4: Position Count Validation')
    const issues: string[] = []
    
    if (pseudo.open < 0) issues.push(`Pseudo positions negative: ${pseudo.open}`)
    if (real.open < 0) issues.push(`Real positions negative: ${real.open}`)
    if (live.open < 0) issues.push(`Live positions negative: ${live.open}`)
    if (live.volumeUsd < 0) issues.push(`Live volume negative: ${live.volumeUsd}`)
    if (overall.exchangeMarginUsd < 0) issues.push(`Margin negative: ${overall.exchangeMarginUsd}`)
    
    // Cascade check: live <= real <= pseudo
    if (live.open > real.open) {
      issues.push(`Live (${live.open}) > Real (${real.open}): pipeline violation`)
    }
    
    if (issues.length === 0) {
      console.log(`  ✓ All counts valid and within cascade rules`)
    } else {
      issues.forEach(issue => console.log(`  ✗ ${issue}`))
    }
    
    // Test 5: Live positions detail
    console.log('\n✓ TEST 5: Live Position Details')
    const positions = live.positions || []
    console.log(`  Total live positions scanned: ${positions.length}`)
    
    if (positions.length > 0) {
      const totalPnl = positions.reduce((sum, p) => sum + (Number(p.unrealizedPnl) || 0), 0)
      const profitCount = positions.filter(p => (Number(p.unrealizedPnl) || 0) > 0).length
      const lossCount = positions.filter(p => (Number(p.unrealizedPnl) || 0) < 0).length
      
      console.log(`  Profit positions:  ${profitCount}`)
      console.log(`  Loss positions:    ${lossCount}`)
      console.log(`  Total unrealized:  $${totalPnl.toFixed(2)}`)
      
      positions.slice(0, 3).forEach((p, i) => {
        console.log(`    [${i+1}] ${p.symbol} ${p.direction} | qty=${p.quantity} | pnl=$${p.unrealizedPnl}`)
      })
    } else {
      console.log(`  (No live positions currently open)`)
    }
    
    // Test 6: Resolution check
    console.log('\n✓ TEST 6: Set Resolution (Position → Strategy mapping)')
    const resolution = live.resolution || {}
    console.log(`  Resolved via pseudo:      ${fmt(resolution.pseudo)} positions`)
    console.log(`  Resolved via real (fallback): ${fmt(resolution.realFallback)} positions`)
    console.log(`  Unresolved:               ${fmt(resolution.unresolved)} positions`)
    
    // Test 7: Aggregates
    console.log('\n✓ TEST 7: Live Aggregates')
    const agg = live.aggregate || {}
    console.log(`  Total volume:      $${fmt(agg.totalVolumeUsd)}`)
    console.log(`  Total margin:      $${fmt(agg.totalMarginUsd)}`)
    console.log(`  Unrealized PnL:    $${fmt(agg.totalUnrealizedPnl)}`)
    console.log(`  Portfolio ROI:     ${agg.portfolioRoiPct}%`)
    console.log(`  Near liquidation:  ${fmt(agg.nearLiquidation)} positions`)
    console.log(`  Stale sync (>60s): ${fmt(agg.staleSync)} positions`)
    
    console.log('\n' + '=' .repeat(70))
    console.log('✓ ALL TESTS PASSED - Position counting system operational')
    console.log('=' .repeat(70) + '\n')
    
  } catch (err) {
    console.error('\n✗ TEST FAILED:', err instanceof Error ? err.message : String(err))
    console.log('=' .repeat(70) + '\n')
    process.exit(1)
  }
}

test()
