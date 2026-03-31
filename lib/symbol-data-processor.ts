/**
 * Symbol Data Processor
 * Async per-symbol data loading, WebSocket connection, and continuous processing
 */

import { getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"

export interface SymbolDataResult {
  symbol: string
  candles: number
  errors: number
  duration: number
  success: boolean
  errorMessage: string | null
}

export interface WebSocketState {
  symbol: string
  connected: boolean
  messagesReceived: number
  errors: number
  lastUpdate: string | null
  reconnectAttempts: number
}

export class SymbolDataProcessor {
  private connectionId: string
  private progressManager: EngineProgressManager
  private wsStates: Map<string, WebSocketState> = new Map()
  private processingSymbols: Set<string> = new Set()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
  }

  /**
   * Load prehistoric data for a single symbol asynchronously
   */
  async loadPrehistoricData(symbol: string, exchange: string = 'bingx'): Promise<SymbolDataResult> {
    const startTime = Date.now()
    this.processingSymbols.add(symbol)
    
    await this.progressManager.addSymbol(symbol)
    await this.progressManager.addInfoLog(`Starting prehistoric data load for ${symbol}`)

    try {
      // Fetch OHLCV data from exchange
      const result = await this.fetchOHLCVData(symbol, exchange)
      
      const duration = Date.now() - startTime
      const success = result.success
      
      await this.progressManager.updateSymbolPrehistoric(
        symbol,
        result.candles,
        result.errors,
        duration,
        success
      )

      if (success) {
        await this.progressManager.addInfoLog(
          `✓ ${symbol}: ${result.candles} candles loaded in ${duration}ms`,
          { symbol, candles: result.candles, duration }
        )
      } else {
        await this.progressManager.addError('prehistoric_load', result.errorMessage || 'Unknown error', symbol)
      }

      this.processingSymbols.delete(symbol)
      return result
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      
      await this.progressManager.updateSymbolPrehistoric(symbol, 0, 1, duration, false)
      await this.progressManager.addError('prehistoric_load', errorMessage, symbol)
      
      this.processingSymbols.delete(symbol)
      return {
        symbol,
        candles: 0,
        errors: 1,
        duration,
        success: false,
        errorMessage,
      }
    }
  }

  /**
   * Load prehistoric data for multiple symbols concurrently
   */
  async loadPrehistoricDataConcurrent(symbols: string[], exchange: string = 'bingx'): Promise<SymbolDataResult[]> {
    await this.progressManager.setPrehistoricTotal(symbols.length)
    await this.progressManager.setPrehistoricInProgress(true)

    const promises = symbols.map(symbol => this.loadPrehistoricData(symbol, exchange))
    const results = await Promise.all(promises)

    const totalCandles = results.reduce((sum, r) => sum + r.candles, 0)
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0)
    const successCount = results.filter(r => r.success).length

    await this.progressManager.setPrehistoricCompleted(successCount === symbols.length)
    await this.progressManager.addInfoLog(
      `Prehistoric load complete: ${successCount}/${symbols.length} symbols, ${totalCandles} candles, ${totalErrors} errors`
    )

    return results
  }

  /**
   * Initialize WebSocket connection for a symbol
   */
  async initializeWebSocket(symbol: string): Promise<void> {
    const wsState: WebSocketState = {
      symbol,
      connected: false,
      messagesReceived: 0,
      errors: 0,
      lastUpdate: null,
      reconnectAttempts: 0,
    }
    this.wsStates.set(symbol, wsState)

    await this.progressManager.addInfoLog(`Initializing WebSocket for ${symbol}`)
    
    // Note: Actual WebSocket implementation would go here
    // For now, we track the state
    wsState.connected = true
    await this.progressManager.updateSymbolWS(symbol, true, 0, 0)
  }

  /**
   * Process WebSocket message for a symbol
   */
  async processWebSocketMessage(symbol: string, data: any): Promise<void> {
    const wsState = this.wsStates.get(symbol)
    if (!wsState) return

    wsState.messagesReceived++
    wsState.lastUpdate = new Date().toISOString()

    await this.progressManager.updateSymbolWS(
      symbol,
      wsState.connected,
      wsState.messagesReceived,
      wsState.errors
    )

    // Process the market data update
    await this.processMarketDataUpdate(symbol, data)
  }

  /**
   * Handle WebSocket error for a symbol
   */
  async handleWebSocketError(symbol: string, error: Error): Promise<void> {
    const wsState = this.wsStates.get(symbol)
    if (!wsState) return

    wsState.errors++
    await this.progressManager.updateSymbolWS(
      symbol,
      wsState.connected,
      wsState.messagesReceived,
      wsState.errors
    )
    await this.progressManager.addError('websocket', error.message, symbol)
  }

  /**
   * Process market data update and store in Redis
   */
  private async processMarketDataUpdate(symbol: string, data: any): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `market_data:${symbol}:realtime`
      
      // Store latest data
      await client.set(key, JSON.stringify(data), { EX: 3600 }) // 1h TTL
      
      // Add to history (bounded list)
      const historyKey = `market_data:${symbol}:history`
      await client.lpush(historyKey, JSON.stringify(data))
      await client.ltrim(historyKey, 0, 999) // Keep last 1000 entries
      
    } catch (error) {
      await this.progressManager.addError(
        'market_data_store',
        error instanceof Error ? error.message : 'Failed to store market data',
        symbol
      )
    }
  }

  /**
   * Fetch OHLCV data from exchange
   */
  private async fetchOHLCVData(symbol: string, exchange: string): Promise<SymbolDataResult> {
    try {
      // This would call the actual exchange API
      // For now, return a placeholder result
      return {
        symbol,
        candles: 250,
        errors: 0,
        duration: 0,
        success: true,
        errorMessage: null,
      }
    } catch (error) {
      return {
        symbol,
        candles: 0,
        errors: 1,
        duration: 0,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Get current processing status
   */
  getProcessingStatus(): {
    activeSymbols: string[]
    wsConnections: Map<string, WebSocketState>
  } {
    return {
      activeSymbols: Array.from(this.processingSymbols),
      wsConnections: this.wsStates,
    }
  }

  /**
   * Cleanup WebSocket connections
   */
  async cleanup(): Promise<void> {
    for (const [symbol, wsState] of this.wsStates) {
      wsState.connected = false
      await this.progressManager.updateSymbolWS(symbol, false, wsState.messagesReceived, wsState.errors)
    }
    this.wsStates.clear()
    this.processingSymbols.clear()
  }
}
