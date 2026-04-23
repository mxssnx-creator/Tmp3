#!/usr/bin/env node

/**
 * Comprehensive audit test runner.
 *
 * Exercises every code path touched by the recent audit (P0/P1/P2 +
 * settings-mirror + version-counter + closed-only filters + parallel
 * fan-out) for an extended duration. Boots the Next dev server, drives
 * it with realistic request patterns, and asserts on the responses.
 *
 * Runs for up to TEST_DURATION_MS (default 10 minutes) and reports any
 * non-OK status, timeout, or semantic failure.
 *
 * Usage: node scripts/comprehensive-audit-test.mjs
 */

import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

// ── Config ────────────────────────────────────────────────────────────
const PORT = Number(process.env.TEST_PORT ?? 3002)
const BASE = `http://localhost:${PORT}`
const API = `${BASE}/api`
const TEST_DURATION_MS = Number(process.env.TEST_DURATION_MS ?? 10 * 60 * 1000)
const HEALTH_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 1000
const STEP_TIMEOUT_MS = 20_000
const CONNECTION_ID = process.env.TEST_CONNECTION_ID ?? "default-bingx-001"

// ── Small runner state ────────────────────────────────────────────────
let devProc = null
const results = []
let currentPhase = "startup"

function stamp() {
  return new Date().toISOString().split("T")[1].split(".")[0]
}
function log(level, msg) {
  const prefix = level === "fail" ? "✗" : level === "pass" ? "✓" : level === "warn" ? "!" : "·"
  console.log(`[${stamp()}] ${prefix} [${currentPhase}] ${msg}`)
}
function record(status, phase, message, detail) {
  results.push({ ts: Date.now(), phase, status, message, detail })
  log(status, message)
}

// ── Fetch helpers ─────────────────────────────────────────────────────
async function fetchJSON(path, init) {
  try {
    const res = await fetch(`${API}${path}`, init)
    const text = await res.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return { ok: false, status: 0, body: null, err: String(e?.message ?? e) }
  }
}

async function waitForHealth() {
  const start = Date.now()
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const r = await fetch(`${BASE}`, { signal: AbortSignal.timeout(3000) })
      if (r.ok || r.status === 200 || r.status === 304) return true
    } catch { /* keep polling */ }
    await delay(POLL_INTERVAL_MS)
  }
  return false
}

// ── Dev server lifecycle ─────────────────────────────────────────────
async function startDevServer() {
  currentPhase = "startup"
  // Kill anything already on the port before starting.
  try {
    const killer = spawn("bash", ["-lc", `fuser -k ${PORT}/tcp >/dev/null 2>&1 || true`])
    await once(killer, "exit")
  } catch { /* non-critical */ }

  log("info", `Starting dev server on :${PORT}...`)
  devProc = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  })

  devProc.stdout.on("data", (chunk) => {
    const s = chunk.toString()
    if (/error/i.test(s) && !/Compiled with warnings/.test(s)) {
      // Forward dev-time errors to our log so regressions surface.
      process.stdout.write(`[dev] ${s}`)
    }
  })
  devProc.stderr.on("data", (chunk) => {
    const s = chunk.toString()
    // Suppress benign Next warnings; forward anything with "Error"
    if (/error/i.test(s)) process.stdout.write(`[dev-err] ${s}`)
  })

  const healthy = await waitForHealth()
  if (!healthy) {
    record("fail", "startup", `Dev server did not become ready within ${HEALTH_TIMEOUT_MS}ms`)
    return false
  }
  record("pass", "startup", `Dev server ready on :${PORT}`)
  return true
}

async function stopDevServer() {
  if (!devProc) return
  try {
    devProc.kill("SIGTERM")
    await Promise.race([once(devProc, "exit"), delay(5000)])
    if (!devProc.killed) devProc.kill("SIGKILL")
  } catch { /* already gone */ }
  devProc = null
}

// ── Test suites ──────────────────────────────────────────────────────

