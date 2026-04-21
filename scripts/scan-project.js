const fs = require('fs')
const path = require('path')

// The actual project is at /code based on the find-root output showing /: lib=true
const roots = ['/code', '/home/user/code', '/workspace/code']
for (const r of roots) {
  try {
    const items = fs.readdirSync(r)
    console.log(`=== ${r} ===`)
    console.log(items.join('\n'))
    break
  } catch { /* skip */ }
}

// Also read the key files we care about
const keyFiles = [
  '/code/lib/statistics-tracker.ts',
  '/code/lib/strategy-coordinator.ts',
  '/code/lib/trade-engine/pseudo-position-manager.ts',
  '/code/app/api/connections/progression/[id]/stats/route.ts',
  '/code/app/api/connections/progression/[id]/route.ts',
  '/code/app/api/trading/engine-stats/route.ts',
  '/code/components/dashboard/quickstart-section.tsx',
  '/code/components/dashboard/active-connection-card.tsx',
  '/code/components/dashboard/system-overview.tsx',
  '/code/lib/exchange-context.tsx',
]

console.log('\n=== KEY FILE SIZES ===')
for (const f of keyFiles) {
  try {
    const stat = fs.statSync(f)
    console.log(`${f}: ${stat.size} bytes`)
  } catch (e) {
    console.log(`${f}: MISSING (${e.message})`)
  }
}
