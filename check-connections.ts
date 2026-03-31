import { initRedis, getAllConnections, getAssignedAndEnabledConnections, getRedisClient } from "@/lib/redis-db"

async function checkConnections() {
  await initRedis()
  
  console.log("\n========== ALL CONNECTIONS ==========")
  const all = await getAllConnections()
  console.log(`Total connections: ${all.length}\n`)
  
  all.forEach((c: any) => {
    console.log(`[${c.exchange}] ${c.name || c.id}`)
    console.log(`  ID: ${c.id}`)
    console.log(`  Base: is_inserted=${c.is_inserted}, is_enabled=${c.is_enabled}`)
    console.log(`  Main: is_active_inserted=${c.is_active_inserted}, is_enabled_dashboard=${c.is_enabled_dashboard}`)
    console.log()
  })
  
  console.log("\n========== ASSIGNED & ENABLED ==========")
  const assigned = await getAssignedAndEnabledConnections()
  console.log(`Total assigned & enabled: ${assigned.length}\n`)
  
  assigned.forEach((c: any) => {
    console.log(`[${c.exchange}] ${c.name || c.id}`)
    console.log(`  Will be processed by engine`)
    console.log()
  })
  
  console.log("\n========== REDIS MIGRATION STATE ==========")
  const client = getRedisClient()
  const schemaVersion = await client.get("_schema_version")
  const migrationsRun = await client.get("_migrations_run")
  const migrationRuns = await client.get("_migration_total_runs")
  const lastRun = await client.get("_migration_last_run")
  
  console.log(`Schema version: ${schemaVersion}`)
  console.log(`Migrations run: ${migrationsRun}`)
  console.log(`Total runs: ${migrationRuns}`)
  console.log(`Last run: ${lastRun}`)
}

checkConnections().catch(console.error)
