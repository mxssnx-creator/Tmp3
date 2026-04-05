"use client"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Play, FileText, Settings, Zap, RefreshCw } from "lucide-react"

export function QuickstartSection() {
  const handleStartEngine = () => {
    console.log("[v0] [Quickstart] Starting trade engine...")
    window.dispatchEvent(new Event("engine-state-changed"))
  }

  const handleViewLogs = () => {
    console.log("[v0] [Quickstart] Opening logs dialog...")
    // Dispatch event that can be listened to by a logs dialog component
    window.dispatchEvent(new CustomEvent("open-logs-dialog"))
  }

  const handleOpenSettings = () => {
    console.log("[v0] [Quickstart] Opening settings...")
    window.dispatchEvent(new Event("open-settings"))
  }

  const handleRefreshStatus = () => {
    console.log("[v0] [Quickstart] Refreshing status...")
    window.dispatchEvent(new Event("engine-state-changed"))
  }

  return (
    <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
      <div className="p-4 space-y-3">
        {/* Title */}
        <div className="flex items-center gap-2 mb-2">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Quickstart</h3>
        </div>

        {/* Action Buttons - First Row */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleStartEngine}
            className="flex items-center gap-1"
          >
            <Play className="w-3.5 h-3.5" />
            Start Engine
          </Button>
          
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefreshStatus}
            className="flex items-center gap-1"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleOpenSettings}
            className="flex items-center gap-1"
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </Button>
        </div>

        {/* Log Buttons - New Line for Better Overview */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-border/30">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleViewLogs}
            className="flex items-center gap-1 text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            View Logs
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              console.log("[v0] [Quickstart] Opening progression logs...")
              window.dispatchEvent(new CustomEvent("open-progression-logs"))
            }}
            className="flex items-center gap-1 text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            Progression
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              console.log("[v0] [Quickstart] Opening indications logs...")
              window.dispatchEvent(new CustomEvent("open-indications-logs"))
            }}
            className="flex items-center gap-1 text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            Indications
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              console.log("[v0] [Quickstart] Opening strategies logs...")
              window.dispatchEvent(new CustomEvent("open-strategies-logs"))
            }}
            className="flex items-center gap-1 text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            Strategies
          </Button>
        </div>
      </div>
    </Card>
  )
}
