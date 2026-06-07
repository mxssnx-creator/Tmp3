import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { updateConnection, initRedis, getConnection, getRedisClient } from "@/lib/redis-db"
import { RedisTrades, RedisPositions } from "@/lib/redis-operations"
import { recoordinateAfterSettingsChange } from "@/lib/connection-recoordinator"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const trades = await RedisTrades.getTradesByConnection(id)
    const positions = await RedisPositions.getPositionsByConnection(id)

    const settings = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    return NextResponse.json({
      connection,
      settings,
      statistics: {
        active_trades: trades?.length || 0,
        active_positions: positions?.length || 0,
        created_at: connection.created_at,
        updated_at: connection.updated_at,
      },
    })
  } catch (error) {
    console.error("[v0] [Settings] GET error:", error)
    await SystemLogger.logError(error, "api", "GET /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to fetch settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const updated = {
      ...connection,
      name: body.name || connection.name,
      api_type: body.api_type || connection.api_type,
      connection_method: body.connection_method || connection.connection_method,
      connection_library: body.connection_library || connection.connection_library,
      margin_type: body.margin_type || connection.margin_type,
      position_mode: body.position_mode || connection.position_mode,
      is_testnet: body.is_testnet !== undefined ? body.is_testnet : connection.is_testnet,
      is_enabled: body.is_enabled !== undefined ? body.is_enabled : connection.is_enabled,
      is_active: body.is_active !== undefined ? body.is_active : connection.is_active,
      volume_factor: body.volume_factor || connection.volume_factor,
      connection_settings: body.settings || connection.connection_settings,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // Full propagation: notify + fast-path apply + recoordinate
    // (start/stop/hot-reload as the new state dictates). See
    // lib/connection-recoordinator.ts for the design rationale.
    await recoordinateAfterSettingsChange(id, connection, updated, {
      logTag: "PUT /settings",
    })

    await SystemLogger.logConnection(`Updated settings`, id, "info")

    return NextResponse.json({ success: true, connection: updated })
  } catch (error) {
    console.error("[v0] [Settings] PUT error:", error)
    await SystemLogger.logError(error, "api", "PUT /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const settings = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const current = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    const merged = { ...current, ...settings }

    // ── Promote dialog scalars to the canonical top-level connection
    //    columns the ENGINE actually reads ────────────────────────────
    // The Connection Settings dialog persists everything into the nested
    // `connection_settings` JSON, but several engine subsystems read from
    // dedicated top-level columns instead, so those controls were "dead"
    // (saved, never honored). Mirror them here so a dialog save instantly
    // and correctly drives the engine. Per-connection ALWAYS wins; we
    // only fall back to the existing column when the dialog didn't send a
    // value (partial PATCH).
    const num = (v: unknown): number | undefined => {
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const promoted: Record<string, unknown> = {}
    // Volume factors → volume-calculator reads conn.volume_factor /
    // conn.live_volume_factor / conn.preset_volume_factor.
    const vfBase   = num(settings.volume_factor)
    const vfLive   = num(settings.volume_factor_live)
    const vfPreset = num(settings.volume_factor_preset)
    if (vfBase   !== undefined) promoted.volume_factor        = vfBase
    if (vfLive   !== undefined) promoted.live_volume_factor   = vfLive
    if (vfPreset !== undefined) promoted.preset_volume_factor = vfPreset
    // Margin mode → exchange connector reads conn.margin_type.
    if (settings.margin_mode === "cross" || settings.margin_mode === "isolated") {
      promoted.margin_type = settings.margin_mode
    }
    // Volume type (usdt | contract | spot) → sizing path reads
    // conn.volume_type. Persist verbatim when the dialog sends it.
    if (typeof settings.volume_type === "string" && settings.volume_type) {
      promoted.volume_type = settings.volume_type
    }

    // ── Auto-resolve symbols on save ────────────────────────────────────
    // The "Order from Exchange" + "Symbol Count" controls had no engine
    // consumer. When the operator picks a ranked order (anything but
    // "manual"), resolve the top-N live symbols for that exchange now and
    // persist the RESOLVED list to the column the realtime cron reads
    // (`active_symbols`) and the engine symbol-state key. "manual" keeps
    // the explicit chip list authoritative.
    let resolvedSymbols: string[] | undefined
    const symbolOrder = typeof settings.symbol_order === "string" ? settings.symbol_order : undefined
    const symbolCount = Math.max(1, Math.min(50, num(settings.symbol_count) ?? 0)) || 0
    const manualSymbols = Array.isArray(settings.symbols)
      ? (settings.symbols as unknown[]).map(String).filter(Boolean)
      : undefined
    if (symbolOrder && symbolOrder !== "manual" && symbolCount > 0) {
      try {
        const exchangeKey = String((connection as any).exchange || "bingx").toLowerCase()
        const baseUrl =
          process.env.NEXTAUTH_URL ||
          process.env.NEXT_PUBLIC_APP_URL ||
          `http://localhost:${process.env.PORT || "3002"}`
        const res = await fetch(
          `${baseUrl}/api/exchange/${exchangeKey}/top-symbols?limit=${symbolCount}&t=${Date.now()}`,
          { signal: AbortSignal.timeout(5000), cache: "no-store" },
        )
        if (res.ok) {
          const data = await res.json()
          const list: string[] = Array.isArray(data?.symbolList)
            ? data.symbolList
            : Array.isArray(data?.symbols)
              ? data.symbols.map((s: any) => s.symbol || s).filter(Boolean)
              : []
          if (list.length > 0) resolvedSymbols = list.slice(0, symbolCount)
        }
      } catch (symErr) {
        console.warn("[v0] [Settings] symbol auto-resolve failed:", symErr instanceof Error ? symErr.message : symErr)
      }
    }
    if (!resolvedSymbols && manualSymbols && manualSymbols.length > 0) {
      resolvedSymbols = manualSymbols
    }
    if (resolvedSymbols && resolvedSymbols.length > 0) {
      promoted.active_symbols = resolvedSymbols
      // Keep the nested JSON consistent so the dialog reloads the
      // resolved list (not the stale ranked-order placeholder).
      ;(merged as Record<string, unknown>).symbols = resolvedSymbols
    }

    const updated = {
      ...connection,
      ...promoted,
      connection_settings: merged,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updated)

    // Push the resolved symbols into the engine's primary symbol-state key
    // and bust the in-engine symbol cache so the next realtime tick trades
    // the new set without waiting for the TTL.
    if (resolvedSymbols && resolvedSymbols.length > 0) {
      try {
        const { setSettings, getSettings } = await import("@/lib/redis-db")
        const stateKey = `trade_engine_state:${id}`
        const cur = (await getSettings(stateKey)) || {}
        await setSettings(stateKey, {
          ...(cur as Record<string, unknown>),
          symbols: JSON.stringify(resolvedSymbols),
          updated_at: new Date().toISOString(),
        })
      } catch (stateErr) {
        console.error("[v0] [Settings] symbol-state push failed:", stateErr)
      }
    }

    // ── Flat eval-knob hash mirror (CRITICAL) ───────────────────────────
    // The strategy coordinator and detailed-tracking read the per-eval
    // knobs straight off the `connection_settings:{id}` Redis HASH via
    // hgetall — NOT from the connection object's nested JSON. updateConnection
    // only persists the connection hash (`connection:{id}`), so without this
    // mirror the engine never sees operator changes and silently runs the
    // built-in defaults (prevPosMinCount=5, prevPosWindow=25, etc.). Mirror
    // every flat scalar the merged payload carries so the coordinator's
    // 30s-cached hgetall picks them up on the next refresh window. Values
    // are stringified because the emulator hash stores strings.
    try {
      const flatKnobs: Record<string, string> = {}
      const knobKeys = [
        "prevPosMinCount",
        "prevPosWindow",
        "mainEvalPosCount",
        "realEvalPosCount",
      ] as const
      for (const k of knobKeys) {
        const v = (merged as Record<string, unknown>)[k]
        if (typeof v === "number" && Number.isFinite(v)) flatKnobs[k] = String(v)
      }

      // ── Per-connection strategy-threshold override mirror ──────────────
      // The dialog's Strategies tab persists per-stage PF / DDT / max-pos
      // into `connection_settings.strategies.{main,preset}`. The engine
      // (StrategyCoordinator.loadAppPFThresholds) now prefers per-connection
      // values off the `connection_settings:{id}` HASH, so flatten the
      // per-stage knobs into discrete hash fields. We map the dialog's
      // base/main/real channels onto the engine's base/main/real/live
      // stages (live mirrors real unless a dedicated `live` channel is
      // present). PF stays as-is; DDT is stored in MINUTES by the dialog
      // and the engine gate also compares in minutes, so no conversion.
      const strat = (merged as Record<string, any>).strategies
      const stages: Array<["base" | "main" | "real" | "live", any]> = []
      if (strat && typeof strat === "object") {
        const ch = strat.main && typeof strat.main === "object" ? strat.main : strat
        if (ch.base) stages.push(["base", ch.base])
        if (ch.main) stages.push(["main", ch.main])
        if (ch.real) stages.push(["real", ch.real])
        if (ch.live) stages.push(["live", ch.live])
        else if (ch.real) stages.push(["live", ch.real]) // live mirrors real by default
      }
      const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
      for (const [stage, p] of stages) {
        if (!p || typeof p !== "object") continue
        const pf  = Number(p.min_profit_factor)
        const ddt = Number(p.max_drawdown_time)
        const mp  = Number(p.max_positions)
        if (Number.isFinite(pf)  && pf  >= 0) flatKnobs[`connMinProfitFactor${Cap(stage)}`] = String(pf)
        if (Number.isFinite(ddt) && ddt >  0) flatKnobs[`connMaxDrawdownTime${Cap(stage)}Min`] = String(ddt)
        if (Number.isFinite(mp)  && mp  >  0) flatKnobs[`connMaxPositions${Cap(stage)}`] = String(mp)
      }

      // ── Per-connection system-close-only flag mirror ───────────────────
      // The live-stage reconcile path reads a per-connection override off
      // this hash (preferred over the app-level default) so toggling one
      // connection's close-only behavior never bleeds onto the others.
      const closeOnly =
        (merged as Record<string, unknown>).use_system_close_only ??
        (merged as Record<string, unknown>).useSystemCloseOnly
      if (typeof closeOnly === "boolean") {
        flatKnobs.useSystemCloseOnly = closeOnly ? "true" : "false"
      }
      // Per-connection volume type so the sizing path can read it cheaply.
      if (typeof (merged as Record<string, unknown>).volume_type === "string") {
        flatKnobs.volumeType = String((merged as Record<string, unknown>).volume_type)
      }

      if (Object.keys(flatKnobs).length > 0) {
        await getRedisClient().hset(`connection_settings:${id}`, flatKnobs)
      }
    } catch (mirrorErr) {
      console.error("[v0] [Settings] eval-knob hash mirror failed:", mirrorErr)
    }

    // Full propagation. PATCH only ships a partial settings payload, so
    // `detectChangedFields` (which compares top-level connection fields)
    // would report zero changes — pass an explicit override listing the
    // settings keys the caller touched, so the recoordinator knows
    // something inside `connection_settings` actually changed.
    await recoordinateAfterSettingsChange(
      id,
      { ...connection, connection_settings: current },
      { ...connection, connection_settings: merged, updated_at: updated.updated_at },
      {
        logTag: "PATCH /settings",
        changedFieldsOverride: Object.keys(settings).length > 0 ? ["connection_settings"] : [],
      },
    )

    await SystemLogger.logConnection(`Patched settings`, id, "info")

    return NextResponse.json({ success: true, settings: merged })
  } catch (error) {
    console.error("[v0] [Settings] PATCH error:", error)
    await SystemLogger.logError(error, "api", "PATCH /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
