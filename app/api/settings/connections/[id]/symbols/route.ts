import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get connection details
    const connections = await query<any>(`SELECT * FROM exchange_connections WHERE id = $1`, [id])

    if (!connections || connections.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const connection = connections[0]

    // Get cached symbols for this exchange
    const cachedSymbols = await query<any>(
      `SELECT symbol FROM exchange_symbols 
       WHERE exchange = $1 
       ORDER BY volume_24h DESC 
       LIMIT 100`,
      [connection.exchange],
    )

    if (cachedSymbols && cachedSymbols.length > 0) {
      return NextResponse.json({
        symbols: cachedSymbols.map((s: any) => s.symbol),
        source: "cache",
        exchange: connection.exchange,
        count: cachedSymbols.length,
      })
    }

    // Return default symbols if no cache
    const defaultSymbols = [
      "BTCUSDT",
      "ETHUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "ADAUSDT",
      "DOGEUSDT",
      "SOLUSDT",
      "DOTUSDT",
      "MATICUSDT",
      "LTCUSDT",
      "AVAXUSDT",
      "LINKUSDT",
      "ATOMUSDT",
      "UNIUSDT",
      "ETCUSDT",
      "XLMUSDT",
      "BCHUSDT",
      "FILUSDT",
      "TRXUSDT",
      "NEARUSDT",
      "ALGOUSDT",
      "VETUSDT",
      "ICPUSDT",
      "FTMUSDT",
      "SANDUSDT",
    ]

    return NextResponse.json({
      symbols: defaultSymbols,
      source: "default",
      exchange: connection.exchange,
      count: defaultSymbols.length,
    })
  } catch (error) {
    console.error("Error fetching exchange symbols:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch symbols",
        symbols: [],
      },
      { status: 500 },
    )
  }
}
