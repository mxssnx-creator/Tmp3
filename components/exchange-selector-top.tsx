"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RefreshCw, Zap } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

interface Connection {
  id: string
  name: string
  exchange: string
  isReal: boolean
  status: "connected" | "disconnected" | "error"
  isDashboardEnabled?: boolean
  isLiveTradeEnabled?: boolean
}

const STANDARD_OPTION: Connection = {
  id: "standard",
  name: "Standard",
  exchange: "Mock",
  isReal: false,
  status: "connected",
  isDashboardEnabled: false,
  isLiveTradeEnabled: false,
}

export function ExchangeSelectorTop() {
  const { selectedConnectionId, setSelectedConnectionId, activeConnections, isLoading, loadActiveConnections } = useExchange()

  const currentConnection = activeConnections.find((c) => c.id === selectedConnectionId) || STANDARD_OPTION

  const handleSelectConnection = (id: string) => {
    setSelectedConnectionId(id)
  }

  const handleRefresh = async () => {
    await loadActiveConnections()
  }

  const defaultValue = selectedConnectionId || "standard"

  const renderStatusBadges = () => {
    if (!currentConnection.isReal) {
      return <Badge className="bg-muted text-muted-foreground text-xs">Mock Data</Badge>
    }
    
    return (
      <>
        {currentConnection.isDashboardEnabled && (
          <Badge className="bg-green-500/20 text-green-600 border border-green-500/30 text-xs">Active</Badge>
        )}
        {currentConnection.isLiveTradeEnabled && (
          <Badge className="bg-blue-500/20 text-blue-600 border border-blue-500/30 text-xs">Live</Badge>
        )}
        {!currentConnection.isDashboardEnabled && currentConnection.status === "connected" && (
          <Badge className="bg-amber-500/20 text-amber-600 border border-amber-500/30 text-xs">Enabled</Badge>
        )}
      </>
    )
  }

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="text-sm font-medium text-foreground shrink-0">Exchange:</span>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Select value={defaultValue} onValueChange={handleSelectConnection}>
          <SelectTrigger className="w-[180px] h-8 text-sm border-input bg-background hover:bg-muted">
            <div className="flex items-center gap-2">
              <Zap className="h-3 w-3 text-yellow-500" />
              <SelectValue placeholder="Select connection" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard" className="cursor-pointer">
              <div className="flex items-center gap-2">
                <Zap className="h-3 w-3 text-yellow-500" />
                <span>Standard</span>
                <span className="text-muted-foreground text-xs">(Mock)</span>
              </div>
            </SelectItem>
            
            {isLoading ? (
              <div className="px-2 py-2 text-center text-muted-foreground text-xs">Loading...</div>
            ) : activeConnections.length === 0 ? (
              <div className="px-2 py-2 text-center text-muted-foreground text-xs">No Main Connections</div>
            ) : (
              activeConnections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id} className="cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Zap className="h-3 w-3 text-yellow-500" />
                    <span>{conn.name || conn.exchange}</span>
                    <Badge variant="outline" className="text-[10px]">{conn.exchange}</Badge>
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {renderStatusBadges()}
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleRefresh} aria-label="Refresh connections">
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}