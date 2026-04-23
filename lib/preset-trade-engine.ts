/**
 * Production-Ready Preset Trade Engine
 * Supports both MAIN INDICATIONS (Direction/Move/Active/Optimal) and
 * COMMON INDICATORS (RSI, MACD, Bollinger, ParabolicSAR, ADX, ATR, etc.)
 * Wider TP/SL ranges for short-term trading (starting from factor 2)
 * Optimized for performance, rate limits, and production trading
 */

import { query, execute, getDatabaseType } from "@/lib/db"
import { TechnicalIndicators, calculateIndicators, type IndicatorConfig, type IndicatorSignal } from "./indicators"
import { IndicationEngine } from "./indications"
import { INDICATION_CATEGORIES, type IndicationCategory } from "./constants/types"

// Define a type for IndicationResult for better type safety
interface LocalIndicationResult {
  type: string
  symbol: string
  signal: "bullish" | "bearish" | "neutral"
  entry_price: number
  step?: number
  strength?: number
  signal_strength?: number
}

function transformIndicationResult(
  result: { signal_strength?: number; entry_price: number; type: string; symbol: string } | null,
  indicationType: string,
  symbol: string,
): LocalIndicationResult | null {
  if (!result) return null
  const signalStrength = result.signal_strength || 0
  return {
    type: indicationType,
    symbol: symbol,
    signal: signalStrength > 0 ? "bullish" : signalStrength < 0 ? "bearish" : "neutral",
    entry_price: result.entry_price,
    signal_strength: signalStrength,
    strength: Math.abs(signalStrength),
  }
}

export interface PresetTradeEngineConfig {
  connectionId: string
  presetId: string
  symbols: string[]
  mode: "automatic" | "configured"
  minProfitFactor: number
  maxDrawdownHours: number
  useTopSymbols: boolean
  topSymbolsCount: number
  indicationCategory?: IndicationCategory
  indicationType?: string
}

export class PresetTradeEngine {
  private connectionId: string
  private presetId: string
  private isRunning = false
  private tradeInterval?: NodeJS.Timeout
  private realInterval?: NodeJS.Timeout
  private indicationEngine: IndicationEngine
  private activeIndications: Map<string, any> = new Map()
  private lastIntervalComplete = true
  private lastRealIntervalComplete = true

  private readonly BATCH_SIZE = 10
  private readonly MAX_CONCURRENT = 5
  private readonly RATE_LIMIT_DELAY = 100 // ms between API calls

  constructor(connectionId: string, presetId: string) {
    this.connectionId = connectionId
    this.presetId = presetId
    this.indicationEngine = new IndicationEngine()
  }

  /**
   * Start the preset trade engine with non-overlapping intervals
   */
  async start(config: PresetTradeEngineConfig): Promise<void> {
    if (this.isRunning) {
      console.log("[v0] Preset trade engine already running")
      return
    }

    this.isRunning = true
    console.log("[v0] Starting preset trade engine for connection:", this.connectionId)

    // Get configured interval from settings
    const settings = await this.getSettings()
    const indicationInterval = Number.parseInt(settings.presetIndicationInterval || "1") * 1000
    const realInterval = Number.parseInt(settings.presetRealInterval || "200")

    const indicationCategory = config.indicationCategory || settings.presetIndicationCategory || "common"

    // Initial run
    await this.processIndications(config.symbols, config, indicationCategory)

    // Set up intervals with overlap protection
    this.tradeInterval = setInterval(async () => {
      if (!this.lastIntervalComplete) {
        console.log("[v0] Skipping indication interval - previous still running")
        return
      }

      this.lastIntervalComplete = false
      try {
        await this.processIndications(config.symbols, config, indicationCategory)
      } finally {
        this.lastIntervalComplete = true
      }
    }, indicationInterval)

    this.realInterval = setInterval(async () => {
      if (!this.lastRealIntervalComplete) {
        console.log("[v0] Skipping real interval - previous still running")
        return
      }

      this.lastRealIntervalComplete = false
      try {
        await this.processRealPositions(config)
      } finally {
        this.lastRealIntervalComplete = true
      }
    }, realInterval)
  }

  /**
   * Stop the preset trade engine
   */
  stop(): void {
    this.isRunning = false

    if (this.tradeInterval) {
      clearInterval(this.tradeInterval)
      this.tradeInterval = undefined
    }

    if (this.realInterval) {
      clearInterval(this.realInterval)
      this.realInterval = undefined
    }

    console.log("[v0] Preset trade engine stopped")
  }

  /**
   * Process indications based on category (Main or Common)
   */
  private async processIndications(
    symbols: string[],
    config: PresetTradeEngineConfig,
    indicationCategory: string,
  ): Promise<void> {
    console.log(`[v0] Processing indications for ${symbols.length} symbols (category: ${indicationCategory})`)

    if (indicationCategory === INDICATION_CATEGORIES.MAIN) {
      await this.processIndicationsMain(symbols, config)
    } else {
      await this.processIndicationsCommonIndicators(symbols, config)
    }
  }

