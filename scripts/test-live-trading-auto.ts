/**
 * Automated Live Trading Test on BingX
 * 
 * This script:
 * 1. Checks for active BingX connections
 * 2. Enables live trading on the connection
 * 3. Creates a small test position
 * 4. Executes on BingX exchange
 * 5. Monitors fills and position updates in real-time
 */

import fetch from "node-fetch"

const API_BASE = "http://localhost:3000/api"
const TEST_CONFIG = {
  // Small position for testing - adjust as needed
  testSymbol: "BTC-USDT", // BingX symbol format
  testQuantity: 0.0001, // Very small amount for testing
  testLeverage: 1, // No leverage for safety
  timeoutMs: 60000, // 60 seconds to wait for fills
}

interface ConnectionInfo {
  id: string
  exchange: string
  name: string
  is_enabled: boolean
  is_live_trade: boolean
}

interface Position {
  id: string
  symbol: string
  direction: string
  quantity: number
  executedQuantity: number
  status: string
  averageExecutionPrice: number
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function log(message: string, level: "INFO" | "SUCCESS" | "ERROR" | "WARN" = "INFO") {
  const timestamp = new Date().toISOString()
  const prefix = {
    INFO: "ℹ️ ",
    SUCCESS: "✓ ",
    ERROR: "✗ ",
    WARN: "⚠️ ",
  }[level]
  console.log(`[${timestamp}] ${prefix} ${message}`)
}

async function getActiveConnections(): Promise<ConnectionInfo[]> {
  try {
    log("Fetching active connections...")
    const res = await fetch(`${API_BASE}/settings/connections`)
    const data = (await res.json()) as any
    
    const connections = Array.isArray(data) ? data : data.connections || []
    const bingxConnections = connections.filter(
      (c: any) => c.exchange?.toLowerCase() === "bingx"
    )

    log(`Found ${bingxConnections.length} BingX connection(s)`, "INFO")
    bingxConnections.forEach((c: any) => {
      log(
        `  - ${c.name} (${c.id}): enabled=${c.is_enabled}, live_trade=${c.is_live_trade}`,
        "INFO"
      )
    })

    return bingxConnections
  } catch (error) {
    log(`Failed to fetch connections: ${error}`, "ERROR")
    throw error
  }
}

async function enableLiveTrading(connectionId: string): Promise<boolean> {
  try {
    log(`Enabling live trading for connection ${connectionId}...`, "INFO")
    
    const res = await fetch(
      `${API_BASE}/settings/connections/${connectionId}/live-trade`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }
    )

    if (!res.ok) {
      const error = await res.text()
      log(`Failed to enable live trading: ${error}`, "ERROR")
      return false
    }

    log("Live trading enabled successfully", "SUCCESS")
    return true
  } catch (error) {
    log(`Error enabling live trading: ${error}`, "ERROR")
    return false
  }
}

async function createTestSignal(
  connectionId: string,
  symbol: string
): Promise<{ signalId: string; ruleId: string } | null> {
  try {
    log(`Creating test trading signal for ${symbol}...`, "INFO")
    
    // Create a simple signal to trigger a position
    const signalData = {
      connectionId,
      symbol,
      action: "buy", // BUY signal
      confidence: 0.95,
      reason: "Automated live trading test",
      indicators: {
        rsi: 45, // Neutral RSI
        macd: 0.001,
      },
      timestamp: Date.now(),
    }

    // Store signal in Redis or DB via API
    const res = await fetch(`${API_BASE}/signals/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signalData),
    })

    if (!res.ok) {
      const error = await res.text()
      log(`Failed to create signal: ${error}`, "WARN")
      return null
    }

    const result = (await res.json()) as any
    log(`Signal created: ${result.id}`, "SUCCESS")
    return result
  } catch (error) {
    log(`Error creating signal: ${error}`, "WARN")
    return null
  }
}

async function executeTradeTest(
  connectionId: string,
  symbol: string
): Promise<Position | null> {
  try {
    log(`Executing test trade on BingX: ${symbol}`, "INFO")
    log(`  - Quantity: ${TEST_CONFIG.testQuantity}`, "INFO")
    log(`  - Leverage: ${TEST_CONFIG.testLeverage}x`, "INFO")

    const tradeData = {
      connectionId,
      symbol,
      side: "long",
      quantity: TEST_CONFIG.testQuantity,
      leverage: TEST_CONFIG.testLeverage,
      orderType: "market",
      timeInForce: "IOC", // Immediate or Cancel
    }

    const res = await fetch(`${API_BASE}/trade/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tradeData),
    })

    if (!res.ok) {
      const error = await res.text()
      log(`Trade execution failed: ${error}`, "ERROR")
      return null
    }

    const position = (await res.json()) as Position
    log(`Trade executed successfully!`, "SUCCESS")
    log(`  - Position ID: ${position.id}`, "SUCCESS")
    log(`  - Status: ${position.status}`, "SUCCESS")
    log(`  - Entry Price: $${position.averageExecutionPrice.toFixed(2)}`, "SUCCESS")

    return position
  } catch (error) {
    log(`Error executing trade: ${error}`, "ERROR")
    return null
  }
}

