"use client"

import React from "react"

interface PositionAnalyzerProps {
  totalPositions: number
  averagePerSymbol: number
  threshold?: number
  extremeAlert?: string | null
}

export function PositionAnalyzer({
  totalPositions,
  averagePerSymbol,
  threshold = 100,
  extremeAlert,
}: PositionAnalyzerProps) {
  const getHealthStatus = () => {
    if (totalPositions > threshold) return "danger"
    if (totalPositions > threshold * 0.75) return "warning"
    return "safe"
  }

  const getHealthColor = () => {
    const status = getHealthStatus()
    if (status === "danger") return "text-red-600"
    if (status === "warning") return "text-amber-600"
    return "text-green-600"
  }

  const getProgressWidth = () => {
    return Math.min((totalPositions / threshold) * 100, 100)
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-4">
        <h3 className="font-semibold">Position Analysis</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Monitor open positions and extreme detection
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Total Positions</span>
          <span className="text-2xl font-bold">{totalPositions}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm">Average per Symbol</span>
          <span className="font-mono">{averagePerSymbol.toFixed(2)}</span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span>Position Load</span>
            <span className={getHealthColor()}>{getHealthStatus().toUpperCase()}</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              className={`h-full transition-all ${
                getHealthStatus() === "danger"
                  ? "bg-red-600"
                  : getHealthStatus() === "warning"
                    ? "bg-amber-600"
                    : "bg-green-600"
              }`}
              style={{ width: `${getProgressWidth()}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>0</span>
            <span>Threshold: {threshold}</span>
          </div>
        </div>

        {extremeAlert && (
          <div className="p-2 bg-red-900/20 border border-red-600/50 rounded text-sm text-red-600">
            {extremeAlert}
          </div>
        )}

        {!extremeAlert && (
          <div className="p-2 bg-green-900/20 border border-green-600/50 rounded text-sm text-green-600">
            Positions within safe range
          </div>
        )}
      </div>
    </div>
  )
}
