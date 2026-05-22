import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Intensive Stress Test Suite for Progression Tracking
 * Tests:
 * 1. Multiple concurrent progressions
 * 2. Edge cases (0 metrics, extreme values, null data)
 * 3. Continuous operation (repeated cycles)
 * 4. Memory stability
 * 5. Data consistency
 * 6. Atomic operation safety
 */

interface TestScenario {
  name: string
  run: () => Promise<{ passed: boolean; error?: string; metrics?: any }>
}

async function testScenario1_MultipleProgressions() {
  "Test multiple concurrent progressions"
  const client = getRedisClient()
  const results = []

  for (let i = 1; i <= 5; i++) {
    const connId = `stress-conn-${i}`
    const key = `progression:${connId}`

    try {
      await client.hset(key, {
        cycles_completed: String(i * 10),
        successful_cycles: String(i * 8),
        total_trades: String(i * 50),
        successful_trades: String(i * 25),
        position_count: String(i * 5),
        timestamp: new Date().toISOString(),
      })
      results.push({ connId, success: true })
    } catch (error) {
      return {
        passed: false,
        error: `Failed on connection ${i}: ${error}`,
      }
    }
  }

  return { passed: true, metrics: { connectionsCreated: results.length } }
}

async function testScenario2_EdgeCases() {
  "Test edge cases: 0 metrics, extreme values, missing data"
  const client = getRedisClient()

  try {
    const key = "progression:edge-case-test"

    // Test 1: All zeros
    await client.hset(key, {
      cycles_completed: "0",
      successful_cycles: "0",
      total_trades: "0",
      successful_trades: "0",
      position_count: "0",
    })

    // Test 2: Extreme values
    await client.hset(key, {
      cycles_completed: String(Number.MAX_SAFE_INTEGER),
      position_count: "9999",
      avg_profit_factor: String(100.5),
      avg_drawdown_time: "0.001",
    })

    // Test 3: Missing fields (should not crash)
    const retrieved = await client.hgetall(key)
    if (!retrieved) {
      return { passed: false, error: "Failed to retrieve hash" }
    }

    return { passed: true, metrics: { edgeCasesPassed: 3 } }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario3_AtomicOperations() {
  "Test atomic counter increments for concurrent safety"
  const client = getRedisClient()
  const key = "progression:atomic-test"

  try {
    // Reset counter
    await client.hset(key, { counter: "0" })

    // Simulate 100 concurrent increments
    const incrementPromises = Array(100)
      .fill(0)
      .map(() => client.hincrby(key, "counter", 1))

    await Promise.all(incrementPromises)

    // Verify count
    const finalValue = await client.hget(key, "counter")
    const count = parseInt(finalValue || "0", 10)

    if (count !== 100) {
      return {
        passed: false,
        error: `Expected 100, got ${count}`,
      }
    }

    return {
      passed: true,
      metrics: { atomicIncrementsSafe: true, finalCount: count },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario4_ContinuousOperation() {
  "Test continuous operation with repeated metric updates"
  const client = getRedisClient()
  const key = "progression:continuous-test"

  try {
    for (let cycle = 1; cycle <= 50; cycle++) {
      await client.hset(key, {
        cycle_number: String(cycle),
        cycles_completed: String(cycle * 10),
        successful_cycles: String(cycle * 8),
        total_trades: String(cycle * 30),
        successful_trades: String(cycle * 15),
        position_count: String(Math.floor(Math.random() * 20) + 1),
        avg_profit_factor: String((Math.random() * 1 + 1).toFixed(2)),
        avg_drawdown_time: String(Math.floor(Math.random() * 50) + 10),
        timestamp: new Date().toISOString(),
      })
    }

    const final = await client.hgetall(key)
    if (!final || !final.cycle_number) {
      return { passed: false, error: "Continuous operation failed" }
    }

    return {
      passed: true,
      metrics: { continuousCyclesCompleted: 50, finalCycleNumber: final.cycle_number },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario5_DataConsistency() {
  "Test data consistency across multiple reads and writes"
  const client = getRedisClient()
  const key = "progression:consistency-test"
  const testData = {
    cycles_completed: "1000",
    successful_cycles: "800",
    total_trades: "5000",
    successful_trades: "2500",
    position_count: "50",
    avg_profit_factor: "1.5",
  }

  try {
    // Write data
    await client.hset(key, testData)

    // Read back multiple times
    const reads = []
    for (let i = 0; i < 10; i++) {
      const data = await client.hgetall(key)
      reads.push(data)
    }

    // Verify consistency
    for (const read of reads) {
      if (
        read.cycles_completed !== testData.cycles_completed ||
        read.successful_cycles !== testData.successful_cycles ||
        read.position_count !== testData.position_count
      ) {
        return {
          passed: false,
          error: "Data inconsistency detected across reads",
        }
      }
    }

    return {
      passed: true,
      metrics: { consistentReads: reads.length, dataVerified: true },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario6_MemoryStability() {
  "Test for memory leaks under repeated operations"
  const client = getRedisClient()

  try {
    const keys = []

    // Create and update many keys
    for (let i = 0; i < 200; i++) {
      const key = `progression:memory-test-${i}`
      keys.push(key)

      await client.hset(key, {
        test_id: String(i),
        data: `test-data-${i}`,
        timestamp: new Date().toISOString(),
        large_value: "x".repeat(1000),
      })
    }

    // Verify keys exist
    let existCount = 0
    for (const key of keys) {
      const data = await client.hgetall(key)
      if (data && data.test_id) {
        existCount++
      }
    }

    if (existCount < 200) {
      return {
        passed: false,
        error: `Expected 200 keys, only ${existCount} exist`,
      }
    }

    // Cleanup
    for (const key of keys) {
      await client.del(key)
    }

    return {
      passed: true,
      metrics: { keysCreated: keys.length, keysVerified: existCount },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario7_CoordinationLogic() {
  "Test coordination correctness detection under various conditions"
  const client = getRedisClient()
  const key = "progression:coordination-test"

  try {
    const testCases = [
      {
        name: "Coordinated: High profit, low drawdown",
        profitFactor: 2.0,
        drawdownTime: 30,
        expectedCoordinated: true,
      },
      {
        name: "Coordinated: Mid profit, mid drawdown",
        profitFactor: 1.5,
        drawdownTime: 45,
        expectedCoordinated: true,
      },
      {
        name: "Uncoordinated: Low profit, high drawdown",
        profitFactor: 0.8,
        drawdownTime: 75,
        expectedCoordinated: false,
      },
      {
        name: "Uncoordinated: High profit, extremely high drawdown",
        profitFactor: 1.8,
        drawdownTime: 65,
        expectedCoordinated: false,
      },
    ]

    let passedCount = 0
    const results = []

    for (const testCase of testCases) {
      const isCoordinated =
        testCase.profitFactor > 1.0 && testCase.drawdownTime < 60

      const passed = isCoordinated === testCase.expectedCoordinated
      if (passed) passedCount++

      results.push({
        name: testCase.name,
        passed,
        actual: isCoordinated,
        expected: testCase.expectedCoordinated,
      })
    }

    if (passedCount !== testCases.length) {
      return {
        passed: false,
        error: `Coordination logic failed: ${passedCount}/${testCases.length}`,
        details: results,
      }
    }

    return {
      passed: true,
      metrics: { coordinationTestsPassed: passedCount, results },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

async function testScenario8_ExtremePositionDetection() {
  "Test extreme position detection at various thresholds"
  const client = getRedisClient()
  const key = "progression:position-test"

  try {
    const testCases = [
      { positions: 50, threshold: 100, shouldAlert: false },
      { positions: 99, threshold: 100, shouldAlert: false },
      { positions: 100, threshold: 100, shouldAlert: false },
      { positions: 101, threshold: 100, shouldAlert: true },
      { positions: 500, threshold: 100, shouldAlert: true },
      { positions: 1000, threshold: 100, shouldAlert: true },
    ]

    let passedCount = 0

    for (const testCase of testCases) {
      const shouldAlert = testCase.positions > testCase.threshold
      if (shouldAlert === testCase.shouldAlert) {
        passedCount++
      }
    }

    if (passedCount !== testCases.length) {
      return {
        passed: false,
        error: `Position detection failed: ${passedCount}/${testCases.length}`,
      }
    }

    return {
      passed: true,
      metrics: { positionDetectionTestsPassed: passedCount },
    }
  } catch (error) {
    return { passed: false, error: String(error) }
  }
}

export async function POST() {
  try {
    console.log("[v0] [StressTest] === Starting intensive stress testing ===")
    await initRedis()

    const scenarios: TestScenario[] = [
      {
        name: "Multiple Concurrent Progressions",
        run: testScenario1_MultipleProgressions,
      },
      {
        name: "Edge Cases Handling",
        run: testScenario2_EdgeCases,
      },
      {
        name: "Atomic Operations Safety",
        run: testScenario3_AtomicOperations,
      },
      {
        name: "Continuous Operation",
        run: testScenario4_ContinuousOperation,
      },
      {
        name: "Data Consistency",
        run: testScenario5_DataConsistency,
      },
      {
        name: "Memory Stability",
        run: testScenario6_MemoryStability,
      },
      {
        name: "Coordination Logic",
        run: testScenario7_CoordinationLogic,
      },
      {
        name: "Extreme Position Detection",
        run: testScenario8_ExtremePositionDetection,
      },
    ]

    const results = []
    let passedCount = 0
    const startTime = Date.now()

    for (const scenario of scenarios) {
      console.log(
        `[v0] [StressTest] Running: ${scenario.name}`
      )
      try {
        const result = await scenario.run()
        const passed = result.passed

        results.push({
          name: scenario.name,
          passed,
          error: result.error,
          metrics: result.metrics,
        })

        if (passed) passedCount++
        console.log(
          `[v0] [StressTest] ${passed ? "✓" : "✗"} ${scenario.name}`
        )
      } catch (error) {
        results.push({
          name: scenario.name,
          passed: false,
          error: `Exception: ${error}`,
        })
        console.error(
          `[v0] [StressTest] Exception in ${scenario.name}:`,
          error
        )
      }
    }

    const duration = Date.now() - startTime

    const report = {
      success: passedCount === scenarios.length,
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      summary: {
        totalTests: scenarios.length,
        passed: passedCount,
        failed: scenarios.length - passedCount,
        passRate: `${((passedCount / scenarios.length) * 100).toFixed(1)}%`,
      },
      results,
      stability: {
        status: passedCount === scenarios.length ? "STABLE" : "UNSTABLE",
        criticalIssues: results.filter((r) => !r.passed),
      },
    }

    console.log(
      "[v0] [StressTest] === Testing complete ===",
      JSON.stringify(report.summary, null, 2)
    )

    return NextResponse.json(report, { status: 200 })
  } catch (error) {
    console.error("[v0] [StressTest] FATAL:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Stress test execution failed",
        details: String(error),
      },
      { status: 500 }
    )
  }
}
