// Force rebuild: 2026-05-05T23:00:00 — Clone semantics + Active+Pos / Progressing Sets metrics:
//   The architectural correction the operator requested: Main and Real do
//   NOT open new exchange positions, but they DO clone the parent stage's
//   positions and strategically adjust them into new relative variant Sets.
//   Two new explicit metrics now flow end-to-end through the system.
//
//   1. lib/strategy-coordinator.ts — emit per-stage detail hash now writes:
//      • sets_with_open_positions — count of Sets actually holding positions
//        (Base: own pseudo-positions; Main/Real: cloned & adjusted; Live:
//        executed exchange orders).
//      • sets_progressing — count of Sets in active calculation this cycle
//        (Base/Main/Real: created_sets; Live: realSets evaluated input).
//
//   2. lib/detailed-tracking.ts — StrategyStageTracking now exposes both
//      `setsWithOpenPositions` and `setsProgressing` for every stage.
//      The reader fans out an extra hgetall on `strategy_detail:{c}:live`
//      so Live participates symmetrically.
//
//   3. components/dashboard/strategy-pipeline.tsx — every stage card now
//      surfaces a 2-tile row: green-accent "Active Sets w/ Open/Cloned
//      Positions" and primary-accent "Progressing Sets". Subtitle copy
//      replaces "REUSE Base's positions" with "CLONE Base's positions and
//      strategically adjust them into new relative Sets" for both Main
//      and Real, matching the documented architecture.
//      Variant boxes Block/DCA now read "Clones Base positions" not "Reuses".
//
//   4. components/dashboard/statistics-overview-v2.tsx — Strategies ·
//      Active Progressing table headers renamed: "Sets" → "Progress" and
//      "Pos" → "Active+Pos" with extended title tooltips that spell out
//      the limit-gating policy (Base only) and the clone semantics
//      (Main/Real).
// ──────────────────────────────────────────────────────────────────────────
// Force rebuild: 2026-05-05T22:30:00 — Reset-DB now stops all progressions first:
//   1. New: lib/db-reset-helper.ts
//      • stopAllProgressionsBeforeReset() — single shared helper
//      • Stops global trade-engine coordinator (every per-connection EngineManager)
//      • Stops globalIntervalManager (prehistoric / indication interval timers)
//      • Clears stale __engine_timers Set leaked across HMR / hot-reload
//      • Marks trade_engine:global as { status: "stopped", reason: "db_reset" }
//        so racing crons short-circuit instead of writing to a wiped DB
//      • Each step wrapped in try/catch — a crashed coordinator never
//        permanently blocks the operator from resetting state
//   2. Wired into ALL three reset endpoints:
//      • app/api/install/database/flush/route.ts — Step 1.5 before FLUSHALL
//      • app/api/install/database/reset/route.ts — before flushAll()
//      • app/api/admin/reset-and-init/route.ts   — before flushAll()
//      All three return the stop result so the operator can see whether
//      the coordinator / interval manager / timers were successfully stopped.
// ──────────────────────────────────────────────────────────────────────────
// Force rebuild: 2026-05-05T22:00:00 — Position limit ownership + minimal volume:
//   1. lib/volume-calculator.ts: Volume MINIMIZATION
//      • UNIVERSAL_MIN_NOTIONAL_USD lowered $15 → $5 (spec floor across all major venues)
//      • Default exchangePositionCost lowered 1.0% → 0.1% per position (true minimal sizing)
//      • Default positionsAverage lowered 150 → 2 (matches Strategy-Base 1L+1S cap)
//      Result: live orders use the smallest practical size unless operator overrides.
//   2. components/dashboard/strategy-pipeline.tsx: Limit-ownership clarity
//      • Base now displays a red "LIMIT-GATED" badge — caps apply HERE only
//      • Main now displays a green "FREE CALCULATION" badge — no limits
//      • Real now displays a green "FREE CALCULATION" badge — no limits
//      • Subtitle copy updated on all three stages to spell out the policy
//   3. Architecture confirmation (no code change required):
//      • PseudoPositionManager.canCreatePosition cap enforcement only fires from
//        createBaseSets (Base entry-point) and createLiveSets (real exchange).
//      • createMainSets and evaluateRealSets only mutate Set arrays + Redis
//        counters. They do NOT call posManager.createPosition, so they cannot
//        be gated by maxActiveBasePseudoPositionsPerDirection. Verified by
//        scanning lib/strategy-coordinator.ts.
// ──────────────────────────────────────────────────────────────────────────
// Force rebuild: 2026-05-05T21:30:00 — Architecture: Real-stage accumulation correctness:
//   1. New: lib/detailed-tracking.ts
//      • Authoritative read API for indications + strategy stages
//      • Reads from progression:{id}, strategy_detail:{id}:{stage},
//        strategy_variant_{stage}:{id}:{variant}, strategy_axis_real:{id}:{axis}
//      • Encodes canonical pipeline:
//          Base (independent) → Main (variants/Base) → Real (accumulation) → Live
//   2. New: app/api/connections/progression/[id]/tracking/{indications,strategies}/route.ts
//   3. New: components/dashboard/indications-detail.tsx
//      • Active count (most important "asked value") + Last 5 / Last 60 min windows
//      • Per-type breakdown + pseudo-position limit + setsAtLimit capacity
//   4. New: components/dashboard/strategy-pipeline.tsx
//      • Cascade: Base → Main → Real → Live with set counts at each stage
//      • Base: independent sets, own pseudo-positions
//      • Main: variant sets per Base (Default/Trailing/Block/DCA/Pause) — REUSE Base positions
//      • Real: ACCUMULATION — position-count axis (prev/last/cont/pause) + variants
//      • Live: top 500 ranked by avgPF
//   5. strategy-coordinator.ts: Real-stage axis accumulation
//      • Added strategy_axis_real:{id}:{axis} hincrby per axis window
//      • Tracks prev (1-12), last (1-4), cont (1-8), pause (1-8) cumulative across cycles
//      • Per spec: "Position Counts Accumulation in Real instead of Main"
//   6. progression-logs-dialog.tsx: Added Indications + Strategies tabs (5 tabs total)
//   Symbol parallel processing: confirmed via SYMBOL_CONCURRENCY=16 in engine-manager
//   ────────────────────────────────────────────────────────────────────────────
// Force rebuild: 2026-05-05T21:00:00 — Continuing comprehensive system fixes (93 errors remaining):
//   1. Fixed getMarketData call signatures (auto-optimal, generate-safe-indications, etc)
//      • Changed from { isTestnet: boolean } to "1m" (string interval parameter)
//   2. Fixed market-data Redis client reference
//      • Added explicit `const client = getRedisClient()` before set/expire calls
//   3. Fixed indications/route.ts saveIndication call
//      • Separated indication object creation from saveIndication call (expected 1 arg, not 2)
//   4. Fixed logistics page loadAll callback signature
//      • Changed from `silent = false` to `silent: boolean = false` for proper TypeScript typing
//   5. Added Progress import to structure/page.tsx
//      • Added missing Progress component from ui/progress
//   6. Fixed sync-live-positions, progression tracking, and stats consolidation from previous passes
//   Result: System now tracks indications properly, live position sync enabled, progression displays correctly
//   1. Fixed sync-live-positions Redis set API (app/api/cron/sync-live-positions)
//      • Changed from old Redis format (EX, 55, NX) to Upstash-compatible set + expire pattern
//   2. Fixed progression state manager null type (lib/progression-state-manager.ts)
//      • Added explicit null type and proper null coalescing for Redis hgetall results
//   3. Added missing redis-db exports (lib/redis-db.ts)
//      • Added createTrade, updateTrade, updatePosition functions and Connection interface for missing imports
//   4. Fixed structure page Tabs import (app/structure/page.tsx)
//      • Added missing Tabs, TabsList, TabsTrigger, TabsContent imports from ui/tabs
//   5. Fixed settings page Settings interface (app/settings/page.tsx)
//      • Added cyclePauseMs field to Settings interface (optional, used by engine cycle controller)
//   6. Fixed market-data connector arguments (app/api/market-data/route.ts)
//      • Added apiPassphrase and apiType fields to ExchangeCredentials for proper exchange init
//   Result: Critical TypeScript errors fixed, live position sync ready, progression tracking enabled, stats consolidated

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["*"],
    },
    turbopackFileSystemCacheForDev: false,
  },
  // Next.js passes its own bundled `webpack` instance as the second
  // argument here. We DON'T `import "webpack"` at the top of this file
  // because `webpack` isn't a direct dependency of the project and
  // Node's ESM loader will throw `ERR_MODULE_NOT_FOUND` (observed in
  // dev logs at 2026-04-28T10:08:20).
  webpack: (config, { isServer, nextRuntime, webpack }) => {
    config.resolve = config.resolve || {}
    config.plugins = config.plugins || []

    // ── Strip the `node:` URI scheme from every dynamic/static import ──
    //
    // Webpack 5's default scheme handler does NOT recognise `node:`, so a
    // call like `await import("node:fs/promises")` raises
    // `UnhandledSchemeError` during the BUILD pass — even when the call
    // is gated by a runtime guard like
    // `if (typeof process === "undefined" || !process.versions?.node)`.
    // The error originates BEFORE alias resolution, so simply aliasing
    // `node:fs/promises → false` is not sufficient (we tried — see the
    // `nodeBuiltinsToStub` block below).
    //
    // `NormalModuleReplacementPlugin` runs in the resolve pipeline
    // BEFORE the scheme handler. Rewriting `node:fs/promises → fs/promises`
    // here means:
    //   • Server (nodejs runtime): bare specifier resolves natively.
    //   • Edge runtime: bare specifier resolves to `false` via the alias
    //     map below.
    //   • Browser: bare specifier resolves to `false` via the fallback
    //     map below.
    // This single plugin invocation is the safe, runtime-agnostic fix.
    //
    // Persistent dependency graphs from Webpack's filesystem cache
    // (`.next/cache`) are also healed because the replacement runs on
    // every build, not just on cold compiles — stale cache entries
    // referencing `node:` URIs get rewritten on the next module touch.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "")
      }),
    )

    // Browser bundle: Node built-ins are unavailable. Alias them to empty
    // stubs so any transitively-imported server lib still type-checks and
    // compiles for the client (its code paths are guarded at runtime).
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false,
        stream: false,
        buffer: false,
      }
    }

    // Edge runtime bundle: Next.js compiles `instrumentation.ts` for BOTH
    // `nodejs` and `edge` runtimes. Even though the function body is
    // guarded with `if (process.env.NEXT_RUNTIME !== "nodejs") return`,
    // Webpack still walks the static + dynamic-import graph for the Edge
    // target — which transitively reaches `lib/exchange-connectors/*`,
    // `lib/preset-coordination-engine.ts`, `lib/exchanges.ts`, and
    // `lib/security-hardening.ts`, every one of which imports `crypto`.
    //
    // Webpack 5 does not handle `node:` URI schemes in the Edge target
    // and the bare `crypto` specifier resolves to nothing on Edge,
    // producing the `Module not found: Can't resolve 'crypto'` error
    // observed in the dev logs. The fix is to alias the offending Node
    // built-ins to `false` (an empty stub) for the Edge build only —
    // the runtime guard in `instrumentation.ts` ensures the stub is
    // never executed when a real request arrives.
    if (nextRuntime === "edge") {
      // Stub every Node built-in that any transitively-imported server lib
      // touches. This list mirrors the Node-only modules actually referenced
      // anywhere downstream of `instrumentation.ts`:
      //
      //   • crypto       — exchange connectors (HMAC signing)
      //   • fs / path    — `lib/redis-db.ts` snapshot persistence
      //                    (also `lib/env-credentials.ts`)
      //   • stream       — body parsing helpers
      //   • buffer       — encoding helpers
      //   • events       — used by some legacy logging pieces
      //   • timers/promises — `setTimeout`/`setImmediate` await-friendly API
      //
      // Each is also listed under both the bare specifier (`fs`) and the
      // `node:` URI form (`node:fs`) because `lib/redis-db.ts` uses the URI
      // form via dynamic `await import("node:fs/promises")` etc. Webpack 5
      // does not handle `node:` URIs natively in the Edge target, hence
      // the explicit aliases.
      const nodeBuiltinsToStub = [
        "crypto",
        "fs",
        "fs/promises",
        "path",
        "stream",
        "buffer",
        "events",
        "timers",
        "timers/promises",
        "os",
        "url",
        "util",
        "zlib",
      ]
      const stubAliases = {}
      for (const name of nodeBuiltinsToStub) {
        stubAliases[name] = false
        stubAliases[`node:${name}`] = false
      }
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        ...stubAliases,
      }
    }

    return config
  },
}

export default nextConfig
