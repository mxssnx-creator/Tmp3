#!/usr/bin/env node
/**
 * Complete Progression Test for DRIFTUSDT
 * Tests all four phases: Prehistoric → Indications → Strategies → Real Positions
 * Outputs comprehensive results showing system health and data flow
 */

const http = require("http")

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 3002,
      path,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }

    const req = http.request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => {
        data += chunk
      })
      res.on("end", () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(data)
        }
      })
    })

    req.on("error", (err) => {
      console.error("[ERROR]", path, ":", err.message)
      reject(err)
    })

    setTimeout(() => {
      req.destroy()
      reject(new Error("Request timeout"))
    }, 15000)

    req.end()
  })
}

async function testCompleteProgression() {
  console.log("\n" + "=".repeat(80))
  console.log("DRIFTUSDT COMPLETE PROGRESSION TEST")
  console.log("=".repeat(80) + "\n")

  try {
    // Step 1: Start Engine
    console.log("[1] STARTING ENGINE...")
    const startRes = await makeRequest("/api/trade-engine/quick-start")
    console.log("    Status:", startRes.status || "started")

    // Wait for initialization
    await new Promise((r) => setTimeout(r, 3000))

    // Step 2: Check Progression State
    console.log("\n[2] CHECKING PROGRESSION STATE...")
    const progressionRes = await makeRequest("/api/connections/progression/default-bingx-001")
    const state = progressionRes.state || progressionRes
    console.log("    Phase:", state.phase || "unknown")
    console.log("    Progress:", state.progress || 0, "%")

    // Step 3: Check Market Data
    console.log("\n[3] CHECKING PREHISTORIC DATA...")
    const marketRes = await makeRequest("/api/exchange/bingx/top-symbols?t=" + Date.now())
    console.log("    Symbol:", marketRes.symbol)
    console.log("    Price:", marketRes.price)
    console.log("    24h Change:", marketRes.priceChangePercent, "%")
    console.log("    Volume:", marketRes.volume)

    // Step 4: Check Connection Logs
    console.log("\n[4] CHECKING CONNECTION LOGS...")
    const logsRes = await makeRequest("/api/settings/connections/default-bingx-001/log?limit=10")
    const logs = Array.isArray(logsRes) ? logsRes : logsRes.logs || []
    console.log("    Recent Log Entries:", logs.length)
    if (logs.length > 0) {
      logs.slice(-3).forEach((log) => {
        console.log("    -", log.message || log.type)
      })
    }

    // Step 5: Final Progression Check
    console.log("\n[5] FINAL PROGRESSION CHECK...")
    const finalRes = await makeRequest("/api/connections/progression/default-bingx-001?t=" + Date.now())
    const finalState = finalRes.state || finalRes

    console.log("    Cycles Completed:", finalState.cyclesCompleted || 0)
    console.log("    Indications:", finalState.indicationEvaluatedDirection || 0)
    console.log("    Strategies:", finalState.strategyEvaluatedReal || 0)
    console.log("    Phase:", finalState.phase || "unknown")
    console.log("    Status:", finalState.status || "running")
    console.log("    Success Rate:", finalState.cycleSuccessRate || 0, "%")

    // Step 6: Position Summary
    console.log("\n[6] POSITION SUMMARY...")
    console.log("    Live Positions:", finalState.livePositionCount || 0)
    console.log("    Pseudo Positions:", finalState.pseudoPositionCount || 0)
    console.log("    Total Profit:", finalState.totalProfit || 0)

    console.log("\n" + "=".repeat(80))
    console.log("TEST COMPLETE - RESULTS SUMMARY")
    console.log("=".repeat(80))
    console.log("\nSYMBOL: DRIFTUSDT")
    console.log("EXCHANGE: BingX")
    console.log("TEST MODE: Real Data with Paper Trading")
    console.log("\nKEY METRICS:")
    console.log("  - Market Data Loaded:", marketRes.symbol ? "YES" : "NO")
    console.log("  - Price Data Available:", marketRes.price ? "YES" : "NO")
    console.log("  - Engine Phase:", finalState.phase)
    console.log("  - Data Flow Active:", finalState.cyclesCompleted > 0 ? "YES" : "NO")
    console.log("  - Indications Generated:", finalState.indicationEvaluatedDirection || 0)
    console.log("  - Strategies Evaluated:", finalState.strategyEvaluatedReal || 0)
    console.log("\n" + "=".repeat(80) + "\n")
  } catch (err) {
    console.error("\n[FATAL ERROR]", err.message)
    console.log("\nMake sure the server is running on http://localhost:3002")
    console.log("Start with: npm run dev\n")
  }
}

testCompleteProgression()
