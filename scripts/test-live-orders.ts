#!/usr/bin/env ts-node
/**
 * Comprehensive test for live order lifecycle:
 * 1. Check if live trading is enabled
 * 2. Verify exchange connector
 * 3. Check for active positions
 * 4. Verify control orders (SL/TP) are placed
 * 5. Test reconciliation with exchange
 * 6. Test order closing
 */

import { initRedis, getRedisClient, getConnection } from "@/lib/redis-db"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getLivePositions, reconcileLivePositions, syncWithExchange } from "@/lib/trade-engine/stages/live-stage"
import { getAllConnections } from "@/lib/redis-db"

const LOG_PREFIX = "[TEST-LIVE-ORDERS]"

async function main() {
  console.log(`${LOG_PREFIX} Starting comprehensive live orders test...\n`)
  
  try {
    // ────── Initialize ──────────
    await initRedis()
    const client = getRedisClient()
    console.log(`${LOG_PREFIX} ✓ Redis initialized\n`)

    // ────── Get all connections ──────────
    const connections = await getAllConnections()
    if (!connections || connections.length === 0) {
      console.log(`${LOG_PREFIX} ✗ No connections found`)
      return
    }
    console.log(`${LOG_PREFIX} Found ${connections.length} connections\n`)

    // ────── Test each connection ──────────
    for (const conn of connections) {
      const connId: string = conn.id || conn.connection_id || conn.connectionId
      if (!connId) continue
      
      console.log(`\n════════════════════════════════════════`)
      console.log(`Testing connection: ${connId}`)
      console.log(`════════════════════════════════════════`)

      // 1. Check live trading enabled
      const connSettings = await getConnection(connId)
      const isLiveTrade = connSettings?.is_live_trade === true || connSettings?.live_trade_enabled === true
      console.log(`\n1. Live Trading Enabled: ${isLiveTrade ? "✓" : "✗"}`)
      if (!isLiveTrade) {
        console.log(`   Settings: ${JSON.stringify(connSettings)}`)
        continue
      }

      // 2. Check exchange connector
      console.log(`\n2. Exchange Connector:`)
      let connector: any = null
      try {
        connector = await exchangeConnectorFactory.getOrCreateConnector(connId)
        if (connector) {
          const hasPlaceOrder = typeof connector.placeOrder === "function"
          const hasPlaceStopOrder = typeof connector.placeStopOrder === "function"
          const hasClosePosition = typeof connector.closePosition === "function"
          const hasGetPositions = typeof connector.getPositions === "function"
          const hasCancelOrder = typeof connector.cancelOrder === "function"
          
          console.log(`   - placeOrder: ${hasPlaceOrder ? "✓" : "✗"}`)
          console.log(`   - placeStopOrder: ${hasPlaceStopOrder ? "✓" : "✗"}`)
          console.log(`   - closePosition: ${hasClosePosition ? "✓" : "✗"}`)
          console.log(`   - getPositions: ${hasGetPositions ? "✓" : "✗"}`)
          console.log(`   - cancelOrder: ${hasCancelOrder ? "✓" : "✗"}`)
        } else {
          console.log(`   ✗ No connector available`)
          continue
        }
      } catch (err) {
        console.log(`   ✗ Error creating connector: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      // 3. Check for active positions
      console.log(`\n3. Active Positions:`)
      const allPositions = await getLivePositions(connId)
      const openPositions = allPositions.filter(p => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed")
      
      console.log(`   Total: ${allPositions.length}`)
      console.log(`   Open/Pending: ${openPositions.length}`)
      
      if (openPositions.length > 0) {
        console.log(`\n   Open positions details:`)
        for (const pos of openPositions.slice(0, 5)) {
          const hasOrderId = !!pos.orderId
          const hasSLOrder = !!pos.stopLossOrderId
          const hasTPOrder = !!pos.takeProfitOrderId
          
          console.log(`   - ${pos.symbol} ${pos.direction} (${pos.status})`)
          console.log(`     Entry Order: ${hasOrderId ? `✓ ${pos.orderId}` : "✗"}`)
          console.log(`     Stop Loss: ${hasSLOrder ? `✓ ${pos.stopLossOrderId}` : "✗"} (${pos.stopLoss}%)`)
          console.log(`     Take Profit: ${hasTPOrder ? `✓ ${pos.takeProfitOrderId}` : "✗"} (${pos.takeProfit}%)`)
          console.log(`     Executed Qty: ${pos.executedQuantity}`)
          console.log(`     Entry Price: ${pos.averageExecutionPrice || pos.entryPrice}`)
        }

        // 4. Test reconciliation
        console.log(`\n4. Testing Reconciliation:`)
        try {
          const result = await reconcileLivePositions(connId, connector)
          console.log(`   Reconciled: ${result.reconciled}`)
          console.log(`   Updated: ${result.updated}`)
          console.log(`   Closed: ${result.closed}`)
          console.log(`   Errors: ${result.errors}`)
          console.log(`   ${result.errors === 0 ? "✓" : "✗"} Reconciliation completed`)
        } catch (err) {
          console.log(`   ✗ Reconciliation error: ${err instanceof Error ? err.message : String(err)}`)
        }

        // 5. Test exchange sync
        console.log(`\n5. Testing Exchange Sync:`)
        try {
          await syncWithExchange(connId, connector)
          console.log(`   ✓ Exchange sync completed`)
        } catch (err) {
          console.log(`   ✗ Sync error: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        console.log(`   No open positions to test with`)
      }

      // 6. Check cron endpoint
      console.log(`\n6. Checking Cron Status:`)
      try {
        const cronKey = `cron:sync-live-positions:lock`
        const lockStatus = await client.get(cronKey)
        if (lockStatus) {
          console.log(`   Lock acquired at: ${new Date(parseInt(lockStatus)).toISOString()}`)
          console.log(`   ✗ Cron is currently running (may be slow)`)
        } else {
          console.log(`   ✓ Cron lock is available (not running)`)
        }
      } catch (err) {
        console.log(`   ✗ Error checking cron: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 7. Check metrics
      console.log(`\n7. Live Trading Metrics:`)
      try {
        const progKey = `progression:${connId}`
        const metrics = await client.hgetall(progKey)
        if (metrics) {
          console.log(`   Orders Placed: ${metrics.live_orders_placed_count || 0}`)
          console.log(`   Orders Filled: ${metrics.live_orders_filled_count || 0}`)
          console.log(`   Orders Failed: ${metrics.live_orders_failed_count || 0}`)
          console.log(`   Positions Created: ${metrics.live_positions_created_count || 0}`)
          console.log(`   Positions Closed: ${metrics.live_positions_closed_count || 0}`)
          console.log(`   Wins: ${metrics.live_wins_count || 0}`)
        } else {
          console.log(`   No metrics found`)
        }
      } catch (err) {
        console.log(`   ✗ Error fetching metrics: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    console.log(`\n${LOG_PREFIX} Test completed\n`)
  } catch (err) {
    console.error(`${LOG_PREFIX} Fatal error:`, err)
  }

  process.exit(0)
}

main().catch(console.error)
