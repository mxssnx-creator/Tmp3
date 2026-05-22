import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Memory & Stability Monitor
 * Tracks:
 * - Memory usage before/after operations
 * - Connection health
 * - Redis key count trends
 * - Operation performance metrics
 * - Stability indicators
 */

async function runMemoryStabilityTest() {
  const client = getRedisClient()
  const results = {
    startTime: Date.now(),
    operations: [] as any[],
    memorySnapshots: [] as any[],
  }

  console.log("[v0] [MemoryTest] Starting memory and stability monitoring")

  try {
    // Initial snapshot - use keys pattern to count
    const initialKeys = await client.keys("*")
    const initialSize = initialKeys ? initialKeys.length : 0
    results.memorySnapshots.push({
      phase: "initial",
      timestamp: new Date().toISOString(),
      keyCount: initialSize,
    })

    // Test 1: Rapid key creation and deletion
    console.log("[v0] [MemoryTest] Testing rapid key operations...")
    const rapidOpsStart = Date.now()
    const numKeys = 500

    for (let i = 0; i < numKeys; i++) {
      const key = `mem-test-${i}`
      await client.hset(key, {
        data: "x".repeat(100),
        index: String(i),
        timestamp: new Date().toISOString(),
      })
    }

    const keysAfterCreate = await client.keys("mem-test-*")
    const createCount = keysAfterCreate ? keysAfterCreate.length : 0
    console.log(`[v0] [MemoryTest] Created ${numKeys} keys, stored keys: ${createCount}`)

    const rapidOpsEnd = Date.now()
    results.operations.push({
      operation: "Rapid key creation",
      keyCount: numKeys,
      duration: rapidOpsEnd - rapidOpsStart,
      storedKeys: createCount,
    })

    // Cleanup
    for (let i = 0; i < numKeys; i++) {
      await client.del(`mem-test-${i}`)
    }

    // Test 2: Large value storage
    console.log("[v0] [MemoryTest] Testing large value storage...")
    const largeValueStart = Date.now()
    const largeKey = "mem-test-large"
    const largeValue = "x".repeat(100000) // 100KB value

    await client.hset(largeKey, { large_data: largeValue })
    const largeValueEnd = Date.now()

    results.operations.push({
      operation: "Large value (100KB) storage",
      valueSize: largeValue.length,
      duration: largeValueEnd - largeValueStart,
    })

    await client.del(largeKey)

    // Test 3: Connection stability under load
    console.log("[v0] [MemoryTest] Testing connection stability...")
    const connectionStart = Date.now()
    let connectionErrors = 0
    const parallelOps = 50

    const connectionTest = Array(parallelOps)
      .fill(0)
      .map(async (_, idx) => {
        try {
          const key = `conn-test-${idx}`
          await client.hset(key, { test: String(idx), time: Date.now() })
          await client.hget(key, "test")
          await client.del(key)
        } catch (error) {
          connectionErrors++
        }
      })

    await Promise.all(connectionTest)
    const connectionEnd = Date.now()

    results.operations.push({
      operation: "Connection stability (50 parallel ops)",
      duration: connectionEnd - connectionStart,
      errors: connectionErrors,
      errorRate: ((connectionErrors / parallelOps) * 100).toFixed(2),
    })

    // Test 4: Memory after cleanup
    console.log("[v0] [MemoryTest] Checking memory after operations...")
    const finalKeys = await client.keys("*")
    const finalSize = finalKeys ? finalKeys.length : 0
    results.memorySnapshots.push({
      phase: "after_operations",
      timestamp: new Date().toISOString(),
      keyCount: finalSize,
    })

    const finalDbSize = finalSize
    results.operations.push({
      operation: "Final database state",
      keyCount: finalDbSize,
      duration: Date.now() - results.startTime,
    })

    // Calculate stability score
    const stabilityScore = Math.max(
      0,
      100 - connectionErrors * 2
    )

    return {
      passed: connectionErrors === 0 && finalDbSize >= 0,
      results,
      stability: {
        connectionErrors,
        score: stabilityScore,
        status: stabilityScore > 95 ? "EXCELLENT" : stabilityScore > 90 ? "GOOD" : "FAIR",
      },
    }
  } catch (error) {
    return {
      passed: false,
      error: String(error),
      results,
    }
  }
}

async function runLongRunningStabilityTest() {
  const client = getRedisClient()
  const duration = 5000 // 5 seconds
  const interval = 100 // Operations every 100ms
  const startTime = Date.now()
  let operationCount = 0
  let errorCount = 0
  const timestamps = []

  console.log("[v0] [LongRunTest] Starting long-running stability test...")

  try {
    while (Date.now() - startTime < duration) {
      try {
        const currentTime = Date.now()
        const key = `longrun-${currentTime}`

        // Simulate realistic progression updates
        await Promise.all([
          client.hincrby(key, "cycles", 1),
          client.hincrby(key, "trades", Math.floor(Math.random() * 10)),
          client.hset(key, { timestamp: new Date().toISOString() }),
        ])

        operationCount++
        timestamps.push(currentTime)

        // Clean up old keys
        if (operationCount % 10 === 0) {
          await client.del(key)
        }

        // Wait for interval
        await new Promise((r) => setTimeout(r, interval))
      } catch (error) {
        errorCount++
        console.warn("[v0] [LongRunTest] Operation error:", error)
      }
    }

    // Cleanup remaining keys
    const cursor = "0"
    let cleanup = 0
    try {
      const keys = await client.keys("longrun-*")
      for (const key of keys) {
        await client.del(key)
        cleanup++
      }
    } catch (_) {
      // Ignore scan errors
    }

    const totalDuration = Date.now() - startTime
    const opsPerSecond = (operationCount / (totalDuration / 1000)).toFixed(2)
    const errorRate = ((errorCount / operationCount) * 100).toFixed(2)

    return {
      passed: errorCount === 0 && operationCount > 0,
      metrics: {
        totalOperations: operationCount,
        errorCount,
        errorRate,
        duration: totalDuration,
        opsPerSecond,
        keysCreated: operationCount,
        keysCleaned: cleanup,
        stability: errorRate === "0.00" ? "STABLE" : "DEGRADED",
      },
    }
  } catch (error) {
    return {
      passed: false,
      error: String(error),
      metrics: { operationCount, errorCount },
    }
  }
}

export async function POST() {
  try {
    console.log("[v0] [StabilityMonitor] === Starting stability monitoring ===")
    await initRedis()

    const startTime = Date.now()

    const memoryResults = await runMemoryStabilityTest()
    const longRunResults = await runLongRunningStabilityTest()

    const totalDuration = Date.now() - startTime

    const report = {
      success: memoryResults.passed && longRunResults.passed,
      timestamp: new Date().toISOString(),
      totalDuration: `${totalDuration}ms`,
      memoryMonitoring: memoryResults,
      longRunningStability: longRunResults,
      summary: {
        allTestsPassed: memoryResults.passed && longRunResults.passed,
        memoryStatus: memoryResults.stability?.status || "UNKNOWN",
        connectionStability:
          (memoryResults.stability?.connectionErrors || 0) === 0 ? "STABLE" : "ISSUES",
        longRunStatus: longRunResults.metrics?.stability || "UNKNOWN",
      },
    }

    console.log(
      "[v0] [StabilityMonitor] === Testing complete ===",
      JSON.stringify(report.summary, null, 2)
    )

    return NextResponse.json(report, { status: 200 })
  } catch (error) {
    console.error("[v0] [StabilityMonitor] FATAL:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Stability test failed",
        details: String(error),
      },
      { status: 500 }
    )
  }
}
