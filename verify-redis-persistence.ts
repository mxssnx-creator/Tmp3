import { initRedis, getRedisClient } from "@/lib/redis-db"

async function verify() {
  await initRedis()
  const client = getRedisClient()
  
  console.log("Checking Redis persistence...")
  
  // Write a test value
  await client.set("test_persistence", "value1", { EX: 3600 })
  console.log("✓ Written test_persistence=value1")
  
  // Read it back immediately
  const val1 = await client.get("test_persistence")
  console.log(`✓ Read immediately: ${val1}`)
  
  // Wait a bit
  await new Promise(r => setTimeout(r, 500))
  
  // Read again
  const val2 = await client.get("test_persistence")
  console.log(`✓ Read after 500ms: ${val2}`)
  
  // Check migrations run flag
  const migRun = await client.get("_migrations_run")
  const schemaVer = await client.get("_schema_version")
  
  console.log(`\nCurrent state:`)
  console.log(`  _migrations_run: ${migRun}`)
  console.log(`  _schema_version: ${schemaVer}`)
  
  // List all connection IDs
  const conns = await client.smembers("connections")
  console.log(`  connections set: ${conns?.length || 0} items`)
  conns?.forEach((c: string) => console.log(`    - ${c}`))
}

verify().catch(console.error)
