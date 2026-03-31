import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    if (!client) {
      return NextResponse.json({ error: "Redis client not available" }, { status: 500 })
    }
    
    // Get all connection IDs from Redis
    const connIds = await client.smembers("connections")
    console.log(`[v0] [DebugRedis] Found ${connIds.length} connections in Redis`)
    
    const connections: any[] = []
    for (const id of connIds) {
      const data = await client.hgetall(`connection:${id}`)
      if (!data) continue
      const hasValidKey = data.api_key && data.api_key.length >= 16 && 
        !data.api_key.includes("PLACEHOLDER") && 
        !data.api_key.includes("00998877")
      
      connections.push({
        id: data.id,
        name: data.name,
        exchange: data.exchange,
        is_predefined: data.is_predefined,
        is_inserted: data.is_inserted,
        is_enabled_dashboard: data.is_enabled_dashboard,
        api_key_length: data.api_key?.length || 0,
        api_key_preview: data.api_key ? `${data.api_key.substring(0, 20)}...` : "EMPTY",
        has_valid_key: hasValidKey,
        api_secret_length: data.api_secret?.length || 0,
        all_fields: Object.keys(data),
      })
    }
    
    return NextResponse.json({
      connections_count: connIds.length,
      connections,
      summary: {
        total: connIds.length,
        with_valid_keys: connections.filter(c => c.has_valid_key).length,
        all_placeholder: connections.every(c => !c.has_valid_key),
      }
    })
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
