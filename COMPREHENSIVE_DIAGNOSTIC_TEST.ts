/**
 * Comprehensive Diagnostic Test - Verify all system stats and tracking
 * Tests the complete BASE -> MAIN -> REAL -> LIVE pipeline
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"

interface DiagnosticResult {
  timestamp: string
  connectionId: string
  symbol: string
  tests: {
    name: string
    passed: boolean
    details: string
    errors?: string[]
  }[]
  summary: {
    totalTests: number
    passed: number
    failed: number
    coverage: string
  }
  issues: {
    severity: "critical" | "warning" | "info"
    code: string
    description: string
    recommendation: string
  }[]
  stats: {
    baseStats: Record<string, any>
    mainStats: Record<string, any>
    realStats: Record<string, any>
    liveStats: Record<string, any>
    axisCounts: Record<string, number>
    positionTracking: Record<string, any>
  }
}

export async function runComprehensiveDiagnostic(
  connectionId: string,
  symbol: string
): Promise<DiagnosticResult> {
  const result: DiagnosticResult = {
    timestamp: new Date().toISOString(),
    connectionId,
    symbol,
    tests: [],
    summary: { totalTests: 0, passed: 0, failed: 0, coverage: "0%" },
    issues: [],
    stats: {
      baseStats: {},
      mainStats: {},
      realStats: {},
      liveStats: {},
      axisCounts: {},
      positionTracking: {},
    },
  }

  try {
    await initRedis()
    const client = getRedisClient()
    if (!client) {
      result.issues.push({
        severity: "critical",
        code: "REDIS_UNAVAILABLE",
        description: "Redis connection not available",
        recommendation: "Check Redis is running and accessible",
      })
      return result
    }

    // Test 1: BASE set statistics
    const testBase = {
      name: "BASE Set Statistics",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const baseKey = `strategies:${connectionId}:${symbol}:base:sets`
      const baseData = await client.get(baseKey)
      if (baseData) {
        const parsed = JSON.parse(baseData)
        result.stats.baseStats = {
          count: parsed.sets?.length ?? 0,
          hasStatus: parsed.sets?.some((s: any) => s.status) ?? 0,
          withValidBase: parsed.sets?.filter((s: any) => s.status === "valid_base").length ?? 0,
          withInvalid: parsed.sets?.filter((s: any) => s.status === "invalid").length ?? 0,
        }
        testBase.details = `BASE: ${result.stats.baseStats.count} sets, ${result.stats.baseStats.hasStatus} with status field`
        testBase.passed = result.stats.baseStats.count > 0
      } else {
        testBase.details = "No BASE sets stored yet"
        testBase.errors?.push("BASE sets key not found in Redis")
      }
    } catch (e) {
      testBase.errors?.push(String(e))
    }
    result.tests.push(testBase)

    // Test 2: MAIN set statistics and variant expansion
    const testMain = {
      name: "MAIN Set Expansion & Status",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const mainKey = `strategies:${connectionId}:${symbol}:main:sets`
      const mainData = await client.get(mainKey)
      if (mainData) {
        const parsed = JSON.parse(mainData)
        const baseCount = result.stats.baseStats.count
        const mainCount = parsed.sets?.length ?? 0
        const ratio = baseCount > 0 ? (mainCount / baseCount).toFixed(2) : "0"
        
        result.stats.mainStats = {
          count: mainCount,
          baseCount,
          ratio: parseFloat(ratio),
          withStatusValidBase: parsed.sets?.filter((s: any) => s.status === "valid_base").length ?? 0,
          withStatusValidMain: parsed.sets?.filter((s: any) => s.status === "valid_main").length ?? 0,
          withStatusInvalid: parsed.sets?.filter((s: any) => s.status === "invalid").length ?? 0,
          totalEntries: parsed.sets?.reduce((sum: number, s: any) => sum + (s.entries?.length ?? 0), 0) ?? 0,
          axisSets: parsed.sets?.filter((s: any) => s.axisWindows).length ?? 0,
        }
        
        testMain.details = `MAIN: ${mainCount} sets (${ratio}x BASE), ${result.stats.mainStats.totalEntries} total entries, ${result.stats.mainStats.axisSets} axis sets`
        testMain.passed = mainCount > baseCount
        
        if (mainCount === 0 && baseCount > 0) {
          testMain.errors?.push("No MAIN sets despite BASE sets existing")
        }
      } else {
        testMain.details = "No MAIN sets stored yet"
      }
    } catch (e) {
      testMain.errors?.push(String(e))
    }
    result.tests.push(testMain)

    // Test 3: REAL set statistics
    const testReal = {
      name: "REAL Set Filtering",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const realKey = `strategies:${connectionId}:${symbol}:real:sets`
      const realData = await client.get(realKey)
      if (realData) {
        const parsed = JSON.parse(realData)
        result.stats.realStats = {
          count: parsed.sets?.length ?? 0,
          withStatusValidReal: parsed.sets?.filter((s: any) => s.status === "valid_real").length ?? 0,
          withStatusInvalid: parsed.sets?.filter((s: any) => s.status === "invalid").length ?? 0,
          longCount: parsed.sets?.filter((s: any) => s.direction === "long").length ?? 0,
          shortCount: parsed.sets?.filter((s: any) => s.direction === "short").length ?? 0,
          withParentSetKey: parsed.sets?.filter((s: any) => s.parentSetKey).length ?? 0,
          totalEntries: parsed.sets?.reduce((sum: number, s: any) => sum + (s.entries?.length ?? 0), 0) ?? 0,
        }
        
        testReal.details = `REAL: ${result.stats.realStats.count} sets, Long: ${result.stats.realStats.longCount}, Short: ${result.stats.realStats.shortCount}, ${result.stats.realStats.totalEntries} entries`
        testReal.passed = result.stats.realStats.count > 0
        
        // Check hedge netting
        if (result.stats.realStats.longCount > 0 && result.stats.realStats.shortCount > 0) {
          testReal.details += ", Hedge netting present"
        }
      } else {
        testReal.details = "No REAL sets stored yet"
      }
    } catch (e) {
      testReal.errors?.push(String(e))
    }
    result.tests.push(testReal)

    // Test 4: Position tracking and accumulation
    const testPositions = {
      name: "Position Tracking & Accumulation",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const allSets = [
        ...(result.stats.baseStats.count > 0 ? [result.stats.baseStats] : []),
        ...(result.stats.mainStats.count > 0 ? [result.stats.mainStats] : []),
        ...(result.stats.realStats.count > 0 ? [result.stats.realStats] : []),
      ]
      
      result.stats.positionTracking = {
        baseSetsPrevPos: 0,
        mainSetsTotalEntries: result.stats.mainStats.totalEntries ?? 0,
        realSetsTotalEntries: result.stats.realStats.totalEntries ?? 0,
        axisSetsWithSyntheticEntry: result.stats.mainStats.axisSets ?? 0,
      }
      
      testPositions.details = `Entries: Main=${result.stats.mainStats.totalEntries}, Real=${result.stats.realStats.totalEntries}`
      testPositions.passed = result.stats.mainStats.totalEntries > 0 || result.stats.realStats.totalEntries > 0
    } catch (e) {
      testPositions.errors?.push(String(e))
    }
    result.tests.push(testPositions)

    // Test 5: Status field presence
    const testStatus = {
      name: "Status Field Coverage",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const mainKey = `strategies:${connectionId}:${symbol}:main:sets`
      const mainData = await client.get(mainKey)
      if (mainData) {
        const parsed = JSON.parse(mainData)
        const withStatus = parsed.sets?.filter((s: any) => s.status).length ?? 0
        const total = parsed.sets?.length ?? 0
        const coverage = total > 0 ? ((withStatus / total) * 100).toFixed(1) : "0"
        
        result.stats.positionTracking.statusCoverage = parseFloat(coverage)
        testStatus.details = `Status field coverage: ${coverage}% (${withStatus}/${total})`
        testStatus.passed = parseFloat(coverage) >= 90
        
        if (parseFloat(coverage) < 90) {
          result.issues.push({
            severity: "warning",
            code: "LOW_STATUS_COVERAGE",
            description: `Only ${coverage}% of sets have status field`,
            recommendation: "Run auto-fix to add missing status fields",
          })
        }
      }
    } catch (e) {
      testStatus.errors?.push(String(e))
    }
    result.tests.push(testStatus)

    // Test 6: Axis set tracking
    const testAxis = {
      name: "Axis Set Accumulation",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const axisAccKey = `axis_pos_acc:${connectionId}`
      const axisData = await client.hgetall(axisAccKey)
      if (axisData && Object.keys(axisData).length > 0) {
        result.stats.axisCounts = axisData as Record<string, number>
        testAxis.details = `Axis accumulation: ${Object.keys(axisData).length} tracked axes`
        testAxis.passed = true
      } else {
        testAxis.details = "No axis accumulation data yet"
      }
    } catch (e) {
      testAxis.errors?.push(String(e))
    }
    result.tests.push(testAxis)

    // Test 7: Set count ratios validation
    const testRatios = {
      name: "Set Count Ratio Validation",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const baseCount = result.stats.baseStats.count
      const mainCount = result.stats.mainStats.count
      const realCount = result.stats.realStats.count
      
      if (baseCount > 0 && mainCount > 0) {
        const mainRatio = mainCount / baseCount
        if (mainRatio >= 2 && mainRatio <= 10) {
          testRatios.passed = true
          testRatios.details = `Ratios OK: Main/Base=${mainRatio.toFixed(2)}x`
        } else {
          testRatios.details = `Ratios suspicious: Main/Base=${mainRatio.toFixed(2)}x (expected 2-8x)`
          result.issues.push({
            severity: "warning",
            code: "UNUSUAL_SET_RATIOS",
            description: `Main/Base ratio is ${mainRatio.toFixed(2)}x (expected 2-8x for variants)`,
            recommendation: "Check variant expansion logic",
          })
        }
      } else {
        testRatios.details = "Insufficient data for ratio analysis"
      }
    } catch (e) {
      testRatios.errors?.push(String(e))
    }
    result.tests.push(testRatios)

    // Test 8: Hedge netting structure
    const testHedge = {
      name: "Hedge Netting per-Base",
      passed: false,
      details: "",
      errors: [] as string[],
    }
    try {
      const realKey = `strategies:${connectionId}:${symbol}:real:sets`
      const realData = await client.get(realKey)
      if (realData) {
        const parsed = JSON.parse(realData)
        const withParentKey = parsed.sets?.filter((s: any) => s.parentSetKey).length ?? 0
        const total = parsed.sets?.length ?? 0
        
        if (total > 0) {
          const coverage = (withParentKey / total) * 100
          testHedge.details = `parentSetKey coverage: ${coverage.toFixed(1)}% (${withParentKey}/${total})`
          testHedge.passed = coverage >= 95
          
          if (coverage < 95) {
            result.issues.push({
              severity: "warning",
              code: "LOW_PARENT_KEY_COVERAGE",
              description: `Only ${coverage.toFixed(1)}% of REAL sets have parentSetKey for hedge netting`,
              recommendation: "Ensure all REAL sets inherit parentSetKey from parent",
            })
          }
        }
      }
    } catch (e) {
      testHedge.errors?.push(String(e))
    }
    result.tests.push(testHedge)

    // Calculate summary
    result.summary.totalTests = result.tests.length
    result.summary.passed = result.tests.filter(t => t.passed).length
    result.summary.failed = result.tests.filter(t => !t.passed).length
    result.summary.coverage = `${((result.summary.passed / result.summary.totalTests) * 100).toFixed(1)}%`

    // Identify critical issues
    if (result.stats.baseStats.count === 0) {
      result.issues.unshift({
        severity: "critical",
        code: "NO_BASE_SETS",
        description: "No BASE sets found in system",
        recommendation: "Check indication generation and BASE set creation",
      })
    }

    if (result.stats.mainStats.count === 0 && result.stats.baseStats.count > 0) {
      result.issues.unshift({
        severity: "critical",
        code: "MAIN_EXPANSION_FAILED",
        description: "No MAIN sets despite BASE sets existing",
        recommendation: "Check expandAxisSets and variant expansion logic",
      })
    }

  } catch (error) {
    result.issues.push({
      severity: "critical",
      code: "DIAGNOSTIC_ERROR",
      description: `Diagnostic failed: ${String(error)}`,
      recommendation: "Check system logs",
    })
  }

  return result
}

// Export for testing
export default runComprehensiveDiagnostic
