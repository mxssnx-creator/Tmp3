const { existsSync, statSync, readdirSync } = require("fs")
const { join } = require("path")

const root = "/vercel/share/v0-project"

const keyFiles = [
  "lib/trade-engine.ts",
  "lib/trade-engine/engine-manager.ts",
  "lib/trade-engine/strategy-processor.ts",
  "lib/trade-engine/pseudo-position-manager.ts",
  "lib/trade-engine/indication-processor-fixed.ts",
  "lib/statistics-tracker.ts",
  "lib/indication-sets-processor.ts",
  "lib/strategy-coordinator.ts",
  "lib/exchange-context.tsx",
  "app/api/connections/progression/[id]/route.ts",
  "app/api/connections/progression/[id]/stats/route.ts",
  "app/api/connections/progression/[id]/logs/route.ts",
  "app/api/trading/engine-stats/route.ts",
  "app/api/trading/stats/route.ts",
  "app/api/main/system-stats-v3/route.ts",
  "app/api/settings/connections/route.ts",
  "components/dashboard/quickstart-section.tsx",
  "components/dashboard/quickstart-overview-dialog.tsx",
  "components/dashboard/quickstart-comprehensive-log-dialog.tsx",
  "components/dashboard/progression-logs-dialog.tsx",
  "components/dashboard/engine-processing-log-dialog.tsx",
  "components/dashboard/active-connection-card.tsx",
  "components/dashboard/system-overview.tsx",
  "components/dashboard/dashboard.tsx",
  "app/main/page.tsx",
]

console.log("=== FILE EXISTENCE CHECK ===")
for (const rel of keyFiles) {
  const full = join(root, rel)
  const exists = existsSync(full)
  const size = exists ? statSync(full).size : 0
  console.log(`${exists ? "OK  " : "MISS"} ${rel} ${exists ? `(${size} bytes)` : ""}`)
}

console.log("\n=== LIB/TRADE-ENGINE DIR ===")
const engineDir = join(root, "lib/trade-engine")
if (existsSync(engineDir)) {
  readdirSync(engineDir).forEach(f => {
    const p = join(engineDir, f)
    if (statSync(p).isFile()) console.log(`  ${f} (${statSync(p).size} bytes)`)
  })
} else {
  console.log("  DIR NOT FOUND")
}

console.log("\n=== LIB STRATEGY/STATS FILES ===")
const libDir = join(root, "lib")
readdirSync(libDir).filter(f => f.includes("strat") || f.includes("stat") || f.includes("indication") || f.includes("engine")).forEach(f => {
  const p = join(libDir, f)
  if (statSync(p).isFile()) console.log(`  ${f} (${statSync(p).size} bytes)`)
})

console.log("\n=== APP/API ROUTES ===")
function walkApi(dir, depth) {
  if (depth > 5) return
  if (!existsSync(dir)) return
  const entries = readdirSync(dir)
  for (const e of entries) {
    const full = join(dir, e)
    const s = statSync(full)
    if (s.isDirectory()) {
      walkApi(full, depth + 1)
    } else if (e === "route.ts" || e === "route.js") {
      console.log(`  ${full.replace(root + "/", "")} (${s.size} bytes)`)
    }
  }
}
walkApi(join(root, "app/api"), 0)
