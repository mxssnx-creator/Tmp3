#!/usr/bin/env node
/**
 * Quick-Start Engine Progression Test (3 symbols).
 *
 * Exercises POST /api/trade-engine/quick-start with 3 symbols and streams:
 *   • Historic / prehistoric load progress & duration
 *   • Per-type indication counts (direction / move / active / optimal / auto)
 *   • 4-stage strategy processing (base → main → real → live) with PF / DDT / pass-rate
 *   • Live pseudo positions & exchange positions
 *   • Cycle durations and any error events
 *
 * Runs against the local dev server on port 3002 (next dev). Uses Node 18+
 * built-in `fetch`.
 */

"use strict"

const API_BASE = process.env.API_BASE || "http://localhost:3002/api"
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const TEST_DURATION_MS = Number(process.env.TEST_DURATION_MS || 30000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2500)

// ---------------------------------------------------------------------------
// Pretty printers
// ---------------------------------------------------------------------------
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
}
function c(s, color) {
  return (ANSI[color] || "") + String(s) + ANSI.reset
}
function hr(ch, n) {
  ch = ch || "─"
  n = n || 78
  return c(ch.repeat(n), "gray")
}
function title(t) {
  console.log("\n" + hr("═"))
  console.log(c("  " + t, "bold"))
  console.log(hr("═"))
}
function row(label, value, color) {
  const padded = String(label).padEnd(34, " ")
  console.log("  " + c(padded, "dim") + " " + c(value, color || "reset"))
}
function fmtMs(ms) {
  if (!Number.isFinite(Number(ms))) return "-"
  const n = Number(ms)
  if (n < 1000) return n.toFixed(0) + "ms"
  if (n < 60000) return (n / 1000).toFixed(2) + "s"
  return (n / 60000).toFixed(2) + "min"
}
function pct(part, whole) {
  if (!whole) return "0.00%"
  return ((part / whole) * 100).toFixed(2) + "%"
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function http(method, path, body) {
  const url = API_BASE + path
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, json, text }
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e) }
  }
}
const get = (p) => http("GET", p)
const post = (p, b) => http("POST", p, b)