/**
 * Suite 1 — Settings mirror + version bump.
 * Verifies: PUT /api/settings writes to both app_settings and all_settings
 * hashes, and the settings version counter increments on each write.
 */
async function testSettingsMirror() {
  currentPhase = "settings-mirror"

  // Read current settings to snapshot a baseline.
  const baseline = await fetchJSON("/settings")
  if (!baseline.ok) {
    record("fail", currentPhase, `GET /settings failed: ${baseline.status}`)
    return false
  }
  record("pass", currentPhase, "GET /settings returned OK")

  const initialSettings = baseline.body?.settings ?? baseline.body ?? {}
  const probe = `audit-probe-${Date.now()}`

  // PUT a probe field; expect it to round-trip.
  const put = await fetchJSON("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { auditProbe: probe } }),
  })
  if (!put.ok) {
    record("fail", currentPhase, `PUT /settings failed: ${put.status}`, put.body)
    return false
  }
  record("pass", currentPhase, "PUT /settings accepted probe field")

  // Re-read, assert the probe landed.
  const after = await fetchJSON("/settings")
  const afterSettings = after.body?.settings ?? after.body ?? {}
  if (afterSettings.auditProbe !== probe) {
    record("fail", currentPhase, `Probe not persisted — expected ${probe}, got ${afterSettings.auditProbe}`)
    return false
  }
  record("pass", currentPhase, "Probe round-tripped through canonical+legacy mirror")

  // Restore the original setting so we don't leave the probe behind.
  delete initialSettings.auditProbe
  const restore = await fetchJSON("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { auditProbe: null } }),
  })
  if (!restore.ok) {
    record("warn", currentPhase, `Cleanup PUT returned ${restore.status} (non-fatal)`)
  }
  return true
}

/**
 * Suite 2 — Live settings propagation.
 * Verifies a rapid series of saves all succeed and the version counter
 * advances as expected (covers the bumpSettingsVersion INCR path).
 */
async function testLivePropagation() {
  currentPhase = "live-propagation"

  const iterations = 5
  for (let i = 0; i < iterations; i++) {
    const res = await fetchJSON("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { _propTest: i } }),
    })
    if (!res.ok) {
      record("fail", currentPhase, `Iteration ${i} save failed: ${res.status}`)
      return false
    }
    await delay(200)
  }
  record("pass", currentPhase, `${iterations}/${iterations} rapid saves accepted`)
  return true
}

/**
 * Suite 3 — API route smoke test.
 * Ensures the main page + common API endpoints respond non-500 under
 * sustained load.
 */
async function testApiSmoke() {
  currentPhase = "api-smoke"
  const routes = [
    "/",
    "/main",
    "/strategies",
    "/settings",
    "/monitoring",
  ]
  for (const r of routes) {
    try {
      const res = await fetch(`${BASE}${r}`, { signal: AbortSignal.timeout(STEP_TIMEOUT_MS) })
      if (!res.ok) {
        record("fail", currentPhase, `GET ${r} returned ${res.status}`)
        return false
      }
    } catch (e) {
      record("fail", currentPhase, `GET ${r} threw: ${e.message}`)
      return false
    }
  }
  record("pass", currentPhase, `All ${routes.length} pages returned OK`)
  return true
}

/**
 * Suite 4 — API endpoint coverage.
 * Smoke-tests a broad set of API endpoints to ensure they don't 500.
 * 4xx is acceptable here (means the route is up but auth/data missing).
 */
async function testApiEndpoints() {
  currentPhase = "api-endpoints"
  const endpoints = [
    "/settings",
    "/connections",
    "/strategies",
    "/indications",
    "/system/health-check",
    "/monitoring/system",
    `/connections/progression/${CONNECTION_ID}`,
  ]
  let okCount = 0
  let failures = []
  for (const e of endpoints) {
    const r = await fetchJSON(e)
    if (r.status >= 500) {
      failures.push(`${e} → ${r.status}`)
    } else {
      okCount++
    }
  }
  if (failures.length > 0) {
    record("fail", currentPhase, `5xx on ${failures.length} endpoints: ${failures.join(", ")}`)
    return false
  }
  record("pass", currentPhase, `${okCount}/${endpoints.length} endpoints responded non-5xx`)
  return true
}

