"use client"

import React from "react"

interface CoordinationMetrics {
  profitFactor: number
  drawdownTime: number
  isCoordinated: boolean
}

interface ProfitDrawdownAnalyzerProps {
  metrics: CoordinationMetrics
}

export function ProfitDrawdownAnalyzer({
  metrics,
}: ProfitDrawdownAnalyzerProps) {
  const getStatus = () => {
    if (metrics.isCoordinated) return "Coordinated"
    return "Diverging"
  }

  const getStatusColor = () => {
    if (metrics.isCoordinated) return "text-green-600"
    return "text-amber-600"
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-4">
        <h3 className="font-semibold">Profit/Drawdown Coordination</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Validates profit factor and drawdown time correlation
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-2 bg-muted rounded">
          <span className="text-sm">Profit Factor</span>
          <span className="font-mono font-semibold">{metrics.profitFactor.toFixed(2)}x</span>
        </div>

        <div className="flex items-center justify-between p-2 bg-muted rounded">
          <span className="text-sm">Drawdown Time</span>
          <span className="font-mono font-semibold">{metrics.drawdownTime.toFixed(1)} min</span>
        </div>

        <div className="flex items-center justify-between p-3 bg-muted rounded border border-current">
          <span className="text-sm font-medium">Status</span>
          <span className={`text-sm font-semibold ${getStatusColor()}`}>
            {getStatus()}
          </span>
        </div>

        <p className="text-xs text-muted-foreground mt-2">
          {metrics.isCoordinated
            ? "Profit factor and drawdown metrics are properly aligned"
            : "Metrics diverge - investigate strategy risk management"}
        </p>
      </div>
    </div>
  )
}