async function monitorPosition(
  connectionId: string,
  positionId: string
): Promise<Position | null> {
  try {
    log(`Monitoring position: ${positionId}...`, "INFO")

    const startTime = Date.now()
    let lastStatus = "pending"

    while (Date.now() - startTime < TEST_CONFIG.timeoutMs) {
      const res = await fetch(
        `${API_BASE}/exchange-positions?connectionId=${connectionId}&positionId=${positionId}`
      )

      if (res.ok) {
        const positions = (await res.json()) as Position[]
        const position = positions[0]

        if (position && position.status !== lastStatus) {
          lastStatus = position.status
          log(
            `Position status updated: ${position.status} (filled: ${position.executedQuantity.toFixed(8)})`,
            "INFO"
          )

          if (position.status === "filled" || position.status === "closed") {
            log(`Position fully filled at $${position.averageExecutionPrice.toFixed(2)}`, "SUCCESS")
            return position
          }
        }
      }

      // Poll every 2 seconds
      await sleep(2000)
    }

    log(`Timeout waiting for position fill (${TEST_CONFIG.timeoutMs}ms)`, "WARN")
    return null
  } catch (error) {
    log(`Error monitoring position: ${error}`, "ERROR")
    return null
  }
}

async function main() {
  try {
    log("=".repeat(60), "INFO")
    log("AUTOMATED LIVE TRADING TEST - BingX", "INFO")
    log("=".repeat(60), "INFO")

    // Step 1: Get connections
    const connections = await getActiveConnections()

    if (connections.length === 0) {
      log("No active BingX connections found. Please set up a connection first.", "ERROR")
      process.exit(1)
    }

    const connection = connections[0] // Use first connection
    log(`Using connection: ${connection.name} (${connection.id})`, "INFO")

    // Step 2: Enable live trading
    const liveEnabled = await enableLiveTrading(connection.id)
    if (!liveEnabled) {
      log("Failed to enable live trading", "ERROR")
      process.exit(1)
    }

    // Step 3: Wait a moment for settings to propagate
    await sleep(1000)

    // Step 4: Create test signal (optional)
    await createTestSignal(connection.id, TEST_CONFIG.testSymbol)

    // Step 5: Execute trade
    const position = await executeTradeTest(connection.id, TEST_CONFIG.testSymbol)

    if (!position) {
      log("Trade execution failed", "ERROR")
      process.exit(1)
    }

    // Step 6: Monitor position for fills
    log("Waiting for order fills...", "INFO")
    const filledPosition = await monitorPosition(connection.id, position.id)

    // Summary
    log("=".repeat(60), "INFO")
    if (filledPosition) {
      log("TEST COMPLETED SUCCESSFULLY!", "SUCCESS")
      log(`Final P&L: ${filledPosition.quantity} @ $${filledPosition.averageExecutionPrice.toFixed(2)}`, "SUCCESS")
    } else {
      log("TEST COMPLETED (Position not filled within timeout)", "WARN")
    }
    log("=".repeat(60), "INFO")

  } catch (error) {
    log(`Fatal error: ${error}`, "ERROR")
    process.exit(1)
  }
}

main()
