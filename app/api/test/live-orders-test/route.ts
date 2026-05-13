import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors/factory"
import type { ExchangeConnection } from "@/lib/types"

const LOG_PREFIX = "[v0] [LiveOrdersTest]"

interface TestResult {
  testName: string
  success: boolean
  duration: number
  details: string
  error?: string
}

interface FullTestReport {
  connectionId: string
  connectionName: string
  exchange: string
  timestamp: number
  tests: TestResult[]
  summary: {
    totalTests: number
    passed: number
    failed: number
    successRate: number
  }
}

export async function POST(req: NextRequest) {
  try {
    await initRedis()
    const body = await req.json()
    const { connectionId } = body

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId required" },
        { status: 400 }
      )
    }

    const client = getRedisClient()
    
    // Get connection details
    const connData = await client.hgetall(`connection:${connectionId}`)
    if (!connData || Object.keys(connData).length === 0) {
      return NextResponse.json(
        { error: `Connection ${connectionId} not found` },
        { status: 404 }
      )
    }

    const connection = {
      id: connectionId,
      name: connData.name || connectionId,
      exchange: connData.exchange || "unknown",
      api_key: connData.api_key || "",
      api_secret: connData.api_secret || "",
      api_passphrase: connData.api_passphrase || "",
      api_type: connData.api_type || "",
      contract_type: connData.contract_type || "",
    } as any as ExchangeConnection

    console.log(`${LOG_PREFIX} Starting live orders test for ${connection.name}`)

    const tests: TestResult[] = []
    
    // Test 1: Create connector
    const connectorTest = await testConnectorCreation(connection)
    tests.push(connectorTest)

    if (!connectorTest.success) {
      return NextResponse.json({
        connectionId,
        connectionName: connection.name,
        exchange: connection.exchange,
        timestamp: Date.now(),
        tests,
        summary: {
          totalTests: tests.length,
          passed: tests.filter(t => t.success).length,
          failed: tests.filter(t => !t.success).length,
          successRate: 0,
        },
      } as FullTestReport)
    }

    const connector = await createExchangeConnector(connection.exchange, {
      apiKey: connection.api_key,
      apiSecret: connection.api_secret,
      apiPassphrase: connection.api_passphrase || "",
      isTestnet: false,
      apiType: connection.api_type,
      contractType: connection.contract_type,
    })

    // Test 2: Get balances
    const balanceTest = await testGetBalances(connector)
    tests.push(balanceTest)

    // Test 3: Get positions
    const positionsTest = await testGetPositions(connector)
    tests.push(positionsTest)

    // Test 4: Get open orders
    const ordersTest = await testGetOpenOrders(connector)
    tests.push(ordersTest)

    // Test 5: Test market order placement (if enabled)
    const marketOrderTest = await testMarketOrderPlacement(connector, connection)
    tests.push(marketOrderTest)

    // Test 6: Test stop loss order
    const slOrderTest = await testStopLossOrder(connector, connection)
    tests.push(slOrderTest)

    // Test 7: Verify order creation
    const verifyOrderTest = await testVerifyOrderCreation(connector)
    tests.push(verifyOrderTest)

    const report: FullTestReport = {
      connectionId,
      connectionName: connection.name,
      exchange: connection.exchange,
      timestamp: Date.now(),
      tests,
      summary: {
        totalTests: tests.length,
        passed: tests.filter(t => t.success).length,
        failed: tests.filter(t => !t.success).length,
        successRate: (tests.filter(t => t.success).length / tests.length) * 100,
      },
    }

    console.log(
      `${LOG_PREFIX} Test complete: ${report.summary.passed}/${report.summary.totalTests} passed`
    )

    return NextResponse.json(report)
  } catch (error) {
    console.error(`${LOG_PREFIX} Test error:`, error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

async function testConnectorCreation(
  connection: ExchangeConnection
): Promise<TestResult> {
  const start = Date.now()
  try {
    const connector = await createExchangeConnector(connection.exchange, {
      apiKey: connection.api_key,
      apiSecret: connection.api_secret,
      apiPassphrase: connection.api_passphrase || "",
      isTestnet: false,
      apiType: connection.api_type,
      contractType: connection.contract_type,
    })

    if (!connector) {
      return {
        testName: "Connector Creation",
        success: false,
        duration: Date.now() - start,
        details: "Connector factory returned null",
        error: "Failed to create connector instance",
      }
    }

    return {
      testName: "Connector Creation",
      success: true,
      duration: Date.now() - start,
      details: `Successfully created ${connection.exchange} connector`,
    }
  } catch (error) {
    return {
      testName: "Connector Creation",
      success: false,
      duration: Date.now() - start,
      details: "Failed to create connector",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testGetBalances(connector: any): Promise<TestResult> {
  const start = Date.now()
  try {
    const result = await connector.testConnection()
    
    if (!result.success) {
      return {
        testName: "Get Account Balance",
        success: false,
        duration: Date.now() - start,
        details: "Failed to retrieve account balance",
        error: result.error || "Unknown error",
      }
    }

    return {
      testName: "Get Account Balance",
      success: true,
      duration: Date.now() - start,
      details: `Balance: ${result.balance}`,
    }
  } catch (error) {
    return {
      testName: "Get Account Balance",
      success: false,
      duration: Date.now() - start,
      details: "Failed to get balances",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testGetPositions(connector: any): Promise<TestResult> {
  const start = Date.now()
  try {
    const positions = await connector.getPositions()
    
    return {
      testName: "Get Open Positions",
      success: true,
      duration: Date.now() - start,
      details: `Found ${positions.length || 0} open positions`,
    }
  } catch (error) {
    return {
      testName: "Get Open Positions",
      success: false,
      duration: Date.now() - start,
      details: "Failed to retrieve positions",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testGetOpenOrders(connector: any): Promise<TestResult> {
  const start = Date.now()
  try {
    const orders = await connector.getOpenOrders()
    
    return {
      testName: "Get Open Orders",
      success: true,
      duration: Date.now() - start,
      details: `Found ${orders.length || 0} open orders`,
    }
  } catch (error) {
    return {
      testName: "Get Open Orders",
      success: false,
      duration: Date.now() - start,
      details: "Failed to retrieve open orders",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testMarketOrderPlacement(
  connector: any,
  connection: ExchangeConnection
): Promise<TestResult> {
  const start = Date.now()
  try {
    // Get balances first to check if sufficient funds
    const connResult = await connector.testConnection()
    const balance = parseFloat(connResult.balance || "0")
    
    if (balance < 10) {
      return {
        testName: "Market Order Placement",
        success: false,
        duration: Date.now() - start,
        details: `Insufficient balance: ${balance} (need >= 10 USDT for test)`,
        error: "Low balance - cannot place test order",
      }
    }

    // Use small quantity for test order
    const symbol = "BTC/USDT"
    const minQty = 0.0001
    
    let result
    try {
      result = await connector.placeOrder(symbol, "buy", minQty, 0, "market")
    } catch (orderErr) {
      // If order fails, capture the error
      return {
        testName: "Market Order Placement",
        success: false,
        duration: Date.now() - start,
        details: `Failed to place market order for ${symbol}`,
        error: orderErr instanceof Error ? orderErr.message : "Order placement failed",
      }
    }

    if (!result || !result.orderId) {
      return {
        testName: "Market Order Placement",
        success: false,
        duration: Date.now() - start,
        details: `Failed to place market order for ${symbol}`,
        error: "No order ID returned - possible balance issue or API error",
      }
    }

    return {
      testName: "Market Order Placement",
      success: true,
      duration: Date.now() - start,
      details: `Market order placed: ${result.orderId} for ${minQty} ${symbol}`,
    }
  } catch (error) {
    return {
      testName: "Market Order Placement",
      success: false,
      duration: Date.now() - start,
      details: "Failed to place market order",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testStopLossOrder(
  connector: any,
  connection: ExchangeConnection
): Promise<TestResult> {
  const start = Date.now()
  try {
    // Get a position to set SL for
    const positions = await connector.getPositions()
    
    if (!positions || positions.length === 0) {
      return {
        testName: "Stop Loss Order",
        success: false,
        duration: Date.now() - start,
        details: "No open positions to test stop loss",
        error: "No positions found",
      }
    }

    const position = positions[0]
    const slPrice = position.entryPrice * 0.95 // 5% below entry
    const quantity = position.contracts * 0.1 // Close 10% of position

    const result = await connector.placeStopOrder(
      position.symbol,
      "sell",
      quantity,
      slPrice,
      { stopPrice: slPrice, reduceOnly: true }
    )

    if (!result || !result.orderId) {
      return {
        testName: "Stop Loss Order",
        success: false,
        duration: Date.now() - start,
        details: `Failed to place SL order for ${position.symbol}`,
        error: "No order ID returned",
      }
    }

    return {
      testName: "Stop Loss Order",
      success: true,
      duration: Date.now() - start,
      details: `SL order placed: ${result.orderId} at ${slPrice}`,
    }
  } catch (error) {
    return {
      testName: "Stop Loss Order",
      success: false,
      duration: Date.now() - start,
      details: "Failed to place stop loss order",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testVerifyOrderCreation(connector: any): Promise<TestResult> {
  const start = Date.now()
  try {
    // Re-fetch open orders to verify recent orders were created
    const orders = await connector.getOpenOrders()
    
    if (!orders || orders.length === 0) {
      return {
        testName: "Verify Order Creation",
        success: false,
        duration: Date.now() - start,
        details: "No orders found after creation attempts",
      }
    }

    const recentOrders = orders.filter(
      (o: any) => Date.now() - o.timestamp < 60000
    ) // Last 60 seconds

    return {
      testName: "Verify Order Creation",
      success: recentOrders.length > 0,
      duration: Date.now() - start,
      details: `Verified ${recentOrders.length} recent orders created in last 60s`,
    }
  } catch (error) {
    return {
      testName: "Verify Order Creation",
      success: false,
      duration: Date.now() - start,
      details: "Failed to verify order creation",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