async function waitFor(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitForServer(maxMs) {
  maxMs = maxMs || 12000
  const start = Date.now()
  process.stdout.write(c("  Waiting for dev server ", "dim"))
  while (Date.now() - start < maxMs) {
    // Probe the root — any HTTP answer is enough (Next returns HTML on /)
    const r = await http("GET", "/").catch(() => ({ ok: false, status: 0 }))
    if (r && (r.ok || (r.status >= 200 && r.status < 600))) {
      process.stdout.write(c(" ready (HTTP " + r.status + ")\n", "green"))
      return true
    }
    process.stdout.write(".")
    await waitFor(500)
  }
  process.stdout.write(c(" timeout\n", "red"))
  return false
}

// ---------------------------------------------------------------------------
// STEP 1 — QuickStart
// ---------------------------------------------------------------------------
async function runQuickStart() {
  title("STEP 1 · POST /api/trade-engine/quick-start")
  row("Symbols", SYMBOLS.join(", "), "cyan")
  row("Endpoint", API_BASE + "/trade-engine/quick-start", "dim")

  const started = Date.now()
  const res = await post("/trade-engine/quick-start", { action: "enable", symbols: SYMBOLS })
  const elapsed = Date.now() - started

  if (!res.ok || !res.json) {
    row("Status", "HTTP " + res.status + " — FAILED", "red")
    if (res.json && res.json.error) row("Error", res.json.error, "red")
    if (res.json && res.json.details) row("Details", String(res.json.details).slice(0, 200), "red")
    if (res.text && !res.json) row("Body", String(res.text).slice(0, 200), "red")
    if (res.error) row("Fetch error", res.error, "red")
    return null
  }

  const j = res.json
  const connection = j.connection || {}
  row("Status", "HTTP " + res.status + " — " + (j.success ? "OK" : "FAILED"), j.success ? "green" : "red")
  row("Duration", fmtMs(elapsed), "yellow")
  row("Connection", (connection.name || "?") + " (" + (connection.id || "?") + ")", "cyan")
  row("Exchange", connection.exchange || "?", "cyan")
  row("Test passed", String(Boolean(connection.testPassed)), connection.testPassed ? "green" : "yellow")
  row("Active symbols", Array.isArray(connection.symbols) ? connection.symbols.join(", ") : "-", "cyan")
  if (connection.testError) row("Test error", connection.testError, "yellow")

  const os = j.overallStats || {}
  console.log(c("\n  Initial engine counts from QuickStart response:", "bold"))
  row("Prehistoric loaded symbols", String((os.symbols && os.symbols.prehistoricLoaded) || 0), "magenta")
  row("Prehistoric data keys", String((os.symbols && os.symbols.prehistoricDataSize) || 0), "magenta")
  row("Indications total", String((os.indicationsByType && os.indicationsByType.total) || 0), "cyan")
  row("Strategy base count", String((os.strategyCounts && os.strategyCounts.base) || 0), "cyan")
  row("Strategy main count", String((os.strategyCounts && os.strategyCounts.main) || 0), "cyan")
  row("Strategy real count", String((os.strategyCounts && os.strategyCounts.real) || 0), "cyan")
  row("Live positions", String(os.livePositions || 0), "cyan")
  row("Cycle duration (ms)", String(os.cycleTimeMs || 0), "yellow")

  return {
    connectionId: connection.id,
    connection,
    logs: Array.isArray(j.logs) ? j.logs : [],
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — streaming
// ---------------------------------------------------------------------------
function deriveSnapshot(stats) {
  if (!stats) return null
  const historic = stats.historic || {}
  const realtime = stats.realtime || {}
  const breakdown = stats.breakdown || {}
  const detail = stats.strategyDetail || {}
  const live = stats.liveExecution || {}
  const preMeta = stats.prehistoricMeta || {}
  const indByType = breakdown.indications || {}
  const strategies = breakdown.strategies || {}

  return {
    // Cycle telemetry
    cycleCompleted: historic.cyclesCompleted || 0,
    realtimeIndicationCycles: realtime.indicationCycles || 0,
    realtimeStrategyCycles: realtime.strategyCycles || 0,
    realtimeCycles: realtime.realtimeCycles || 0,
    successRate: realtime.successRate || 0,
    avgCycleTimeMs: realtime.avgCycleTimeMs || 0,
    isActive: realtime.isActive || false,
    churnIndication: (historic.processing && historic.processing.indicationChurnCycles) || 0,
    churnStrategy: (historic.processing && historic.processing.strategyChurnCycles) || 0,

    // Historic / prehistoric load
    prehistoricLoaded: Boolean(historic.isComplete || preMeta.isComplete),
    prehistoricProgressPct: historic.progressPercent || 0,
    prehistoricSymbolsProcessed: historic.symbolsProcessed || 0,
    prehistoricSymbolsTotal: historic.symbolsTotal || 0,
    prehistoricCandlesLoaded: historic.candlesLoaded || 0,
    prehistoricIndicatorsCalculated: historic.indicatorsCalculated || 0,
    prehistoricRangeDays: preMeta.rangeDays || 0,
    prehistoricTimeframeSec: preMeta.timeframeSeconds || 0,
    prehistoricIntervalsProcessed: preMeta.intervalsProcessed || 0,
    prehistoricMissingLoaded: preMeta.missingIntervalsLoaded || 0,
    prehistoricCurrentSymbol: preMeta.currentSymbol || "",
    prehistoricRangeStart: preMeta.rangeStart || null,
    prehistoricRangeEnd: preMeta.rangeEnd || null,

    // Indication breakdown
    indTotal: indByType.total || 0,
    indDirection: indByType.direction || 0,
    indMove: indByType.move || 0,
    indActive: indByType.active || 0,
    indOptimal: indByType.optimal || 0,
    indAuto: indByType.auto || 0,

    // Strategy counters (from breakdown.strategies)
    stratBase: strategies.base || 0,
    stratMain: strategies.main || 0,
    stratReal: strategies.real || 0,
    stratLive: strategies.live || 0,
    stratBaseEvaluated: strategies.baseEvaluated || 0,
    stratMainEvaluated: strategies.mainEvaluated || 0,
    stratRealEvaluated: strategies.realEvaluated || 0,

    // Per-stage strategy detail (PF / DDT / pass-rate / eval%)
    base: detail.base || {},
    main: detail.main || {},
    real: detail.real || {},
    liveStage: detail.live || {},

    // Live exchange execution
    liveOrdersPlaced: live.ordersPlaced || 0,
    liveOrdersFilled: live.ordersFilled || 0,
    liveOrdersFailed: live.ordersFailed || 0,
    livePositionsCreated: live.positionsCreated || 0,
    livePositionsClosed: live.positionsClosed || 0,
    livePositionsOpen: live.positionsOpen || 0,
    liveWins: live.wins || 0,
    liveVolumeUsd: live.volumeUsdTotal || 0,
    liveFillRate: live.fillRate || 0,
    liveWinRate: live.winRate || 0,
  }
}

async function fetchStats(connectionId) {
  const res = await get("/connections/progression/" + connectionId + "/stats?t=" + Date.now())
  if (!res.ok) return null
  return res.json
}

async function fetchLogs(connectionId, limit) {
  limit = limit || 30
  const res = await get("/connections/progression/" + connectionId + "/logs?limit=" + limit + "&t=" + Date.now())
  if (!res.ok) return []
  if (res.json && Array.isArray(res.json.logs)) return res.json.logs
  if (Array.isArray(res.json)) return res.json
  return []
}

function printStageRow(label, s) {
  s = s || {}
  const created = Number(s.createdSets || 0)
  const evaluated = Number(s.evaluated || 0)
  const passed = Number(s.passed || 0)
  const pf = Number(s.avgProfitFactor || 0)
  const ddt = Number(s.avgDrawdownTime || 0)
  const proc = Number(s.avgProcessingTimeMs || 0)
  const passRatio = Number(s.passRatio || 0) // already a %
  const evalPct = Number(s.evalPct || 0)     // already a %
  const posPerSet = Number(s.avgPosPerSet || 0)
  const pad = (v, w) => String(v).padStart(w, " ")
  console.log(
    "  " + c(String(label).padEnd(6, " "), "bold") + " " +
    "sets=" + c(pad(created, 5), "cyan") + " " +
    "eval=" + c(pad(evaluated, 5), "cyan") + " " +
    "passed=" + c(pad(passed, 5), "green") + " " +
    "pass%=" + c(passRatio.toFixed(1).padStart(5, " ") + "%", passRatio > 0 ? "green" : "dim") + " " +
    "eval%=" + c(evalPct.toFixed(1).padStart(5, " ") + "%", evalPct > 0 ? "cyan" : "dim") + " " +
    "PF=" + c(pf.toFixed(2).padStart(5, " "), pf >= 1.2 ? "green" : (pf >= 1 ? "yellow" : "dim")) + " " +
    "DDT=" + c((ddt.toFixed(0) + "m").padStart(5, " "), "dim") + " " +
    "pos/set=" + c(posPerSet.toFixed(2).padStart(4, " "), "dim") + " " +
    "proc=" + c(proc.toFixed(0) + "ms", "dim")
  )
}

function printSnapshot(snap, elapsedMs) {
  if (!snap) return
  const stamp = new Date().toISOString().slice(11, 19)
  console.log(
    "\n  " + c("[" + stamp + "]", "dim") + " " + c("t+", "dim") + fmtMs(elapsedMs) + "   " +
    "active=" + c(String(snap.isActive), snap.isActive ? "green" : "yellow") + "   " +
    "cycles(hist)=" + c(snap.cycleCompleted, "bold") + "   " +
    "indCycles=" + c(snap.realtimeIndicationCycles, "cyan") + "   " +
    "stratCycles=" + c(snap.realtimeStrategyCycles, "cyan") + "   " +
    "rtCycles=" + c(snap.realtimeCycles, "cyan") + "   " +
    "avgCycle=" + c(fmtMs(snap.avgCycleTimeMs), "yellow") + "   " +
    "success=" + c(snap.successRate + "%", snap.successRate > 80 ? "green" : "yellow")
  )

  // Historic / prehistoric
  const preState = snap.prehistoricLoaded
    ? c("complete", "green")
    : c("loading " + snap.prehistoricProgressPct.toFixed(1) + "%", "yellow")
  console.log(
    "  Historic: " + preState + "   " +
    "symbols=" + c(snap.prehistoricSymbolsProcessed + "/" + snap.prehistoricSymbolsTotal, "magenta") + "   " +
    "candles=" + c(snap.prehistoricCandlesLoaded, "magenta") + "   " +
    "indicators=" + c(snap.prehistoricIndicatorsCalculated, "magenta") + "   " +
    "intervals=" + c(snap.prehistoricIntervalsProcessed, "magenta") + "   " +
    "tf=" + c(snap.prehistoricTimeframeSec + "s", "magenta") + "   " +
    "range=" + c(snap.prehistoricRangeDays + "d", "magenta")
  )
  if (snap.prehistoricCurrentSymbol) {
    console.log("  Historic current: " + c(snap.prehistoricCurrentSymbol, "cyan") +
      "   churn-ind=" + c(snap.churnIndication, "dim") +
      "   churn-strat=" + c(snap.churnStrategy, "dim"))
  }

  // Indications
  console.log(
    "  Indications: total=" + c(snap.indTotal, "bold") + "   " +
    "direction=" + c(snap.indDirection, "cyan") + "   " +
    "move=" + c(snap.indMove, "cyan") + "   " +
    "active=" + c(snap.indActive, "cyan") + "   " +
    "optimal=" + c(snap.indOptimal, "cyan") + "   " +
    "auto=" + c(snap.indAuto, "cyan")
  )

  // Strategy pipeline (per-stage detail)
  console.log("  " + c("Strategy pipeline (stage → sets/eval/pass/PF/DDT/pos-per-set/proc):", "bold"))
  printStageRow("BASE", snap.base)
  printStageRow("MAIN", snap.main)
  printStageRow("REAL", snap.real)
  printStageRow("LIVE", snap.liveStage)

  // Live execution
  console.log(
    "  Live Exec: orders placed=" + c(snap.liveOrdersPlaced, "cyan") +
    " filled=" + c(snap.liveOrdersFilled, "green") +
    " failed=" + c(snap.liveOrdersFailed, snap.liveOrdersFailed ? "red" : "dim") +
    " fill%=" + c(snap.liveFillRate + "%", "dim") +
    " pos open=" + c(snap.livePositionsOpen, "green") +
    " closed=" + c(snap.livePositionsClosed, "dim") +
    " wins=" + c(snap.liveWins, "green") +
    " win%=" + c(snap.liveWinRate + "%", "dim") +
    " vol=$" + c(snap.liveVolumeUsd.toFixed(0), "magenta")
  )
}

async function streamProgression(connectionId) {
  title("STEP 2 · Streaming progression for " + connectionId)
  console.log(c("  Polling every " + POLL_INTERVAL_MS + "ms for " + fmtMs(TEST_DURATION_MS), "dim"))

  const start = Date.now()
  const samples = []
  let lastSnap = null
  let prehistoricCompletedAt = null

  while (Date.now() - start < TEST_DURATION_MS) {
    const stats = await fetchStats(connectionId)
    const snap = deriveSnapshot(stats)
    if (snap) {
      if ((!lastSnap || !lastSnap.prehistoricLoaded) && snap.prehistoricLoaded && prehistoricCompletedAt === null) {
        prehistoricCompletedAt = Date.now() - start
        console.log(c("\n  >>> PREHISTORIC COMPLETE at t+" + fmtMs(prehistoricCompletedAt) + " <<<", "green"))
      }
      printSnapshot(snap, Date.now() - start)
      samples.push(Object.assign({ t: Date.now() - start }, snap))
      lastSnap = snap
    } else {
      console.log(c("  [" + new Date().toISOString().slice(11, 19) + "] stats unavailable — retrying", "yellow"))
    }
    await waitFor(POLL_INTERVAL_MS)
  }

  return { samples, last: lastSnap, prehistoricCompletedAt }
}

// ---------------------------------------------------------------------------
// STEP 3 — progression logs
// ---------------------------------------------------------------------------
function fmtLogLine(l) {
  l = l || {}
  const ts = String(l.timestamp || l.time || "").slice(11, 19)
  const phase = String(l.phase || l.event || "?").padEnd(28, " ")
  const levelRaw = String(l.level || "info").toLowerCase()
  const level = levelRaw.padEnd(7, " ")
  const levelC =
    levelRaw === "error" ? "red" :
    (levelRaw === "warning" || levelRaw === "warn") ? "yellow" :
    levelRaw === "success" ? "green" : "dim"
  const msg = String(l.message || l.msg || "").slice(0, 120)
  return "  " + c(ts, "dim") + "  " + c(level, levelC) + "  " + c(phase, "cyan") + "  " + msg
}

async function showProgressionLogs(connectionId) {
  title("STEP 3 · Progression logs (latest 30)")
  const logs = await fetchLogs(connectionId, 30)
  if (!logs.length) {
    console.log(c("  (no logs returned)", "dim"))
    return
  }
  const sorted = logs.slice().sort((a, b) => (new Date(b.timestamp || 0)) - (new Date(a.timestamp || 0)))
  for (const l of sorted.slice(0, 30)) console.log(fmtLogLine(l))
}

// ---------------------------------------------------------------------------
// STEP 4 — summary
// ---------------------------------------------------------------------------
function summarize(result, quickstart) {
  title("STEP 4 · Final summary")
  const samples = (result && result.samples) || []
  const last = result && result.last
  if (!last) {
    console.log(c("  No snapshots collected — engine never produced progression stats.", "red"))
    return { ok: false }
  }
  const q = quickstart || {}
  row("Connection", ((q.connection && q.connection.name) || "?") + " (" + (q.connectionId || "?") + ")", "cyan")
  row("Symbols", (((q.connection && q.connection.symbols) || SYMBOLS) || []).join(", "), "cyan")
  row("Samples collected", String(samples.length), "yellow")
  row("Engine active", last.isActive ? "yes" : "no", last.isActive ? "green" : "red")
  row("Historic cycles completed", String(last.cycleCompleted), "bold")
  row("Realtime indication cycles", String(last.realtimeIndicationCycles), "cyan")
  row("Realtime strategy cycles", String(last.realtimeStrategyCycles), "cyan")
  row("Realtime cycles (merged)", String(last.realtimeCycles), "cyan")
  row("Avg cycle duration", fmtMs(last.avgCycleTimeMs), "yellow")
  row("Success rate", last.successRate + "%", last.successRate > 80 ? "green" : "yellow")
  row("Churn indication cycles", String(last.churnIndication), "dim")
  row("Churn strategy cycles", String(last.churnStrategy), "dim")

  console.log(c("\n  Historic / Prehistoric:", "bold"))
  row("Prehistoric complete", last.prehistoricLoaded ? "yes" : "no", last.prehistoricLoaded ? "green" : "red")
  if (result.prehistoricCompletedAt !== null && result.prehistoricCompletedAt !== undefined) {
    row("   · finished at", "t+" + fmtMs(result.prehistoricCompletedAt), "green")
  }
  row("   · progress percent", last.prehistoricProgressPct.toFixed(2) + "%", "magenta")
  row("   · symbols processed", last.prehistoricSymbolsProcessed + " / " + last.prehistoricSymbolsTotal, "magenta")
  row("   · candles loaded", String(last.prehistoricCandlesLoaded), "magenta")
  row("   · indicators calculated", String(last.prehistoricIndicatorsCalculated), "magenta")
  row("   · range days / timeframe", last.prehistoricRangeDays + "d / " + last.prehistoricTimeframeSec + "s", "magenta")
  row("   · intervals processed", String(last.prehistoricIntervalsProcessed), "magenta")
  row("   · missing intervals loaded", String(last.prehistoricMissingLoaded), "magenta")
  if (last.prehistoricRangeStart) row("   · range window", String(last.prehistoricRangeStart) + " → " + String(last.prehistoricRangeEnd), "dim")

  console.log(c("\n  Indications by type:", "bold"))
  const indTotal = last.indTotal
  row("Indications total", String(indTotal), "cyan")
  row("   · direction", last.indDirection + "  (" + pct(last.indDirection, indTotal) + ")", "cyan")
  row("   · move", last.indMove + "  (" + pct(last.indMove, indTotal) + ")", "cyan")
  row("   · active", last.indActive + "  (" + pct(last.indActive, indTotal) + ")", "cyan")
  row("   · optimal", last.indOptimal + "  (" + pct(last.indOptimal, indTotal) + ")", "cyan")
  row("   · auto", last.indAuto + "  (" + pct(last.indAuto, indTotal) + ")", "cyan")

  console.log(c("\n  Strategy pipeline (funnel):", "bold"))
  const baseC = Number((last.base && last.base.createdSets) || last.stratBase || 0)
  const mainC = Number((last.main && last.main.createdSets) || last.stratMain || 0)
  const realC = Number((last.real && last.real.createdSets) || last.stratReal || 0)
  const liveC = Number((last.liveStage && last.liveStage.createdSets) || last.stratLive || 0)
  row("BASE sets", baseC + "  eval=" + (last.base.evaluated || 0) + "  PF=" + (last.base.avgProfitFactor || 0) + "  DDT=" + (last.base.avgDrawdownTime || 0) + "m", "cyan")
  row("MAIN sets", mainC + "  eval=" + (last.main.evaluated || 0) + "  pass%=" + (last.main.passRatio || 0) + "  eval%=" + (last.main.evalPct || 0) + "  PF=" + (last.main.avgProfitFactor || 0), "cyan")
  row("REAL sets", realC + "  eval=" + (last.real.evaluated || 0) + "  pass%=" + (last.real.passRatio || 0) + "  eval%=" + (last.real.evalPct || 0) + "  PF=" + (last.real.avgProfitFactor || 0) + "  posEval=" + (last.real.avgPosEvalReal || 0), "cyan")
  row("LIVE positions", liveC + "  placed=" + (last.liveStage.evaluated || 0) + "  filled=" + (last.liveStage.passed || 0) + "  fill%=" + (last.liveStage.passRatio || 0) + "  win%=" + (last.liveStage.winRate || 0) + "  PF=" + (last.liveStage.avgProfitFactor || 0), "cyan")
  row("Funnel BASE→MAIN", pct(mainC, baseC), "dim")
  row("Funnel MAIN→REAL", pct(realC, mainC), "dim")
  row("Funnel REAL→LIVE", pct(liveC, realC), "dim")

  console.log(c("\n  Live exchange execution:", "bold"))
  row("Orders placed / filled / failed", last.liveOrdersPlaced + " / " + last.liveOrdersFilled + " / " + last.liveOrdersFailed, "cyan")
  row("Fill rate", last.liveFillRate + "%", "cyan")
  row("Positions open / closed", last.livePositionsOpen + " / " + last.livePositionsClosed, "green")
  row("Wins / Win rate", last.liveWins + " / " + last.liveWinRate + "%", "green")
  row("Volume USD total", "$" + last.liveVolumeUsd.toFixed(2), "magenta")

  const checks = [
    { name: "quick-start accepted", ok: Boolean(q.connectionId) },
    { name: "stats endpoint responding", ok: samples.length > 0 },
    { name: "engine marked active (realtime.isActive)", ok: Boolean(last.isActive) },
    { name: "historic cycles completed > 0", ok: last.cycleCompleted > 0 },
    { name: "prehistoric isComplete flag set", ok: last.prehistoricLoaded },
    { name: "prehistoric symbols processed > 0", ok: last.prehistoricSymbolsProcessed > 0 },
    { name: "prehistoric candles loaded > 0", ok: last.prehistoricCandlesLoaded > 0 },
    { name: "indications total > 0", ok: indTotal > 0 },
    { name: "at least one BASE strategy set", ok: baseC > 0 },
    { name: "indication cycles advancing", ok: last.realtimeIndicationCycles > 0 },
  ]
  console.log("")
  for (const chk of checks) {
    console.log("  " + (chk.ok ? c("✓", "green") : c("✗", "red")) + " " + chk.name)
  }
  const passCount = checks.filter((x) => x.ok).length
  console.log("")
  console.log(c("  RESULT: " + passCount + "/" + checks.length + " checks passed", passCount === checks.length ? "green" : "yellow"))
  return { ok: passCount === checks.length, checks, last }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  console.log(c("\n══════════════════════════════════════════════════════════════════════════════", "bold"))
  console.log(c("  ENGINE PROGRESSION TEST · QuickStart · 3 Symbols", "bold"))
  console.log(c("══════════════════════════════════════════════════════════════════════════════", "bold"))
  row("API base", API_BASE, "dim")
  row("Symbols", SYMBOLS.join(", "), "cyan")
  row("Test duration", fmtMs(TEST_DURATION_MS), "yellow")
  row("Poll interval", fmtMs(POLL_INTERVAL_MS), "yellow")

  const serverOk = await waitForServer()
  if (!serverOk) {
    console.error(c("\n  Dev server unreachable at " + API_BASE, "red"))
    process.exit(1)
  }

  const quickstart = await runQuickStart()
  if (!quickstart || !quickstart.connectionId) {
    console.error(c("\n  QuickStart did not return a connection id — aborting.", "red"))
    process.exit(2)
  }

  // Give the engine a short moment to start its first cycle.
  await waitFor(1500)

  const streamResult = await streamProgression(quickstart.connectionId)
  await showProgressionLogs(quickstart.connectionId)
  const summary = summarize(streamResult, quickstart)
  process.exit(summary.ok ? 0 : 1)
}

main().catch((err) => {
  console.error(c("\n  FATAL: " + ((err && err.message) || String(err)), "red"))
  process.exit(99)
})
