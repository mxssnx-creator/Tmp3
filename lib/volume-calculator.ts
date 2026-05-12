/**
 * Volume Calculator (TDZ fix: accountBalance declared before balanceCap block)
 * Calculates position volume based on base volume factor, leverage, and risk management
 * Calculates position volume ONLY at Exchange level when actual orders are executed
 * This calculator is ONLY used by ExchangePositionManager
 * Base/Main/Real pseudo positions do NOT use volume - they use counts and ratios
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, getAppSettings, setSettings, getRedisClient, getConnection } from "@/lib/redis-db"

interface VolumeCalculationParams {
  baseVolumeFactor?: number
  positionsAverage?: number
  riskPercentage?: number
  maxLeverage?: number
  positionCost?: number
  accountBalance: number
  currentPrice: number
  leverage?: number
  exchangeMinVolume?: number

  // ── LIVE-only engine factor (spec: pseudo positions are ratio-only) ──
  //
  // Which Trade Engine is asking for sizing? Determines which volume-
  // factor multiplier (if any) is applied to the LIVE notional.
  //
  // The Strategy stack (Base/Main/Real pseudo positions) is RATIO-based
  // and count-driven per spec — it MUST NOT receive any volume-factor
  // multiplier. Only Live Positions (real exchange orders) get the
  // engine-specific scalar applied. So Strategy callers leave
  // `tradeMode` undefined and the factor defaults to 1.0 (identity).
  //
  //   - `"main"`   → multiply by `mainVolumeFactor`   (a.k.a. live_volume_factor)
  //   - `"preset"` → multiply by `presetVolumeFactor` (a.k.a. preset_volume_factor)
  //   - omitted    → no engine multiplier (pseudo-position / Strategy path)
  tradeMode?: "main" | "preset"

  // Volume scaling factors applied at the LIVE-EXECUTION layer only.
  // Both default to 1.0 (no scaling) when missing or invalid. Bounded
  // to [0.1, 10] inside `calculatePositionVolume` so a misconfigured
  // setting can never blow out a live order to 100× the intended size.
  mainVolumeFactor?: number
  presetVolumeFactor?: number
}

interface VolumeCalculationResult {
  calculatedVolume?: number
  finalVolume?: number
  leverage: number
  positionSize?: number
  volume?: number
  volumeUsd?: number
  volumeAdjusted: boolean
  adjustmentReason?: string
  riskAmount?: number
}

export class VolumeCalculator {
  /**
   * Universal hard floor: the smallest USD notional we will ever attempt to
   * place on an exchange when no specific minimum is known.
   *
   * $5 covers the documented minimums of every major venue (Binance $5,
   * BingX $5, Bybit $1-$5, OKX $5, Bitget $5). Applied AFTER any per-pair
   * `exchangeMinVolume` (from `settings:trading_pair:{symbol}`) so a known
   * larger minimum (e.g. some altcoin pairs require $10+) still wins via
   * `effectiveMin = max(exchangeMinVolume, universalMin)`.
   *
   * Previously set to $1, which caused BingX 101400 rejections on
   * every altcoin pair whose minimum notional is ≥$2 (e.g. SAGA, SKYAI,
   * DRIFT). The 101400 auto-correction handler in live-stage now also
   * persists the exact per-pair minimum to `settings:trading_pair:{symbol}`
   * so this floor is only the safety net for the very first order attempt.
   */
  /**
   * Universal hard floor: $2 notional covers BingX/Binance/Bybit/OKX minimums
   * ($1-$5 range) while remaining realistic for small accounts with margin
   * constraints. Accounts with balances <$10k should configure a lower
   * positionCost instead of relying solely on this floor.
   */
  private static readonly UNIVERSAL_MIN_NOTIONAL_USD = 2

  /**
   * Fetch account balance and compute the leverage safety cap.
   *
   * Extracted into its own method so the balance-fetch + cap logic lives in
   * a single clean scope with no `let` mutation — eliminating the TDZ risk
   * that existed when this logic was inlined inside calculateVolumeForConnection.
   *
   * Returns { accountBalance, maxLeverage } — both always finite numbers.
   */
  static async resolveBalanceAndLeverage(
    connectionId: string,
    rawLeverage: number,
  ): Promise<{ accountBalance: number; maxLeverage: number }> {
    // Fetch balance — default $10,000 so the leverage cap is benign when
    // the exchange API is unreachable or the connection has no real key.
    let balance = 10000
    try {
      const cachedBalance = await getSettings(`connection_balance:${connectionId}`)
      if (cachedBalance?.balance) {
        balance = parseFloat(String(cachedBalance.balance))
      } else {
        const connection = await getConnection(connectionId)
        if (
          connection?.api_key &&
          connection?.api_secret &&
          !connection.api_key.includes("PLACEHOLDER") &&
          connection.api_key.length >= 20
        ) {
          const { createExchangeConnector } = await import("@/lib/exchange-connectors")
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey: connection.api_key,
            apiSecret: connection.api_secret,
            apiType: connection.api_type,
            contractType: connection.contract_type,
            isTestnet:
              connection.is_testnet === true || connection.is_testnet === "true",
          })
          const result = await connector.getBalance()
          if (result?.balance) {
            balance = result.balance
            await setSettings(`connection_balance:${connectionId}`, {
              balance,
              updated_at: new Date().toISOString(),
            })
          }
        }
      }
    } catch {
      // Non-critical — fall back to the $10k default so volume is calculated.
    }

    // Leverage safety cap: keep margin per position above exchange floor.
    //   ≤$50  → 10x  |  ≤$200 → 20x  |  ≤$500 → 50x  |  >$500 → 125x
    const cap = balance <= 50 ? 10 : balance <= 200 ? 20 : balance <= 500 ? 50 : 125
    return { accountBalance: balance, maxLeverage: Math.min(rawLeverage, cap) }
  }

  /**
   * Calculate position volume with risk management (pure math, no DB).
   *
   * BEHAVIOR: minimum volume is ALWAYS enforced — never reject for "qty
   * too small". Three layers:
   *   1. Per-pair `exchangeMinVolume` (from trading_pair metadata)
   *   2. Universal $5-notional floor when no per-pair min is known
   *   3. Numeric safety: if math yields 0/NaN/Infinity (e.g. balance=0
   *      or currentPrice rounding), still emit at least layer 1 or 2.
   *
   * The result is flagged `volumeAdjusted: true` with an
   * `adjustmentReason` explaining the clamp so UI + logs show the user
   * exactly why the quantity doesn't match the pure math.
   */
  static calculatePositionVolume(params: VolumeCalculationParams): VolumeCalculationResult {
    const {
      baseVolumeFactor,
      positionsAverage,
      riskPercentage,
      maxLeverage,
      positionCost,
      accountBalance,
      currentPrice,
      leverage = 1,
      exchangeMinVolume = 0,
      tradeMode,
      mainVolumeFactor,
      presetVolumeFactor,
    } = params

    // ── Resolve the engine-specific volume factor (Live-only) ──────
    //
    // Only applied when the CALLER explicitly identifies as a Live trade
    // engine via `tradeMode`. The Strategy stack (Base/Main/Real pseudo
    // positions) never sets `tradeMode`, so it always sees a 1.0
    // multiplier here — pseudo positions stay strictly ratio-based per
    // spec ("at Strategies, pseudo pos use ratios for volume calcs").
    //
    // Bounds: [0.1, 10]. A misconfigured 0 or negative collapses the
    // position to zero (the universal $5 floor would clamp back up but
    // we'd still log misleading numbers); a runaway 100× value would
    // silently blow live orders. Clipping here means the slider's UI
    // range (0.1-10x) is also enforced server-side even if a malformed
    // POST bypasses the UI.
    const clampFactor = (raw: number | undefined): number => {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return 1
      return Math.max(0.1, Math.min(10, n))
    }
    const liveEngineFactor =
      tradeMode === "preset" ? clampFactor(presetVolumeFactor)
      : tradeMode === "main" ? clampFactor(mainVolumeFactor)
      : 1  // Strategy / pseudo-position path → identity (ratio-only)

    // ── Resolve the effective minimum that MUST be honored ──────────
    // Take the larger of the per-pair minimum and the universal $5
    // notional floor. Guarantees we always have a positive lower bound
    // as long as `currentPrice > 0` (the upstream caller is responsible
    // for rejecting price=0 before we get here).
    const universalMinFromNotional =
      currentPrice > 0
        ? VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD / currentPrice
        : 0
    const effectiveMin = Math.max(exchangeMinVolume || 0, universalMinFromNotional)

    /**
     * Final clamp: never return less than `effectiveMin`, never NaN,
     * never Infinity. Used by both the positionCost and the
     * risk-percentage branches below.
     */
    const clampUp = (raw: number): { final: number; adjusted: boolean; reason?: string } => {
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (effectiveMin > 0 && safeRaw < effectiveMin) {
        const usingUniversalFallback = exchangeMinVolume <= 0
        return {
          final: effectiveMin,
          adjusted: true,
          reason:
            safeRaw <= 0
              ? `Sizing math yielded ${raw} — clamped up to enforced minimum ${effectiveMin.toFixed(8)} (${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"}).`
              : `Calculated volume ${safeRaw.toFixed(8)} was below ${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"} ${effectiveMin.toFixed(8)} — clamped up to minimum order size.`,
        }
      }
      return { final: safeRaw, adjusted: false }
    }

    if (positionCost) {
      // ── positions_average + engine factor wired into positionCost ─────
      //
      // Previous formula:
      //   pos_usd = (balance × positionCost) / posAvg
      //
      // New formula (with per-engine volume factor):
      //   pos_usd = (balance × positionCost × liveEngineFactor) / posAvg
      //
      // With positionCost expressed as a fraction of balance (the
      // calling site already converts `pct/100`), the denominator
      // divides total budgeted exposure across the expected concurrent
      // position count. The `liveEngineFactor` (1.0 by default; tunable
      // per Trade Engine — Main vs. Preset — through the Settings
      // dialog) lets operators independently scale the notional of
      // Main-engine orders vs. Preset-engine orders without touching
      // positionCost (which controls the per-position BUDGET share —
      // the two knobs compose).
      //
      // Strategy / pseudo-position calls leave `tradeMode` undefined,
      // so `liveEngineFactor === 1` and this branch behaves identically
      // for them. Only LIVE exchange-order callers see the multiplier
      // — which is exactly the spec: pseudo positions are ratio-only,
      // live positions calculate "indeed volume" (real notional) using
      // the per-engine ratio.
      const posAvg = positionsAverage && positionsAverage > 0 ? positionsAverage : 1
      const positionSizeUsd = (accountBalance * positionCost * liveEngineFactor) / posAvg
      const calculatedVolume = positionSizeUsd / currentPrice
      const { final, adjusted, reason } = clampUp(calculatedVolume)

      // Surface engine-factor provenance in the adjustment reason ONLY
      // when it actually changed sizing (≠ 1.0). A 1.0 factor is the
      // norm for Strategy callers and default Live config, and we don't
      // want to spam the volume-history log with no-op entries.
      const factorReason =
        liveEngineFactor !== 1 && tradeMode
          ? `${tradeMode}-engine volume factor ${liveEngineFactor.toFixed(2)}x applied`
          : undefined
      const composedReason = adjusted && reason
        ? (factorReason ? `${reason} | ${factorReason}` : reason)
        : factorReason

      return {
        calculatedVolume,
        finalVolume: final,
        volume: final,
        volumeUsd: final * currentPrice,
        leverage,
        volumeAdjusted: adjusted || liveEngineFactor !== 1,
        adjustmentReason: composedReason,
      }
    }

    if (!riskPercentage || !positionsAverage) {
      throw new Error("riskPercentage and positionsAverage are required when positionCost is not provided")
    }

    const calculatedLeverage = maxLeverage || leverage
    const totalRiskAmount = accountBalance * (riskPercentage / 100)
    const riskPerPosition = totalRiskAmount / positionsAverage
    const adjustedRisk = riskPerPosition * (baseVolumeFactor || 1)
    const positionSize = adjustedRisk / (riskPercentage / 100)
    const rawVolume = positionSize / (currentPrice * calculatedLeverage)

    const { final, adjusted, reason } = clampUp(rawVolume)

    return {
      calculatedVolume: rawVolume,
      finalVolume: final,
      volume: final,
      volumeUsd: final * currentPrice,
      leverage: calculatedLeverage,
      positionSize,
      volumeAdjusted: adjusted,
      adjustmentReason: reason,
      riskAmount: adjustedRisk,
    }
  }

  /**
   * Resolve the LIVE engine + scaling factor for a given connection.
   *
   * Used by `calculateVolumeForConnection` when the caller passes
   * `tradeMode` explicitly OR leaves it for auto-resolve from the
   * connection's `is_preset_trade` / `is_live_trade` flags. Two-tier
   * factor stack:
   *
   *   per-connection override (saved by VolumeConfigurationPanel)
   *   > global setting (Settings → Overall → Volume Configuration)
   *   > 1.0 (identity, no scaling)
   *
   * Trade-mode resolution from connection flags:
   *   - `is_preset_trade === true` AND `is_live_trade !== true` → "preset"
   *   - else                                                    → "main"
   *
   * Both flags true is unusual but possible during transitions; we
   * pick "main" because it's the conservative default — Preset's
   * factor often applies more aggressive multipliers and we don't
   * want an in-flight toggle to silently up-size existing live orders.
   *
   * Strategy callers (pseudo-position-manager) DO NOT call this helper
   * — they pass NO `tradeMode` to `calculateVolumeForConnection`, so
   * the engine factor never applies to pseudo positions per spec.
   */
  static resolveLiveEngine(
    connection: Record<string, unknown> | null | undefined,
    appSettings: Record<string, unknown> | null | undefined,
  ): { tradeMode: "main" | "preset"; mainVolumeFactor: number; presetVolumeFactor: number } {
    const truthy = (v: unknown) =>
      v === true || v === "true" || v === 1 || v === "1"
    const num = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : fallback
    }
    const conn = connection || {}
    const app = appSettings || {}

    const isPreset = truthy(conn["is_preset_trade"])
    const isLive   = truthy(conn["is_live_trade"])
    const tradeMode: "main" | "preset" = isPreset && !isLive ? "preset" : "main"

    // Per-connection override > global default > 1.0 identity.
    // Global setting key is `mainTradeVolumeFactor` (matches the slider
    // wired in `components/settings/tabs/overall-tab.tsx`).
    const mainVolumeFactor = num(
      conn["live_volume_factor"]
        ?? app["mainTradeVolumeFactor"]
        ?? app["main_trade_volume_factor"],
      1,
    )
    const presetVolumeFactor = num(
      conn["preset_volume_factor"]
        ?? app["presetTradeVolumeFactor"]
        ?? app["preset_trade_volume_factor"],
      1,
    )

    return { tradeMode, mainVolumeFactor, presetVolumeFactor }
  }

  /**
   * Calculate volume for a specific connection and symbol using Redis settings.
   *
   * ── `tradeMode` is an explicit, opt-in parameter ───────────────────
   * `calculateVolumeForConnection` is called from BOTH:
   *   - the pseudo-position manager (Strategy stack — ratio-only, MUST
   *     NOT see a volume multiplier per spec), and
   *   - the live-stage executor (real exchange orders — MUST see the
   *     multiplier).
   *
   * Auto-resolving the engine would silently apply the factor to
   * Strategy pseudo positions too, violating the spec. Instead the
   * caller decides:
   *   - Pseudo-position-manager (Strategy): omits `tradeMode` →
   *     `liveEngineFactor = 1` → ratio-only preserved.
   *   - Live-stage: passes `tradeMode: "main" | "preset"` explicitly
   *     (resolved via `resolveLiveEngine` at callsite).
   *
   * This is enforced by the type system: the only way to apply an
   * engine factor is to pass `tradeMode`, which the Strategy stack
   * never does.
   */
  static async calculateVolumeForConnection(
    connectionId: string,
    symbol: string,
    currentPrice: number,
    options: { tradeMode?: "main" | "preset" } = {},
  ): Promise<VolumeCalculationResult> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get settings from Redis via the mirror-aware reader. The volume
      // calculator needs `exchangePositionCost`/`positionCost`,
      // `leveragePercentage`, and `useMaximalLeverage` — all of which are
      // managed from the main Settings UI (canonical `app_settings`).
      // Previously this read `system_settings`, which is a different
      // bundle (cleanup schedule, backup toggles) — so the operator's
      // saved leverage/cost never reached volume calculations.
      const settings = (await getAppSettings()) || {}
      // Default position cost: 0.02% of balance per position (ultra-minimal).
      // With the new spec (Base capped at 1 long + 1 short), position budget
      // is intentionally kept at the absolute floor. On a $10K balance:
      //   0.02% → $2/position → clamped up to per-pair exchange minimum
      // The per-pair `exchangeMinVolume` from trading-pair metadata always
      // takes over as the hard floor in `calculatePositionVolume`, ensuring
      // the order is never rejected for being too small. Operators who want
      // larger sizing set `exchangePositionCost` explicitly in Settings.
      const positionCostPercent = parseFloat(
        String(settings.exchangePositionCost ?? settings.positionCost ?? "0.02")
      )
      const positionCost = positionCostPercent / 100

      // Default: 2 (matches the Base-stage cap of 1 long + 1 short).
      // The denominator divides budgeted exposure across the expected
      // number of concurrent positions. With Strategy Base limited to 2
      // (per the new spec — Main/Real calculate free and don't open
      // positions), 2 is the correct divisor for minimal per-position
      // sizing. Operator overrides via `positions_average` still apply.
      const positionsAverage = (() => {
        const raw = parseFloat(String(settings.positions_average ?? "2"))
        return Number.isFinite(raw) && raw > 0 ? raw : 2
      })()

      const leveragePercentage = parseFloat(String(settings.leveragePercentage ?? "100"))
      // `parseHash` coerces the stored "true"/"1" to boolean true, so a
      // strict `=== true` check is now safe (the old
      // `=== "true"` string compare would always miss).
      const useMaxLeverage = settings.useMaximalLeverage === true || settings.useMaximalLeverage === "true"
      const rawLeverage = useMaxLeverage ? 125 : Math.round(125 * (leveragePercentage / 100))

      // Delegate balance-fetch + leverage-cap to the helper method so the
      // logic lives in its own clean scope (no let mutation, no TDZ risk).
      const { accountBalance, maxLeverage } =
        await VolumeCalculator.resolveBalanceAndLeverage(connectionId, rawLeverage)

      // ── Exchange minimum order size from Redis trading-pair metadata ─
      const tradingPair = await getSettings(`trading_pair:${symbol}`)
      const exchangeMinVolume = tradingPair?.min_order_size
        ? parseFloat(tradingPair.min_order_size)
        : undefined

      // ── Resolve engine factor IFF caller asked for it ──────────────
      //
      // We only do the connection-flag resolution when the caller
      // passed `options.tradeMode`. The pseudo-position-manager call
      // omits it, so this entire block is skipped for Strategy callers
      // — they go through with no engine multiplier (the in-place
      // ratio-only behaviour the spec requires).
      //
      // Live-stage callers can pass:
      //   - an explicit "main" / "preset" (forces that engine), OR
      //   - leave it unset entirely (treated as Strategy → identity).
      // To opt into AUTO-RESOLUTION from connection flags, the
      // live-stage caller passes `tradeMode: "auto"` — handled by the
      // type widening below.
      let resolvedMode: "main" | "preset" | undefined = options.tradeMode
      let mainVolumeFactor = 1
      let presetVolumeFactor = 1
      if (resolvedMode === "main" || resolvedMode === "preset") {
        // We need the connection record + app settings to resolve the
        // factor stack (per-connection override > global > 1.0).
        let connectionRecord: any = null
        try {
          connectionRecord = await getConnection(connectionId)
        } catch { /* defaults to 1.0 / 1.0 */ }

        const resolved = VolumeCalculator.resolveLiveEngine(connectionRecord, settings)
        mainVolumeFactor = resolved.mainVolumeFactor
        presetVolumeFactor = resolved.presetVolumeFactor
        // We honour the CALLER's explicit mode; `resolveLiveEngine`'s
        // tradeMode result is informational here (used only when the
        // caller did not specify).
      }

      const result = this.calculatePositionVolume({
        positionCost,
        positionsAverage,
        accountBalance,
        currentPrice,
        leverage: maxLeverage,
        exchangeMinVolume,
        tradeMode: resolvedMode,
        mainVolumeFactor,
        presetVolumeFactor,
      })

      return result
    } catch (error) {
      console.error("[v0] Failed to calculate volume for connection:", error)
      throw error
    }
  }

  /**
   * Log volume calculation to Redis
   */
  static async logVolumeCalculation(
    connectionId: string,
    symbol: string,
    calculation: VolumeCalculationResult,
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const logKey = `volume_calc:${connectionId}:${logId}`

      await client.set(logKey, JSON.stringify({
        connection_id: connectionId,
        symbol,
        leverage: calculation.leverage,
        calculated_volume: calculation.calculatedVolume,
        final_volume: calculation.finalVolume || calculation.volume,
        volume_usd: calculation.volumeUsd,
        volume_adjusted: calculation.volumeAdjusted,
        adjustment_reason: calculation.adjustmentReason || null,
        created_at: new Date().toISOString(),
      }))

      // Store in Redis list instead of sorted set (Upstash doesn't support zadd)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      let volumeCalcs: string[] = []
      
      const existing = await client.get(volumeCalcsKey)
      if (existing) {
        try { volumeCalcs = JSON.parse(existing) } catch { volumeCalcs = [] }
      }
      
      // Prepend new entry
      volumeCalcs.unshift(logId)
      
      // Trim to max 500 entries
      if (volumeCalcs.length > 500) {
        volumeCalcs = volumeCalcs.slice(0, 500)
      }
      
      await client.set(volumeCalcsKey, JSON.stringify(volumeCalcs))
    } catch (error) {
      console.error("[v0] Failed to log volume calculation:", error)
    }
  }

  /**
   * Get volume calculation history from Redis
   */
  static async getVolumeHistory(connectionId: string, _symbol?: string, limit = 100) {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get recent log IDs from list (prepended order, so slice from beginning)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      const existing = await client.get(volumeCalcsKey)
      
      let logIds: string[] = []
      if (existing) {
        try { logIds = JSON.parse(existing) } catch { logIds = [] }
      }
      
      if (!logIds || logIds.length === 0) return []

      // Take most recent entries (first in list)
      const recentIds = logIds.slice(0, Math.min(limit, logIds.length))
      
      const history = []
      for (const logId of recentIds) {
        const data = await client.get(`volume_calc:${connectionId}:${logId}`)
        if (data) {
          const parsed = typeof data === "string" ? JSON.parse(data) : data
          if (!_symbol || parsed.symbol === _symbol) {
            history.push(parsed)
          }
        }
      }

      return history.slice(0, limit)
    } catch (error) {
      console.error("[v0] Failed to get volume history:", error)
      return []
    }
  }

  /**
   * Calculate risk metrics for a position (pure math, no DB)
   */
  static calculateRiskMetrics(params: {
    entryPrice: number
    currentPrice: number
    volume: number
    leverage: number
    side: "long" | "short"
    stopLossPrice?: number
    takeProfitPrice?: number
  }) {
    const { entryPrice, currentPrice, volume, leverage, side, stopLossPrice, takeProfitPrice } = params

    const positionValue = volume * currentPrice

    let unrealizedPnL = 0
    if (side === "long") {
      unrealizedPnL = (currentPrice - entryPrice) * volume * leverage
    } else {
      unrealizedPnL = (entryPrice - currentPrice) * volume * leverage
    }

    const unrealizedPnLPercent = (unrealizedPnL / (entryPrice * volume)) * 100

    let potentialLoss = 0
    if (stopLossPrice) {
      if (side === "long") {
        potentialLoss = (stopLossPrice - entryPrice) * volume * leverage
      } else {
        potentialLoss = (entryPrice - stopLossPrice) * volume * leverage
      }
    }

    let potentialProfit = 0
    if (takeProfitPrice) {
      if (side === "long") {
        potentialProfit = (takeProfitPrice - entryPrice) * volume * leverage
      } else {
        potentialProfit = (entryPrice - takeProfitPrice) * volume * leverage
      }
    }

    let riskRewardRatio = 0
    if (potentialLoss !== 0) {
      riskRewardRatio = Math.abs(potentialProfit / potentialLoss)
    }

    return {
      positionValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      potentialLoss,
      potentialProfit,
      riskRewardRatio,
    }
  }
}
