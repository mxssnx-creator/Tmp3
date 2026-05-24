"use client"

import React from "react"

interface ProgressionStatsCardProps {
  label: string
  value: string | number
  subtext?: string
  trend?: "up" | "down" | "stable"
}

export function ProgressionStatsCard({
  label,
  value,
  subtext,
  trend,
}: ProgressionStatsCardProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        {trend && (
          <div
            className={`text-xs font-medium ${
              trend === "up"
                ? "text-green-600"
                : trend === "down"
                  ? "text-red-600"
                  : "text-blue-600"
            }`}
          >
            {trend === "up" ? "↑" : trend === "down" ? "↓" : "→"}
          </div>
        )}
      </div>
      <div className="text-3xl font-bold mt-2">{value}</div>
      {subtext && <p className="text-xs text-muted-foreground mt-1">{subtext}</p>}
    </div>
  )
}
