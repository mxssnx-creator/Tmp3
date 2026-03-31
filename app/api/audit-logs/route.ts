import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { auditLogger } from "@/lib/audit-logger"

export async function GET(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number.parseInt(searchParams.get("limit") || "100"), 1000)
    const startDate = searchParams.get("start_date") ? new Date(searchParams.get("start_date")!) : undefined
    const endDate = searchParams.get("end_date") ? new Date(searchParams.get("end_date")!) : undefined

    // Get audit logs for this user
    const logs = await auditLogger.exportLogs({
      user_id: String(user.id),
      start_date: startDate,
      end_date: endDate,
    })

    return NextResponse.json({
      success: true,
      logs: logs.slice(0, limit),
      total: logs.length,
    })
  } catch (error) {
    console.error("[v0] Failed to get audit logs:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