  /**
   * Process MAIN INDICATIONS (Direction, Move, Active, Optimal)
   * Step-based position generation using the Indication Engine
   */
  private async processIndicationsMain(symbols: string[], config: PresetTradeEngineConfig): Promise<void> {
    const settings = await this.getSettings()

    // Get enabled main indication types
    const enabledTypes: string[] = []
    if (settings.directionEnabled !== "false") enabledTypes.push("direction")
    if (settings.moveEnabled !== "false") enabledTypes.push("move")
    if (settings.activeEnabled === "true") enabledTypes.push("active")
    if (settings.optimalEnabled === "true") enabledTypes.push("optimal")

    if (enabledTypes.length === 0) {
      console.log("[v0] No main indication types enabled")
      return
    }

    const batches = this.createBatches(symbols, this.BATCH_SIZE)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (symbol) => {
          try {
            // Get recent price data for indication calculations
            const prices = await this.getRecentPrices(symbol, 100)
            if (prices.length < 20) {
              console.log(`[v0] Insufficient price data for ${symbol}`)
              return
            }

            for (const indicationType of enabledTypes) {
              let indication: LocalIndicationResult | null = null

              const baseConfig = {
                range: Number.parseInt(settings[`${indicationType}Range`] || "20"),
                price_change_ratio: Number.parseFloat(settings[`${indicationType}PriceChangeRatio`] || "0.1"),
              }

              // Call the correct method based on indication type
              switch (indicationType) {
                case "direction":
                  indication = transformIndicationResult(
                    await this.indicationEngine.calculateDirectionIndication(symbol, prices, {
                      ...baseConfig,
                      type: "direction" as const,
                    }),
                    "direction",
                    symbol,
                  )
                  break
                case "move":
                  indication = transformIndicationResult(
                    await this.indicationEngine.calculateMoveIndication(symbol, prices, {
                      ...baseConfig,
                      type: "move" as const,
                    }),
                    "move",
                    symbol,
                  )
                  break
                case "active":
                  indication = transformIndicationResult(
                    await this.indicationEngine.calculateActiveIndication(symbol, prices, {
                      ...baseConfig,
                      type: "active" as const,
                    }),
                    "active",
                    symbol,
                  )
                  break
                case "optimal":
                  // Calculate all three indication types for optimal
                  const dirResult = transformIndicationResult(
                    await this.indicationEngine.calculateDirectionIndication(symbol, prices, {
                      ...baseConfig,
                      type: "direction" as const,
                    }),
                    "direction",
                    symbol,
                  )
                  const moveResult = transformIndicationResult(
                    await this.indicationEngine.calculateMoveIndication(symbol, prices, {
                      ...baseConfig,
                      type: "move" as const,
                    }),
                    "move",
                    symbol,
                  )
                  const activeResult = transformIndicationResult(
                    await this.indicationEngine.calculateActiveIndication(symbol, prices, {
                      ...baseConfig,
                      type: "active" as const,
                    }),
                    "active",
                    symbol,
                  )

                  // Combine signals for optimal
                  if (dirResult || moveResult || activeResult) {
                    const signals = [dirResult, moveResult, activeResult].filter(Boolean) as LocalIndicationResult[]
                    if (signals.length >= 2) {
                      // Calculate average signal strength from IndicationResult objects
                      const avgStrength = signals.reduce((sum, s) => sum + (s.signal_strength || 0), 0) / signals.length
                      // Derive signal direction from strength (positive = bullish, negative = bearish)
                      const signalDirection = avgStrength > 0 ? "bullish" : avgStrength < 0 ? "bearish" : "neutral"
                      indication = {
                        type: "optimal",
                        symbol,
                        signal: signalDirection,
                        entry_price: prices[prices.length - 1],
                        step: 1, // Default step for optimal combined indication
                        strength: Math.abs(avgStrength),
                      }
                    }
                  }
                  break
              }

              if (indication && indication.signal !== "neutral") {
                await this.processMainIndicationResult(
                  {
                    symbol,
                    entry_price: indication.entry_price,
                    direction: indication.signal === "bullish" ? "long" : "short",
                    indication_type: indicationType,
                    indication_step: indication.step ?? 0, // Use nullish coalescing for safety
                    strength: indication.strength ?? 0, // Use nullish coalescing for safety
                  },
                  config,
                )
              }
            }
          } catch (error) {
            console.error(`[v0] Error processing main indications for ${symbol}:`, error)
          }
        }),
      )

      // Rate limiting between batches
      await this.delay(this.RATE_LIMIT_DELAY)
    }
  }

  /**
   * Process indications using COMMON INDICATORS (RSI, MACD, Bollinger, ParabolicSAR, ADX, ATR, etc.)
   * This is the correct approach for Preset Trade mode
   */
  private async processIndicationsCommonIndicators(symbols: string[], config: PresetTradeEngineConfig): Promise<void> {
    const settings = await this.getSettings()

    // Get configured common indicators from settings
    const commonIndicators = this.getConfiguredIndicators(settings)

    const batches = this.createBatches(symbols, this.BATCH_SIZE)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (symbol) => {
          try {
            // Get recent price data (enough for all indicators)
            const prices = await this.getRecentPrices(symbol, 200)

            if (prices.length < 50) {
              console.log(`[v0] Insufficient price data for ${symbol}`)
              return
            }

            // Calculate all common indicators
            const signals = calculateIndicators(prices, commonIndicators)

            // Combine signals to determine entry
            const combinedSignal = TechnicalIndicators.combineSignals(signals)

            if (combinedSignal.direction !== "neutral" && combinedSignal.strength > 0.5) {
              // Generate pseudo positions with wider TP/SL ranges
              await this.processIndicationResult(
                {
                  symbol,
                  entry_price: prices[prices.length - 1],
                  direction: combinedSignal.direction,
                  strength: combinedSignal.strength,
                  indicators: signals,
                },
                config,
              )
            }
          } catch (error) {
            console.error(`[v0] Error processing indications for ${symbol}:`, error)
          }
        }),
      )

      // Rate limiting between batches
      await this.delay(this.RATE_LIMIT_DELAY)
    }
  }

  /**
   * Initialize engine state
   */
  private async initializeEngineState(config: PresetTradeEngineConfig): Promise<void> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO preset_trade_engine_state (
        connection_id, preset_id, mode, status, config, started_at
      ) VALUES (
        ?, ?, ?, 'running',
        ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT (connection_id, preset_id)
      DO UPDATE SET
        status = 'running',
        mode = ?,
        config = ?,
        started_at = CURRENT_TIMESTAMP,
        stopped_at = NULL
    `
      : `
      INSERT INTO preset_trade_engine_state (
        connection_id, preset_id, mode, status, config, started_at
      ) VALUES (
        $1, $2, $3, 'running',
        $4, CURRENT_TIMESTAMP
      )
      ON CONFLICT (connection_id, preset_id)
      DO UPDATE SET
        status = 'running',
        mode = $5,
        config = $6,
        started_at = CURRENT_TIMESTAMP,
        stopped_at = NULL
    `

    await execute(queryText, [
      this.connectionId,
      this.presetId,
      config.mode,
      JSON.stringify(config),
      config.mode,
      JSON.stringify(config),
    ])
  }

  /**
   * Load historical data for prehistoric calculations (5 days)
   * Optimized with parallel processing and concurrency limits
   */
  private async loadHistoricalData(symbols: string[]): Promise<void> {
    console.log(`[v0] Loading historical data for ${symbols.length} symbols...`)

    const settings = await this.getSettings()
    const timeRangeDays = Number.parseInt(settings.timeRangeHistoryDays || "36500") // 100 years - NO LIMIT
    const timeframeSeconds = Number.parseFloat(settings.marketDataTimeframe || "1.0")

    // NO BATCHING, UNLIMITED CONCURRENCY, NO RATE LIMIT
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          // Fetch historical OHLCV data
          const historicalData = await this.fetchHistoricalOHLCV(symbol, timeRangeDays, timeframeSeconds)

          // Store in database for prehistoric calculations
          await this.storeHistoricalData(symbol, historicalData)

          console.log(`[v0] Loaded ${historicalData.length} candles for ${symbol}`)
        } catch (error) {
          console.error(`[v0] Failed to load historical data for ${symbol}:`, error)
        }
      }),
    )

    console.log("[v0] Historical data loading complete")
  }

  /**
   * Trade Interval Loop (1.0s) - NON-OVERLAPPING
   * Processes: Indications → Strategies → Pseudo Positions → Logging
   */
  private async startTradeIntervalLoop(config: PresetTradeEngineConfig): Promise<void> {
    const settings = await this.getSettings()
    const intervalMs = Number.parseFloat(settings.tradeEngineInterval || "1.0") * 1000

    this.tradeInterval = setInterval(async () => {
      if (!this.lastIntervalComplete) {
        console.log("[v0] Previous trade interval still running, skipping...")
        return
      }

      this.lastIntervalComplete = false

      try {
        await this.processTradeInterval(config)
      } catch (error) {
        console.error("[v0] Trade interval error:", error)
      } finally {
        this.lastIntervalComplete = true
      }
    }, intervalMs)
  }

  /**
   * Process complete trade interval
   */
  private async processTradeInterval(config: PresetTradeEngineConfig): Promise<void> {
    const startTime = Date.now()

    // Get symbols (top 25 by market cap or configured)
    const symbols = config.useTopSymbols
      ? await this.getTopSymbolsByMarketCap(config.topSymbolsCount || 25)
      : config.symbols

    await this.processIndicationsCommonIndicators(symbols, config)

    // Stage 2: Strategy Processing (Validate and create Main pseudo positions)
    await this.processStrategies(symbols, config)

    // Stage 3: Pseudo Position Management (Update and validate)
    await this.managePseudoPositions(config)

    // Stage 4: Logging & Metrics
    await this.logMetrics(symbols.length, Date.now() - startTime)
  }

  /**
   * Process indication result and generate pseudo positions
   * Wider TP/SL ranges for short-term trading (starting from factor 2)
   */
  private async processIndicationResult(indication: any, config: PresetTradeEngineConfig): Promise<void> {
    // Check validation cooldown (15 seconds)
    const lastValidation = this.activeIndications.get(`${indication.symbol}-${indication.direction}`)
    if (lastValidation && Date.now() - lastValidation < 15000) {
      return // Skip if within cooldown period
    }

    const pseudoPositions = await this.generateShortTermPseudoPositions(
      indication.symbol,
      indication.entry_price,
      indication.direction,
      indication.strength,
      indication.indicators,
    )

    // Store pseudo positions (batch insert for performance)
    await this.batchInsertPseudoPositions(pseudoPositions)

    // Update validation timestamp
    this.activeIndications.set(`${indication.symbol}-${indication.direction}`, Date.now())

    console.log(
      `[v0] Generated ${pseudoPositions.length} pseudo positions for ${indication.symbol} (${indication.direction})`,
    )
  }

  /**
   * Generate pseudo positions optimized for short-term trading
   * Uses configurable ranges from Settings / Main / Preset Trade
   */
  private async generateShortTermPseudoPositions(
    symbol: string,
    entryPrice: number,
    direction: "long" | "short",
    strength: number,
    indicators: IndicatorSignal[],
  ): Promise<any[]> {
    const positions: any[] = []

    const settings = await this.getSettings()
    const positionCost = Number.parseFloat(settings.positionCost || "0.1") // Default 10%

    const tpMin = Number.parseFloat(settings.presetTpMin || "2")
    const tpMax = Number.parseFloat(settings.presetTpMax || "30")
    const tpStep = Number.parseFloat(settings.presetTpStep || "2")
    const slMin = Number.parseFloat(settings.presetSlMin || "0.3")
    const slMax = Number.parseFloat(settings.presetSlMax || "3.0")
    const slStep = Number.parseFloat(settings.presetSlStep || "0.3")
    const trailStarts = JSON.parse(settings.presetTrailStarts || "[0.5, 1.0, 1.5]")
    const trailStops = JSON.parse(settings.presetTrailStops || "[0.2, 0.4, 0.6]")

    // Generate positions with configurable ranges
    for (let tpFactor = tpMin; tpFactor <= tpMax; tpFactor += tpStep) {
      for (let slRatio = slMin; slRatio <= slMax; slRatio += slStep) {
        // Without trailing
        positions.push({
          id: this.generateId(),
          connection_id: this.connectionId,
          preset_id: this.presetId,
          symbol,
          type: "base",
          direction,
          strength,
          indicators: JSON.stringify(indicators.map((i) => ({ type: i.type, value: i.value }))),
          takeprofit_factor: tpFactor,
          stoploss_ratio: slRatio,
          trailing_enabled: false,
          entry_price: entryPrice,
          current_price: entryPrice,
          profit_factor: 0,
          position_cost: positionCost,
          status: "active",
          created_at: new Date().toISOString(),
        })

        // With trailing (using configured values)
        trailStarts.forEach((trailStart: number) => {
          trailStops.forEach((trailStop: number) => {
            positions.push({
              id: this.generateId(),
              connection_id: this.connectionId,
              preset_id: this.presetId,
              symbol,
              type: "base",
              direction,
              strength,
              indicators: JSON.stringify(indicators.map((i) => ({ type: i.type, value: i.value }))),
              takeprofit_factor: tpFactor,
              stoploss_ratio: slRatio,
              trailing_enabled: true,
              trail_start: trailStart,
              trail_stop: trailStop,
              entry_price: entryPrice,
              current_price: entryPrice,
              profit_factor: 0,
              position_cost: positionCost,
              status: "active",
              created_at: new Date().toISOString(),
            })
          })
        })
      }
    }

    // Limit to 250 positions per indication
    return positions.slice(0, 250)
  }

  /**
   * Get configured common indicators from settings
   * Updated to include ParabolicSAR with proper settings
   */
  private async getCommonIndicators(): Promise<IndicatorConfig[]> {
    const indicators: IndicatorConfig[] = []

    try {
      // Fetch common indications from API
      const response = await fetch(`http://localhost:3001/api/settings/indications/common?t=${Date.now()}`, {
        headers: { "Content-Type": "application/json" },
      })
      
      if (!response.ok) throw new Error("Failed to fetch common indications")
      
      const data = await response.json()
      const commonSettings = data.settings || {}

      // RSI
      if (commonSettings.rsi?.enabled) {
        const period = commonSettings.rsi.period
        indicators.push({
          type: "rsi" as const,
          params: {
            period: period?.from || 14,
            oversold: commonSettings.rsi.oversold?.from || 30,
            overbought: commonSettings.rsi.overbought?.from || 70,
          },
        })
      }

      // MACD
      if (commonSettings.macd?.enabled) {
        indicators.push({
          type: "macd" as const,
          params: {
            fastPeriod: commonSettings.macd.fastPeriod?.from || 12,
            slowPeriod: commonSettings.macd.slowPeriod?.from || 26,
            signalPeriod: commonSettings.macd.signalPeriod?.from || 9,
          },
        })
      }

      // Bollinger Bands
      if (commonSettings.bollinger?.enabled) {
        indicators.push({
          type: "bollinger" as const,
          params: {
            period: commonSettings.bollinger.period?.from || 20,
            stdDev: commonSettings.bollinger.stdDev?.from || 2,
          },
        })
      }

      // EMA
      if (commonSettings.ema?.enabled) {
        indicators.push({
          type: "ema" as const,
          params: {
            period: commonSettings.ema.period?.from || 12,
          },
        })
      }

      // SMA
      if (commonSettings.sma?.enabled) {
        indicators.push({
          type: "sma" as const,
          params: {
            period: commonSettings.sma.period?.from || 20,
          },
        })
      }

      // Stochastic
      if (commonSettings.stochastic?.enabled) {
        indicators.push({
          type: "stochastic" as const,
          params: {
            kPeriod: commonSettings.stochastic.kPeriod?.from || 14,
            dPeriod: commonSettings.stochastic.dPeriod?.from || 3,
            overbought: commonSettings.stochastic.overbought?.from || 80,
            oversold: commonSettings.stochastic.oversold?.from || 20,
          },
        })
      }

      // Parabolic SAR
      if (commonSettings.parabolicSAR?.enabled) {
        indicators.push({
          type: "sar" as const,
          params: {
            acceleration: commonSettings.parabolicSAR.acceleration?.from || 0.02,
            maximum: commonSettings.parabolicSAR.maximum?.from || 0.2,
          },
        })
      }

      // ADX
      if (commonSettings.adx?.enabled) {
        indicators.push({
          type: "adx" as const,
          params: {
            period: commonSettings.adx.period?.from || 14,
            threshold: commonSettings.adx.threshold?.from || 25,
          },
        })
      }
    } catch (error) {
      console.error("[v0] Failed to fetch common indications, using defaults:", error)
    }

    // Default if none enabled or fetch failed
    if (indicators.length === 0) {
      return [
        { type: "rsi", params: { period: 14, oversold: 30, overbought: 70 } },
        { type: "macd", params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
        { type: "bollinger", params: { period: 20, stdDev: 2 } },
        { type: "sar", params: { acceleration: 0.02, maximum: 0.2 } },
        { type: "adx", params: { period: 14 } },
      ]
    }

    return indicators
  }

  /**
   * Get configured indicators for Common strategy
   */
  private getConfiguredIndicators(settings: Record<string, string>): IndicatorConfig[] {
    const indicators: IndicatorConfig[] = []

    // RSI
    if (settings.rsiEnabled !== "false") {
      indicators.push({
        type: "rsi" as const,
        params: {
          period: Number(settings.rsiPeriod) || 14,
          oversold: Number(settings.rsiOversold) || 30,
          overbought: Number(settings.rsiOverbought) || 70,
        },
      })
    }

    // MACD
    if (settings.macdEnabled !== "false") {
      indicators.push({
        type: "macd" as const,
        params: {
          fastPeriod: Number(settings.macdFastPeriod) || 12,
          slowPeriod: Number(settings.macdSlowPeriod) || 26,
          signalPeriod: Number(settings.macdSignalPeriod) || 9,
        },
      })
    }

    // Bollinger Bands
    if (settings.bollingerEnabled !== "false") {
      indicators.push({
        type: "bollinger" as const,
        params: {
          period: Number(settings.bollingerPeriod) || 20,
          stdDev: Number(settings.bollingerStdDev) || 2,
        },
      })
    }

    // Parabolic SAR
    if (settings.parabolicSAREnabled !== "false") {
      indicators.push({
        type: "sar" as const,
        params: {
          acceleration: Number(settings.parabolicSARAcceleration) || 0.02,
          maximum: Number(settings.parabolicSARMaximum) || 0.2,
        },
      })
    }

    // ADX
    if (settings.adxEnabled !== "false") {
      indicators.push({
        type: "adx" as const,
        params: {
          period: Number(settings.adxPeriod) || 14,
          threshold: Number(settings.adxThreshold) || 25,
        },
      })
    }

    // ATR (for volatility-based stops)
    if (settings.atrEnabled !== "false") {
      // ATR is used for position sizing, not direct signals
      // But we can include it for volatility analysis
    }

    // Default if none enabled
    if (indicators.length === 0) {
      return [
        { type: "rsi", params: { period: 14, oversold: 30, overbought: 70 } },
        { type: "macd", params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
        { type: "bollinger", params: { period: 20, stdDev: 2 } },
        { type: "sar", params: { acceleration: 0.02, maximum: 0.2 } },
        { type: "adx", params: { period: 14 } },
      ]
    }

    return indicators
  }

  /**
   * Process strategies and create Main pseudo positions
   */
  private async processStrategies(symbols: string[], config: PresetTradeEngineConfig): Promise<void> {
    const placeholder = getDatabaseType() === "sqlite" ? "?" : "$1"
    const placeholder2 = getDatabaseType() === "sqlite" ? "?" : "$2"

    const basePositions = await query<any>(
      `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = ${placeholder}
        AND preset_id = ${placeholder2}
        AND type = 'base'
        AND status = 'active'
      ORDER BY symbol, created_at DESC
    `,
      [this.connectionId, this.presetId],
    )

    // Group by symbol
    const positionsBySymbol = this.groupBy(basePositions, "symbol")

    // Process each symbol
    for (const [symbol, positions] of Object.entries(positionsBySymbol)) {
      try {
        // Validate and create Main pseudo positions
        const validatedPositions = positions.filter((p: any) => p.profit_factor >= config.minProfitFactor)

        // Check position cooldown (20 seconds)
        const lastPosition = await this.getLastClosedPosition(symbol)
        if (lastPosition && Date.now() - new Date(lastPosition.closed_at).getTime() < 20000) {
          continue // Skip if within cooldown period
        }

        // Check max active per config (1 position per configuration set)
        const activeCount = await this.getActivePositionCount(symbol)
        if (activeCount >= 1) {
          continue // Skip if already have active position for this symbol
        }

        // Create Main pseudo positions from validated Base positions.
        //
        // Previously this silently truncated `validatedPositions` to the
        // first 10 entries, meaning that if a symbol produced 25 Base
        // positions that passed the profit-factor filter, 15 of them
        // were discarded with no log, no config, and no way for the
        // operator to tell. That's a real data-loss bug — downstream
        // consumers expect every qualifying Base promotion to produce
        // a corresponding Main row. The outer `activeCount >= 1` gate
        // above already limits this loop to the single-active-position
        // invariant, so the per-iteration cap was also redundant.
        //
        // We keep a very high safety ceiling (500) purely as a
        // defence-in-depth against a runaway filter returning an
        // absurd list — if we ever hit it, emit a warning so the
        // operator can investigate rather than fail silently.
        const SAFETY_CEILING = 500
        if (validatedPositions.length > SAFETY_CEILING) {
          console.warn(
            `[v0] [preset-trade-engine] Symbol ${symbol} produced ${validatedPositions.length} validated base positions, exceeding safety ceiling of ${SAFETY_CEILING}. Processing first ${SAFETY_CEILING}; investigate the profit-factor filter.`,
          )
        }
        for (const basePosition of validatedPositions.slice(0, SAFETY_CEILING)) {
          const isSqlite = getDatabaseType() === "sqlite"
          const queryText = isSqlite
            ? `
            INSERT INTO preset_pseudo_positions (
              id, connection_id, preset_id, symbol, type,
              indication_type, indication_range,
              takeprofit_factor, stoploss_ratio,
              trailing_enabled, trail_start, trail_stop,
              entry_price, current_price, profit_factor,
              position_cost, base_position_id, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `
            : `
            INSERT INTO preset_pseudo_positions (
              id, connection_id, preset_id, symbol, type,
              indication_type, indication_range,
              takeprofit_factor, stoploss_ratio,
              trailing_enabled, trail_start, trail_stop,
              entry_price, current_price, profit_factor,
              position_cost, base_position_id, status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT DO NOTHING
          `

          await execute(queryText, [
            this.generateId(),
            this.connectionId,
            this.presetId,
            basePosition.symbol,
            "main",
            basePosition.indication_type,
            basePosition.indication_range,
            basePosition.takeprofit_factor,
            basePosition.stoploss_ratio,
            basePosition.trailing_enabled,
            basePosition.trail_start,
            basePosition.trail_stop,
            basePosition.entry_price,
            basePosition.current_price,
            basePosition.profit_factor,
            basePosition.position_cost,
            basePosition.id,
            "active",
            new Date().toISOString(),
          ])
        }
      } catch (error) {
        console.error(`[v0] Error processing strategies for ${symbol}:`, error)
      }
    }
  }

  /**
   * Manage pseudo positions (update, validate, close)
   */
  private async managePseudoPositions(config: PresetTradeEngineConfig): Promise<void> {
    const placeholder = getDatabaseType() === "sqlite" ? "?" : "$1"
    const placeholder2 = getDatabaseType() === "sqlite" ? "?" : "$2"

    const activePositions = await query<any>(
      `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = ${placeholder}
        AND preset_id = ${placeholder2}
        AND status = 'active'
    `,
      [this.connectionId, this.presetId],
    )

    // Update with current prices (batch)
    const symbols = [...new Set(activePositions.map((p: any) => p.symbol))]
    const currentPrices = await this.getCurrentPrices(symbols)

    // Process positions in batches
    const batches = this.createBatches(activePositions, this.BATCH_SIZE)

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (position: any) => {
          try {
            const currentPrice = currentPrices.get(position.symbol)
            if (!currentPrice) return

            // Update profit factor
            const priceDiff = currentPrice - position.entry_price
            const profitFactor = priceDiff / (position.entry_price * position.position_cost)

            // Check exit conditions
            const shouldClose = this.checkExitConditions(position, currentPrice, profitFactor)

            if (shouldClose) {
              await this.closePosition(position, currentPrice, profitFactor)
            } else {
              const isSqlite = getDatabaseType() === "sqlite"
              const queryText = isSqlite
                ? `
                UPDATE preset_pseudo_positions
                SET current_price = ?, profit_factor = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `
                : `
                UPDATE preset_pseudo_positions
                SET current_price = $1, profit_factor = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $3
              `

              await execute(queryText, [currentPrice, profitFactor, position.id])
            }

            // Validate Main positions for Real trading
            if (position.type === "main" && profitFactor >= config.minProfitFactor) {
              await this.validateForRealTrading(position, config)
            }
          } catch (error) {
            console.error(`[v0] Error managing position ${position.id}:`, error)
          }
        }),
      )
    }
  }

  /**
   * Real Positions Interval Loop (0.3s) - NON-OVERLAPPING
   * Handles exchange real position updates
   */
  private async startRealIntervalLoop(): Promise<void> {
    const settings = await this.getSettings()
    const intervalMs = Number.parseFloat(settings.realPositionsInterval || "0.3") * 1000

    this.realInterval = setInterval(async () => {
      if (!this.lastRealIntervalComplete) {
        console.log("[v0] Previous real interval still running, skipping...")
        return
      }

      this.lastRealIntervalComplete = false

      try {
        await this.processRealInterval()
      } catch (error) {
        console.error("[v0] Real interval error:", error)
      } finally {
        this.lastRealIntervalComplete = true
      }
    }, intervalMs)
  }

  /**
   * Process real positions interval
   * Batched API calls for rate limit compliance
   */
  private async processRealInterval(): Promise<void> {
    const placeholder = getDatabaseType() === "sqlite" ? "?" : "$1"
    const placeholder2 = getDatabaseType() === "sqlite" ? "?" : "$2"

    const realPositions = await query<any>(
      `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = ${placeholder}
        AND preset_id = ${placeholder2}
        AND type = 'real'
        AND status = 'active'
      LIMIT 50
    `,
      [this.connectionId, this.presetId],
    )

    if (realPositions.length === 0) return

    const exchangePositions = await this.fetchExchangePositions()

    // Match and update
    const updates: any[] = []

    for (const realPos of realPositions) {
      const exchangePos = exchangePositions.find((ep: any) => ep.symbol === realPos.symbol)

      if (exchangePos) {
        updates.push({
          id: realPos.id,
          currentPrice: exchangePos.markPrice,
          profitLoss: exchangePos.unrealizedProfit,
        })
      }
    }

    if (updates.length > 0) {
      await this.batchUpdateRealPositions(updates)
    }
  }

  // ============ HELPER METHODS ============

  private async getSettings(): Promise<Record<string, string>> {
    const result = await query<any>(`SELECT key, value FROM system_settings`)
    return Object.fromEntries(result.map((r: any) => [r.key, r.value]))
  }

  private async getTopSymbolsByMarketCap(count: number): Promise<string[]> {
    const placeholder = getDatabaseType() === "sqlite" ? "?" : "$1"
    const result = await query<any>(
      `
      SELECT symbol FROM market_data
      WHERE timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY symbol
      ORDER BY SUM(volume * price) DESC
      LIMIT ${placeholder}
    `,
      [count],
    )
    return result.map((r: any) => r.symbol)
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize))
    }
    return batches
  }

  private groupBy<T>(array: T[], key: string): Record<string, T[]> {
    return array.reduce((result: any, item: any) => {
      const groupKey = item[key]
      if (!result[groupKey]) result[groupKey] = []
      result[groupKey].push(item)
      return result
    }, {})
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  private async fetchHistoricalOHLCV(symbol: string, days: number, timeframe: number): Promise<any[]> {
    // Implement exchange API call to fetch historical data
    // This is a placeholder - actual implementation depends on exchange
    return []
  }

  private async storeHistoricalData(symbol: string, data: any[]): Promise<void> {
    if (data.length === 0) return

    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO market_data (connection_id, symbol, price, timestamp)
      VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `
      : `
      INSERT INTO market_data (connection_id, symbol, price, timestamp)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `

    for (const d of data) {
      await execute(queryText, [this.connectionId, symbol, d.close, d.timestamp])
    }
  }

  private async getRecentPrices(symbol: string, count: number): Promise<number[]> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      SELECT price FROM market_data
      WHERE connection_id = ? AND symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      : `
      SELECT price FROM market_data
      WHERE connection_id = $1 AND symbol = $2
      ORDER BY timestamp DESC
      LIMIT $3
    `

    const result = await query<any>(queryText, [this.connectionId, symbol, count])
    return result.map((r: any) => r.price).reverse()
  }

  private async getCurrentPrices(symbols: string[]): Promise<Map<string, number>> {
    const isSqlite = getDatabaseType() === "sqlite"

    let result: any[] = []

    if (isSqlite) {
      const placeholders = symbols.map(() => "?").join(",")
      result = await query<any>(
        `
        SELECT symbol, price
        FROM market_data
        WHERE connection_id = ? AND symbol IN (${placeholders})
        ORDER BY symbol, timestamp DESC
      `,
        [this.connectionId, ...symbols],
      )
    } else {
      result = await query<any>(
        `
      SELECT DISTINCT ON (symbol) symbol, price
      FROM market_data
      WHERE connection_id = $1 AND symbol = ANY($2)
      ORDER BY symbol, timestamp DESC
    `,
        [this.connectionId, symbols],
      )
    }

    return new Map(result.map((r: any) => [r.symbol, r.price]))
  }

  private async batchInsertPseudoPositions(positions: any[]): Promise<void> {
    if (positions.length === 0) return

    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        direction, strength, indicators, takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        entry_price, current_price, profit_factor, position_cost,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `
      : `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        direction, strength, indicators, takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        entry_price, current_price, profit_factor, position_cost,
        status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT DO NOTHING
    `

    const batches = this.createBatches(positions, 50)

    for (const batch of batches) {
      for (const p of batch) {
        await execute(queryText, [
          p.id,
          p.connection_id,
          p.preset_id,
          p.symbol,
          p.type,
          p.direction,
          p.strength,
          p.indicators,
          p.takeprofit_factor,
          p.stoploss_ratio,
          p.trailing_enabled,
          p.trail_start,
          p.trail_stop,
          p.entry_price,
          p.current_price,
          p.profit_factor,
          p.position_cost,
          p.status,
          p.created_at,
        ])
      }
    }
  }

  private checkExitConditions(position: any, currentPrice: number, profitFactor: number): boolean {
    // Check TP/SL
    const tpPrice = position.entry_price * (1 + position.takeprofit_factor * position.position_cost)
    const slPrice =
      position.entry_price * (1 - position.stoploss_ratio * position.takeprofit_factor * position.position_cost)

    if (currentPrice >= tpPrice || currentPrice <= slPrice) {
      return true
    }

    // Check timeout (2 hours for short-term trading)
    const openedAt = new Date(position.created_at)
    const hoursOpen = (Date.now() - openedAt.getTime()) / (1000 * 60 * 60)

    if (hoursOpen >= 2) {
      return true
    }

    return false
  }

  private async closePosition(position: any, currentPrice: number, profitFactor: number): Promise<void> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      UPDATE preset_pseudo_positions
      SET status = 'closed',
          current_price = ?,
          profit_factor = ?,
          closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
      : `
      UPDATE preset_pseudo_positions
      SET status = 'closed',
          current_price = $1,
          profit_factor = $2,
          closed_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `

    await execute(queryText, [currentPrice, profitFactor, position.id])
  }

  private async getLastClosedPosition(symbol: string): Promise<any> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = ? AND preset_id = ? AND symbol = ? AND status = 'closed'
      ORDER BY closed_at DESC
      LIMIT 1
    `
      : `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = $1 AND preset_id = $2 AND symbol = $3 AND status = 'closed'
      ORDER BY closed_at DESC
      LIMIT 1
    `

    const result = await query<any>(queryText, [this.connectionId, this.presetId, symbol])
    return result[0]
  }

  private async getActivePositionCount(symbol: string): Promise<number> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      SELECT COUNT(*) as count FROM preset_pseudo_positions
      WHERE connection_id = ? AND preset_id = ? AND symbol = ? AND type = 'main' AND status = 'active'
    `
      : `
      SELECT COUNT(*) as count FROM preset_pseudo_positions
      WHERE connection_id = $1 AND preset_id = $2 AND symbol = $3 AND type = 'main' AND status = 'active'
    `

    const result = await query<any>(queryText, [this.connectionId, this.presetId, symbol])
    return Number(result[0]?.count || 0)
  }

  private async validateForRealTrading(position: any, config: PresetTradeEngineConfig): Promise<void> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        indication_type, indication_range,
        takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        entry_price, current_price, profit_factor,
        position_cost, main_position_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `
      : `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        indication_type, indication_range,
        takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        entry_price, current_price, profit_factor,
        position_cost, main_position_id, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT DO NOTHING
    `

    await execute(queryText, [
      this.generateId(),
      this.connectionId,
      this.presetId,
      position.symbol,
      "real",
      position.indication_type,
      position.indication_range,
      position.takeprofit_factor,
      position.stoploss_ratio,
      position.trailing_enabled,
      position.trail_start,
      position.trail_stop,
      position.entry_price,
      position.current_price,
      position.profit_factor,
      position.position_cost,
      position.id,
      "active",
      new Date().toISOString(),
    ])
  }

  private async fetchExchangePositions(): Promise<any[]> {
    // Implement exchange API call to fetch all positions
    // This is a placeholder - actual implementation depends on exchange
    return []
  }

  private async batchUpdateRealPositions(updates: any[]): Promise<void> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      UPDATE preset_pseudo_positions
      SET current_price = ?, profit_loss = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
      : `
      UPDATE preset_pseudo_positions
      SET current_price = $1, profit_loss = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
    `

    for (const update of updates) {
      await execute(queryText, [update.currentPrice, update.profitLoss, update.id])
    }
  }

  private async logMetrics(symbolCount: number, duration: number): Promise<void> {
    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO preset_engine_metrics (
        connection_id, preset_id, symbol_count, duration_ms, timestamp
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `
      : `
      INSERT INTO preset_engine_metrics (
        connection_id, preset_id, symbol_count, duration_ms, timestamp
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `

    await execute(queryText, [this.connectionId, this.presetId, symbolCount, duration])
  }

  /**
   * Process Main Indication result and generate pseudo positions
   */
  private async processMainIndicationResult(
    result: {
      symbol: string
      entry_price: number
      direction: "long" | "short"
      indication_type: string
      indication_step: number
      strength: number
    },
    config: PresetTradeEngineConfig,
  ): Promise<void> {
    const positions = await this.generateMainIndicationPositions(
      result.symbol,
      result.entry_price,
      result.direction,
      result.indication_type,
      result.indication_step,
      result.strength,
    )

    if (positions.length > 0) {
      await this.savePositions(positions)
      console.log(`[v0] Generated ${positions.length} main indication positions for ${result.symbol}`)
    }
  }

  /**
   * Generate pseudo positions for Main Indications
   */
  private async generateMainIndicationPositions(
    symbol: string,
    entryPrice: number,
    direction: "long" | "short",
    indicationType: string,
    indicationStep: number,
    strength: number,
  ): Promise<any[]> {
    const positions: any[] = []

    const settings = await this.getSettings()
    const positionCost = Number.parseFloat(settings.positionCost || "0.1")

    // Get step-based ranges
    const stepMin = indicationStep * Number(settings.stepRelationMinRatio || 0.2)
    const stepMax = indicationStep * Number(settings.stepRelationMaxRatio || 1.0)

    const tpMin = Number.parseFloat(settings.presetTpMin || "2")
    const tpMax = Number.parseFloat(settings.presetTpMax || "30")
    const tpStep = Number.parseFloat(settings.presetTpStep || "2")

    // Generate positions based on indication step
    for (let step = stepMin; step <= stepMax; step += 1) {
      for (let tpFactor = tpMin; tpFactor <= tpMax; tpFactor += tpStep) {
        positions.push({
          id: this.generateId(),
          connection_id: this.connectionId,
          preset_id: this.presetId,
          symbol,
          type: "base",
          indication_category: "main",
          indication_type: indicationType,
          indication_step: step,
          direction,
          strength,
          entry_price: entryPrice,
          takeprofit_factor: tpFactor,
          stoploss_ratio: step * 0.1, // SL based on step
          position_cost: positionCost,
          created_at: new Date().toISOString(),
        })
      }
    }

    return positions
  }

  /**
   * Save positions to the database
   */
  private async savePositions(positions: any[]): Promise<void> {
    if (positions.length === 0) return

    const isSqlite = getDatabaseType() === "sqlite"
    const queryText = isSqlite
      ? `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        indication_category, indication_type, indication_step,
        direction, strength, entry_price, takeprofit_factor, stoploss_ratio,
        position_cost, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `
      : `
      INSERT INTO preset_pseudo_positions (
        id, connection_id, preset_id, symbol, type,
        indication_category, indication_type, indication_step,
        direction, strength, entry_price, takeprofit_factor, stoploss_ratio,
        position_cost, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT DO NOTHING
    `

    const batches = this.createBatches(positions, 50)

    for (const batch of batches) {
      for (const p of batch) {
        await execute(queryText, [
          p.id,
          p.connection_id,
          p.preset_id,
          p.symbol,
          p.type,
          p.indication_category,
          p.indication_type,
          p.indication_step,
          p.direction,
          p.strength,
          p.entry_price,
          p.takeprofit_factor,
          p.stoploss_ratio,
          p.position_cost,
          p.created_at,
        ])
      }
    }
  }

  private async processRealPositions(config: PresetTradeEngineConfig): Promise<void> {
    console.log("[v0] Processing real positions")

    const placeholder = getDatabaseType() === "sqlite" ? "?" : "$1"
    const placeholder2 = getDatabaseType() === "sqlite" ? "?" : "$2"

    const realPositions = await query<any>(
      `
      SELECT * FROM preset_pseudo_positions
      WHERE connection_id = ${placeholder}
        AND preset_id = ${placeholder2}
        AND type = 'real'
        AND status = 'active'
      LIMIT 50
    `,
      [this.connectionId, this.presetId],
    )

    if (realPositions.length === 0) return

    const exchangePositions = await this.fetchExchangePositions()

    // Match and update
    const updates: any[] = []

    for (const realPos of realPositions) {
      const exchangePos = exchangePositions.find((ep: any) => ep.symbol === realPos.symbol)

      if (exchangePos) {
        updates.push({
          id: realPos.id,
          currentPrice: exchangePos.markPrice,
          profitLoss: exchangePos.unrealizedProfit,
        })
      }
    }

    if (updates.length > 0) {
      await this.batchUpdateRealPositions(updates)
    }
  }
}
