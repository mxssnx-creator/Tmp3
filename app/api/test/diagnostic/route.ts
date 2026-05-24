import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    console.log("[v0] [Diagnostic] Starting comprehensive system diagnostic...")
    await initRedis()
    const client = getRedisClient()

    // Test 1: Get all keys and group by prefix
    const allKeys = await client.keys("*")
    console.log(`[v0] [Diagnostic] Total keys in Redis: ${allKeys.length}`)

    // Group by prefix
    const keyGroups: Record<string, number> = {}
    for (const key of allKeys) {
      const prefix = key.split(":")[0]
      keyGroups[prefix] = (keyGroups[prefix] || 0) + 1
    }

    const progressionKeys = allKeys.filter(k => k.startsWith("progression:"))
    console.log(`[v0] [Diagnostic] Found ${progressionKeys.length} progression states`)

    // Test 2: Check strategy sets
    const baseSetKeys = await client.keys("strategies:*:base:*")
    const mainSetKeys = await client.keys("strategies:*:main:*")
    const realSetKeys = await client.keys("strategies:*:real:*")

    console.log(`[v0] [Diagnostic] Base sets: ${baseSetKeys.length}, Main sets: ${mainSetKeys.length}, Real sets: ${realSetKeys.length}`)

    // Test 3: Check positions (correct key pattern)
    const basePositions = await client.keys("base:position:*")
    const mainPositions = await client.keys("main:position:*")
    const realPositions = await client.keys("real:position:*")

    console.log(`[v0] [Diagnostic] Base positions: ${basePositions.length}, Main positions: ${mainPositions.length}, Real positions: ${realPositions.length}`)

    // Test 4: Check trades
    const trades = await client.keys("trade:*")
    console.log(`[v0] [Diagnostic] Total trades: ${trades.length}`)

    // Test 5: Get first progression state details
    let progressionDetails = null
    if (progressionKeys.length > 0) {
      const firstProgKey = progressionKeys[0]
      const prog = await client.hgetall(firstProgKey)
      progressionDetails = {
        key: firstProgKey,
        fields: Object.keys(prog).length,
        cycles_completed: prog.cycles_completed,
        total_trades: prog.total_trades,
        successful_trades: prog.successful_trades,
        position_count: prog.position_count,
        prehistoric_phase_active: prog.prehistoric_phase_active,
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      success: true,
      summary: {
        totalKeys: allKeys.length,
        keysByPrefix: keyGroups,
        progressionStates: progressionKeys.length,
        sets: {
          base: baseSetKeys.length,
          main: mainSetKeys.length,
          real: realSetKeys.length,
        },
        positions: {
          base: basePositions.length,
          main: mainPositions.length,
          real: realPositions.length,
          total: basePositions.length + mainPositions.length + realPositions.length,
        },
        trades: trades.length,
      },
      firstProgressionState: progressionDetails,
      dataFlow: {
        baseToMainRatio: baseSetKeys.length > 0 ? (mainSetKeys.length / baseSetKeys.length).toFixed(2) : "N/A",
        mainToRealRatio: mainSetKeys.length > 0 ? (realSetKeys.length / mainSetKeys.length).toFixed(2) : "N/A",
        positionCreationRatio: basePositions.length > 0 ? ((mainPositions.length + realPositions.length) / basePositions.length).toFixed(2) : "N/A",
      },
      issues: [] as string[],
    }

    // Identify issues
    if (baseSetKeys.length > 0 && mainSetKeys.length === 0) {
      report.issues.push("Base sets created but no Main sets - Stage Main validation may be blocking")
    }
    if (mainSetKeys.length > 0 && realSetKeys.length === 0) {
      report.issues.push("Main sets created but no Real sets - Stage Real validation too strict")
    }
    if (basePositions.length > 0 && mainPositions.length === 0) {
      report.issues.push("Base positions created but no Main positions - Position transformation failing")
    }
    if (mainPositions.length > 0 && realPositions.length === 0) {
      report.issues.push("Main positions created but no Real positions - Real stage not executing")
    }

    console.log("[v0] [Diagnostic] Report complete")

    return NextResponse.json(report, { status: 200 })
  } catch (error) {
    console.error("[v0] [Diagnostic] Error:", error)
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}
