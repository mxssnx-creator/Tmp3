import { NextResponse } from "next/server"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { buildLogisticsQueuePayload } from "@/lib/logistics-workflow"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const snapshot = await getDashboardWorkflowSnapshot()

    return NextResponse.json(buildLogisticsQueuePayload(snapshot))
  } catch (error) {
    console.error("[v0] [Logistics] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch logistics data",
        queueSize: 0,
        queueBacklog: 0,
        workflowHealth: "blocked",
        processingPressure: 0,
        processingRate: 0,
        successRate: 0,
        avgLatency: 0,
        completedOrders: 0,
        failedOrders: 0,
        maxLatency: 0,
        throughput: 0,
        workflow: [],
      },
      { status: 500 },
    )
  }
}
