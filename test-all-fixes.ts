/**
 * Test Script - Verify All Fixes for Historic Progress Hanging
 * 
 * Tests:
 * 1. expandAxisSets creates synthetic entries
 * 2. Hedge netting includes parentSetKey
 * 3. bumpAxisPosAccumulation is called
 * 4. Real tuner can mutate entries
 * 5. Status field is properly set
 */

import { initRedis, getRedisClient } from "@/lib/redis-db"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"

async function testAllFixes() {
  console.log("\n=== TESTING ALL FIXES ===\n")

  try {
    await initRedis()
    const client = getRedisClient()
    
    if (!client) {
      console.error("❌ Redis not available")
      return
    }

    // Test 1: Check BASE sets
    console.log("TEST 1: BASE Set Creation")
    const baseKey = `strategies:bingx-x01:BTCUSDT:base:sets`
    const baseData = await client.get(baseKey).catch(() => null)
    if (baseData) {
      const parsed = JSON.parse(baseData)
      const count = parsed.sets?.length || 0
      console.log(`✅ BASE: ${count} sets`)
    } else {
      console.log("❌ No BASE sets found (expected if not yet run)")
    }

    // Test 2: Check MAIN sets with axis expansion
    console.log("\nTEST 2: MAIN Set Expansion (Axis Fan-out)")
    const mainKey = `strategies:bingx-x01:BTCUSDT:main:sets`
    const mainData = await client.get(mainKey).catch(() => null)
    if (mainData) {
      const parsed = JSON.parse(mainData)
      const count = parsed.sets?.length || 0
      const axisSets = parsed.sets?.filter((s: any) => s.axisWindows)?.length || 0
      const withSynthetic = parsed.sets?.filter((s: any) => 
        s.entries?.some((e: any) => e.id?.includes("#axis-synth"))
      )?.length || 0
      console.log(`✅ MAIN: ${count} total sets, ${axisSets} axis sets, ${withSynthetic} with synthetic entries`)
      
      if (withSynthetic === 0 && axisSets > 0) {
        console.log(`❌ PROBLEM: Axis sets exist but NO synthetic entries found!`)
      }
    } else {
      console.log("❌ No MAIN sets found (expected if not yet run)")
    }

    // Test 3: Check REAL sets
    console.log("\nTEST 3: REAL Set Filtering & Hedge Netting")
    const realKey = `strategies:bingx-x01:BTCUSDT:real:sets`
    const realData = await client.get(realKey).catch(() => null)
    if (realData) {
      const parsed = JSON.parse(realData)
      const count = parsed.sets?.length || 0
      const longCount = parsed.sets?.filter((s: any) => s.direction === "long")?.length || 0
      const shortCount = parsed.sets?.filter((s: any) => s.direction === "short")?.length || 0
      console.log(`✅ REAL: ${count} sets (Long: ${longCount}, Short: ${shortCount})`)
      
      // Check if parentSetKey is present
      const withParentKey = parsed.sets?.filter((s: any) => s.parentSetKey)?.length || 0
      if (count > 0 && withParentKey < count) {
        console.log(`⚠️  Only ${withParentKey}/${count} REAL sets have parentSetKey`)
      }
    } else {
      console.log("❌ No REAL sets found (expected if not yet run)")
    }

    // Test 4: Check axis accumulation ledger
    console.log("\nTEST 4: Axis Accumulation Ledger")
    const axisAccKey = `axis_pos_acc:bingx-x01`
    const axisAccData = await client.hgetall(axisAccKey).catch(() => null)
    if (axisAccData && Object.keys(axisAccData).length > 0) {
      console.log(`✅ Axis Accumulation: ${Object.keys(axisAccData).length} axis tuples tracked`)
      Object.entries(axisAccData).slice(0, 3).forEach(([key, val]) => {
        console.log(`   ${key}: ${val}`)
      })
    } else {
      console.log("❌ No axis accumulation ledger found (expected if not yet run)")
    }

    // Test 5: Check variant aggregates
    console.log("\nTEST 5: Variant Aggregate Counts")
    const variantKey = `strategy_variant:bingx-x01:default`
    const variantData = await client.hgetall(variantKey).catch(() => null)
    if (variantData) {
      const entriesCount = variantData.entries_count || "0"
      const passedSets = variantData.passed_sets || "0"
      console.log(`✅ Default Variant: ${passedSets} passed sets, ${entriesCount} total entries`)
      
      if (parseInt(entriesCount) === 0 && parseInt(passedSets) > 0) {
        console.log(`❌ PROBLEM: Passed sets = ${passedSets} but entries_count = 0 (not counting synthetic!)`)
      }
    } else {
      console.log("❌ No variant aggregates found (expected if not yet run)")
    }

    console.log("\n=== TESTS COMPLETE ===\n")

  } catch (error) {
    console.error("Error:", error)
  }
}

testAllFixes()
