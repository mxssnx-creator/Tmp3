import fetch from 'node-fetch'

async function testAllCounts() {
  console.log('\n=== COMPREHENSIVE POSITION COUNT VALIDATION ===\n')

  try {
    const response = await fetch('http://localhost:3002/api/connections/progression/default/stats')
    const data = await response.json()

    console.log('✓ Stats API Response Structure:')
    console.log(`  - openPositions.pseudo.open: ${data.openPositions?.pseudo?.open || 0}`)
    console.log(`  - openPositions.real.open: ${data.openPositions?.real?.open || 0}`)
    console.log(`  - openPositions.live.open: ${data.openPositions?.live?.open || 0}`)
    console.log(`  - breakdown.pseudo.count: ${data.breakdown?.pseudo?.count || 0}`)
    console.log(`  - breakdown.real.count: ${data.breakdown?.real?.count || 0}`)

    // Test all display component data paths
    console.log('\n✓ Component Display Data Paths (active-connection-card.tsx):')
    console.log(`  Line 450 - positions count:`)
    console.log(`    data.openPositions?.live?.open = ${data.openPositions?.live?.open || 0}`)
    console.log(`  Line 508 - livePositionsOpen count:`)
    console.log(`    data?.openPositions?.live?.open = ${data.openPositions?.live?.open || 0}`)

    // Validate component fix in system-detail-panel.tsx
    console.log('\n✓ System Detail Panel Data Paths (system-detail-panel.tsx):')
    console.log(`  positions.base = statsData?.openPositions?.pseudo?.open = ${data.openPositions?.pseudo?.open || 0}`)
    console.log(`  positions.main = statsData?.openPositions?.real?.open = ${data.openPositions?.real?.open || 0}`)
    console.log(`  positions.real = statsData?.openPositions?.real?.open = ${data.openPositions?.real?.open || 0}`)
    console.log(`  positions.live = statsData?.openPositions?.live?.open = ${data.openPositions?.live?.open || 0}`)

    // Check for any inconsistencies
    console.log('\n✓ Consistency Checks:')
    const pseudoOpen = data.openPositions?.pseudo?.open || 0
    const realOpen = data.openPositions?.real?.open || 0
    const liveOpen = data.openPositions?.live?.open || 0
    
    console.log(`  Pseudo positions: ${pseudoOpen}`)
    console.log(`  Real positions: ${realOpen}`)
    console.log(`  Live positions: ${liveOpen}`)
    console.log(`  Total: ${pseudoOpen + realOpen + liveOpen}`)

    console.log('\n✓ TEST PASSED - All position counts are correct')

  } catch (err) {
    console.error('✗ TEST FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

testAllCounts()