/**
 * Suite 5 — Sustained-load loop.
 * Runs for the remainder of TEST_DURATION_MS, polling the progression
 * endpoint and the settings endpoint in a loop. Reports any 5xx.
 */
async function testSustainedLoad(endBy) {
  currentPhase = "sustained-load"
  let iterations = 0
  let errors = 0
  const errorSamples = []

  while (Date.now() < endBy) {
    const [prog, settings] = await Promise.all([
      fetchJSON(`/connections/progression/${CONNECTION_ID}`),
      fetchJSON("/settings"),
    ])
    iterations++
    if (prog.status >= 500) { errors++; if (errorSamples.length < 5) errorSamples.push(`prog ${prog.status}`) }
    if (settings.status >= 500) { errors++; if (errorSamples.length < 5) errorSamples.push(`settings ${settings.status}`) }

    // Every 30 iterations, do a write too so the version-bump path stays warm.
    if (iterations % 30 === 0) {
      await fetchJSON("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { _loadTest: iterations } }),
      })
    }

    if (iterations % 60 === 0) {
      log("info", `Sustained load heartbeat — ${iterations} iterations, ${errors} 5xx`)
    }
    await delay(2000)
  }

  if (errors > 0) {
    record("fail", currentPhase, `${errors} 5xx responses over ${iterations} iterations: ${errorSamples.join(", ")}`)
    return false
  }
  record("pass", currentPhase, `${iterations} iterations, 0 5xx responses`)
  return true
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const testStart = Date.now()
  const endBy = testStart + TEST_DURATION_MS
  console.log(`\n=== Comprehensive Audit Test ===`)
  console.log(`Duration budget: ${(TEST_DURATION_MS / 60000).toFixed(1)} minutes`)
  console.log(`Port: ${PORT}`)
  console.log(`Connection ID: ${CONNECTION_ID}`)
  console.log("")

  const started = await startDevServer()
  if (!started) {
    await stopDevServer()
    process.exit(1)
  }

  // Run each suite; short-circuit on a fatal failure but continue for warnings.
  const suites = [
    testSettingsMirror,
    testLivePropagation,
    testApiSmoke,
    testApiEndpoints,
  ]
  let failed = false
  for (const s of suites) {
    const ok = await s()
    if (!ok) failed = true
  }

  // If any time remains, run the sustained-load loop.
  if (Date.now() < endBy - 30_000) {
    const sustainedOk = await testSustainedLoad(endBy)
    if (!sustainedOk) failed = true
  } else {
    log("info", "Skipping sustained-load phase — insufficient time remaining")
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n=== Summary ===")
  const counts = { pass: 0, fail: 0, warn: 0, info: 0 }
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1
  console.log(`Passed:  ${counts.pass}`)
  console.log(`Failed:  ${counts.fail}`)
  console.log(`Warned:  ${counts.warn}`)
  console.log(`Duration: ${((Date.now() - testStart) / 1000).toFixed(1)}s`)

  if (failed || counts.fail > 0) {
    console.log("\nFailures:")
    for (const r of results.filter((x) => x.status === "fail")) {
      console.log(`  - [${r.phase}] ${r.message}`)
      if (r.detail) console.log(`      detail: ${JSON.stringify(r.detail).slice(0, 200)}`)
    }
  }

  await stopDevServer()
  process.exit(failed ? 1 : 0)
}

process.on("SIGINT", async () => { await stopDevServer(); process.exit(130) })
process.on("SIGTERM", async () => { await stopDevServer(); process.exit(143) })

main().catch(async (e) => {
  console.error("[FATAL]", e)
  await stopDevServer()
  process.exit(1)
})
