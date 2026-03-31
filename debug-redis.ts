import { initRedis, getRedisClient } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"

async function debug() {
  console.log("\n=== CHECKING REDIS STATE ===\n")
  
  await initRedis()
  const client = getRedisClient()
  
  // Check schema version
  const schemaVer = await client.get("_schema_version")
  console.log(`Schema version: ${schemaVer}`)
  
  // Run migrations if needed
  console.log("\nRunning migrations...")
  const result = await runMigrations()
  console.log(`Migrations result:`, result)
  
  // Check if connections set exists
  const connectionIds = await client.smembers("connections")
  console.log(`\nConnections set members: ${connectionIds.length} items`)
  connectionIds.forEach((id: string) => console.log(`  - ${id}`))
  
  // Get BingX connection
  if (connectionIds.includes("bingx-x01")) {
    const bingx = await client.hgetall("connection:bingx-x01")
    console.log(`\nBingX connection details:`)
    console.log(JSON.stringify(bingx, null, 2))
  }
  
  // Get Bybit connection  
  if (connectionIds.includes("bybit-x03")) {
    const bybit = await client.hgetall("connection:bybit-x03")
    console.log(`\nBybit connection details:`)
    console.log(JSON.stringify(bybit, null, 2))
  }
  
  process.exit(0)
}

debug().catch(e => {
  console.error("Error:", e)
  process.exit(1)
})
