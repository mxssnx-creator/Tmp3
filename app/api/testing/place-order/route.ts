import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors/factory"
import type { ExchangeConnection } from "@/lib/types"

export async function POST(req: NextRequest) {
  try {
    await initRedis()
    const body = await req.json()
    const { connectionId, symbol, side, quantity, leverage } = body

    if (!connectionId || !symbol || !side || !quantity || leverage === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: connectionId, symbol, side, quantity, leverage" },
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

    console.log(`[PlaceOrder] Placing ${side} order for ${symbol} x${leverage} with ${quantity} coins`)

    // Create connector
    const connector = await createExchangeConnector(connection.exchange, {
      apiKey: connection.api_key,
      apiSecret: connection.api_secret,
      apiPassphrase: connection.api_passphrase || "",
      isTestnet: false,
      apiType: connection.api_type,
      contractType: connection.contract_type,
    })

    // Set leverage if applicable (for swap/perpetual markets)
    if (leverage && leverage > 1) {
      console.log(`[PlaceOrder] Setting leverage to ${leverage}x`)
      try {
        const leverageResult = await connector.setLeverage?.(symbol, leverage)
        console.log(`[PlaceOrder] Leverage set: ${JSON.stringify(leverageResult)}`)
      } catch (err) {
        console.log(`[PlaceOrder] Could not set leverage (may not be a perpetual market):`, err instanceof Error ? err.message : String(err))
      }
    }

    // Place market order with minimal volume
    console.log(`[PlaceOrder] Placing market order: ${side} ${quantity} ${symbol} with leverage ${leverage}x`)
    const result = await connector.placeOrder(symbol, side, quantity, 0, "market")

    console.log(`[PlaceOrder] Order result:`, result)

    if (!result || !result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result?.error || "Failed to place order",
        },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      orderId: (result as any)?.orderId || (result as any)?.order_id || "N/A",
      symbol,
      side,
      quantity,
      leverage,
      timestamp: Date.now(),
      details: (result as any)?.details || result,
    })
  } catch (error) {
    console.error("[PlaceOrder] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
