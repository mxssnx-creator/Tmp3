#!/usr/bin/env node
import { spawn } from "node:child_process"
import process from "node:process"

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:3001"
const STARTUP_TIMEOUT_MS = Number(process.env.TEST_STARTUP_TIMEOUT_MS || 120000)
const POLL_INTERVAL_MS = 1500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  })

  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }

  return { ok: response.ok, status: response.status, body }
}

function logStep(name, ok, detail = "") {
  const prefix = ok ? "✅" : "❌"
  const extra = detail ? ` - ${detail}` : ""
  console.log(`${prefix} ${name}${extra}`)
}

async function waitForServerReady() {
  const start = Date.now()
  let lastError = ""

  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const health = await requestJson("/api/health")
      if (health.ok) {
        return true
      }
      lastError = `HTTP ${health.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`Server not ready within ${STARTUP_TIMEOUT_MS}ms (${lastError})`)
}

async function run() {
  const devServer = spawn("npm", ["run", "dev"], {
    stdio: "inherit",
    env: { ...process.env, PORT: "3001" },
  })

  const shutdown = () => {
    if (!devServer.killed) {
      devServer.kill("SIGTERM")
    }
  }

  process.on("SIGINT", () => {
    shutdown()
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    shutdown()
    process.exit(143)
  })

  let failed = false

  try {
    await waitForServerReady()
    logStep("Server readiness", true, BASE_URL)

    const migrationStatus = await requestJson("/api/admin/migrations/status")
    logStep("Migration status endpoint", migrationStatus.ok, `status=${migrationStatus.status}`)
    if (!migrationStatus.ok) failed = true

    const runMigrations = await requestJson("/api/admin/run-migrations", { method: "POST", body: "{}" })
    logStep("Run migrations", runMigrations.ok, `status=${runMigrations.status}`)
    if (!runMigrations.ok) failed = true

    const ready = await requestJson("/api/trade-engine/quick-start/ready")
    logStep("QuickStart readiness", ready.ok, `status=${ready.status}`)
    if (!ready.ok) failed = true

    const quickstart = await requestJson("/api/trade-engine/quick-start", { method: "POST", body: "{}" })
    logStep("QuickStart initialize", quickstart.ok, `status=${quickstart.status}`)
    if (!quickstart.ok) failed = true

    const connectionId = quickstart.body?.connection?.id || quickstart.body?.connectionId
    if (connectionId) {
      const progression = await requestJson(`/api/connections/progression/${connectionId}/logs`)
      const hasLogs = progression.ok && Array.isArray(progression.body?.logs)
      logStep("Progression logs", hasLogs, `connectionId=${connectionId}`)
      if (!hasLogs) failed = true
    } else {
      logStep("Progression logs", false, "connection id missing from quickstart response")
      failed = true
    }

    const counts = await requestJson("/api/connections/counts")
    logStep("Connection counts", counts.ok, `status=${counts.status}`)
    if (!counts.ok) failed = true

  } finally {
    shutdown()
  }

  if (failed) {
    process.exit(1)
  }
}

run().catch((error) => {
  console.error("❌ System smoke test failed:", error)
  process.exit(1)
})
