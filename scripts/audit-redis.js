// Audit Redis progression hash values for bingx-x01 and bybit-x03
const https = require("https")

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN

if (!url || !token) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env vars")
  process.exit(1)
}

async function redisCmd(...args) {
  const body = JSON.stringify(args)
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }
    const req = https.request(options, (res) => {
      let data = ""
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        try { resolve(JSON.parse(data).result) } catch { reject(new Error(data)) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  const connections = ["bingx-x01", "bybit-x03"]

  for (const connId of connections) {
    console.log(`\n========== ${connId} ==========`)

    // 1. Progression hash
    const prog = await redisCmd("HGETALL", `progression:${connId}`)
    console.log("progression hash fields:", prog ? prog.length / 2 : 0)
    if (prog && prog.length > 0) {
      // Convert flat array to object
      const obj = {}
      for (let i = 0; i < prog.length; i += 2) obj[prog[i]] = prog[i + 1]
      const relevant = ["indication_cycle_count","strategy_cycle_count","indications_count",
        "strategies_base_total","strategies_main_total","strategies_real_total","strategies_live_total",
        "strategies_base_evaluated","strategies_main_evaluated","strategies_real_evaluated",
        "indications_direction_count","indications_move_count","indications_active_count","indications_optimal_count",
        "indications_auto_count","symbols_processed"]
      for (const k of relevant) {
        if (obj[k] !== undefined) console.log(`  ${k} = ${obj[k]}`)
      }
    }

    // 2. Market data keys
    const mdKeys = await redisCmd("KEYS", `market_data:*`)
    console.log("market_data keys:", (mdKeys || []).filter(k => !k.includes(":1m") && !k.includes(":5m")).slice(0, 10))

    // 3. Strategy settings keys
    const stratKeys = await redisCmd("KEYS", `settings:strategies:${connId}:*`)
    console.log("strategy settings keys:", (stratKeys || []).slice(0, 8))

    // 4. Indications keys
    const indKeys = await redisCmd("KEYS", `indications:${connId}:*`)
    console.log("indication keys:", (indKeys || []).slice(0, 5))
  }
}

main().catch(console.error)
