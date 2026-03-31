"use client"

import React, { useState, useEffect, useMemo, ReactNode } from "react"
import { useAuth } from "@/lib/auth-context"
import { useExchange } from "@/lib/exchange-context"
import { useConnectionState } from "@/lib/connection-state"
import { SystemOverview } from "./system-overview"
import { GlobalTradeEngineControls } from "./global-trade-engine-controls"
import { DashboardActiveConnectionsManager } from "./dashboard-active-connections-manager"
import { IntervalsStrategiesOverview } from "./intervals-strategies-overview"
import { StatisticsOverviewV2 } from "./statistics-overview-v2"
import { SystemMonitoringPanel } from "./system-monitoring-panel"
import { ProcessingProgressPanel } from "./processing-progress-panel"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, Activity, Pause, Square, AlertCircle } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { toast } from "sonner"
import type { ExchangeConnection } from "@/lib/types"

// Global Coordinator Status Component with optimized polling
function GlobalCoordinatorStatus() {
  const [status, setStatus] = useState<{ running: boolean; paused: boolean; status: string } | null>(null)

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const res = await fetch("/api/trade-engine/status", { 
          cache: "no-store",
          signal: AbortSignal.timeout(8000) 
        })
        if (res.ok) {
          const data = await res.json()
          setStatus({
            running: data.running === true || data.running === "true" || data.status === "running",
            paused: data.paused === true || data.paused === "true",
            status: data.status || "unknown",
          })
        }
      } catch (e) {
        console.warn("[v0] Failed to load coordinator status:", e)
        setStatus({ running: false, paused: false, status: "unavailable" })
      }
    }
    loadStatus()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const isLoading = status === null

  const getStatusDisplay = () => {
    if (!status || !status.running) {
      return { 
        label: "Stopped", 
        color: "bg-red-500/10 text-red-600 border-red-200", 
        icon: Square,
        desc: "Global coordinator is stopped. Start to begin trading."
      }
    }
    if (status.paused) {
      return { 
        label: "Paused", 
        color: "bg-yellow-500/10 text-yellow-600 border-yellow-200", 
        icon: Pause,
        desc: "All engines are paused. Resume to continue trading."
      }
    }
    return { 
      label: "Running", 
      color: "bg-green-500/10 text-green-600 border-green-200", 
      icon: Activity,
      desc: "Global coordinator is running. Engines will process based on main connection settings."
    }
  }

  const display = getStatusDisplay()
  const Icon = display.icon

  if (isLoading) {
    return (
      <Card className="border mb-4">
        <CardContent className="py-3">
          <p className="text-sm text-muted-foreground">Loading status...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={`border ${display.color} mb-4`}>
      <CardContent className="py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Icon className="h-5 w-5" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">Global Trade Coordinator:</span>
              <Badge variant="outline" className={display.color}>{display.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{display.desc}</p>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {!status.running && <span className="text-orange-500">Click Start to enable trading</span>}
          {status.running && !status.paused && <span className="text-green-600">Processing based on main connections</span>}
          {status.paused && <span className="text-yellow-600">Engines paused - click Resume to continue</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// Error Boundary Component
interface ErrorBoundaryProps {
  children: ReactNode
  name: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error(`[v0] [ErrorBoundary] Error in ${this.props.name}:`, error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="p-4 bg-red-50 border-red-200">
          <p className="text-sm text-red-700">
            Failed to load {this.props.name}. {this.state.error?.message}
          </p>
        </Card>
      )
    }

    return this.props.children
  }
}

export function Dashboard() {
  const { user } = useAuth()
  const { selectedExchange } = useExchange()
  const { 
    exchangeConnectionsActive, 
    loadExchangeConnectionsActive, 
    isExchangeConnectionsActiveLoading,
  } = useConnectionState()
  const [stats, setStats] = useState({
    activeConnections: 0,
    totalPositions: 0,
    dailyPnL: 0,
    totalBalance: 0,
    indicationsActive: 0,
    strategiesActive: 0,
    systemLoad: 0,
    databaseSize: 0,
  })
  
  // Track abort controller for cleanup
  const abortControllerRef = React.useRef<AbortController | null>(null)

  // Filter ExchangeConnectionsActive by selected exchange
  const filteredConnections = useMemo(() => {
    if (!selectedExchange) {
      return exchangeConnectionsActive
    }
    return exchangeConnectionsActive.filter(conn => conn.exchange === selectedExchange)
  }, [exchangeConnectionsActive, selectedExchange])

  const loadStats = React.useCallback(async () => {
    try {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      
      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal
      
      const url = selectedExchange 
        ? `/api/monitoring/stats?exchange=${selectedExchange}`
        : "/api/monitoring/stats"
      
      const [statsRes, sysMonRes] = await Promise.all([
        fetch(url, { signal: AbortSignal.timeout(8000) }),
        fetch("/api/system/monitoring", { signal: AbortSignal.timeout(8000) }),
      ])
      
      let data = { activeConnections: 0, totalPositions: 0, dailyPnL: 0, totalBalance: 0 }
      let sysData = { cpu: 0, database: { keys: 0 }, engines: { indications: { resultsCount: 0 }, strategies: { resultsCount: 0 } } }
      
      if (statsRes.ok) {
        data = await statsRes.json()
      }
      if (sysMonRes.ok) {
        sysData = await sysMonRes.json()
      }
      
      setStats({
        activeConnections: data.activeConnections || 0,
        totalPositions: data.totalPositions || 0,
        dailyPnL: data.dailyPnL || 0,
        totalBalance: data.totalBalance || 0,
        indicationsActive: sysData.engines?.indications?.resultsCount || 0,
        strategiesActive: sysData.engines?.strategies?.resultsCount || 0,
        systemLoad: sysData.cpu || 0,
        databaseSize: sysData.database?.keys || 0,
      })
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.warn("Failed to load stats:", error)
      }
    }
  }, [selectedExchange])

  useEffect(() => {
    console.log("[v0] [Dashboard] Mounted")
    // Don't await these - let them load in background
    // This ensures the dashboard renders immediately
    loadExchangeConnectionsActive().catch(err => {
      console.warn("[v0] [Dashboard] Failed to load connections:", err)
    })
    loadStats()
    
    // Increased polling interval to reduce API calls: 10s instead of 5s
    const interval = setInterval(() => {
      loadStats()
    }, 10000)
    
    return () => {
      clearInterval(interval)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [loadStats])

  // Reload stats when selected exchange changes
  useEffect(() => {
    console.log("[v0] [Dashboard] Exchange changed to:", selectedExchange)
    loadStats()
  }, [loadStats, selectedExchange])

  return (
    <div className="flex-1 space-y-6 px-0 pb-6">
      <PageHeader 
        title="CTS v3.2 Dashboard" 
        description="Monitor and control your Main Connections (Active Connections)"
        showExchangeSelector
      />

      {/* Global Coordinator Status - Shows at top of page */}
      <ErrorBoundary name="Global Coordinator Status">
        <GlobalCoordinatorStatus />
      </ErrorBoundary>

      {/* Smart Overview - Comprehensive system status */}
      <ErrorBoundary name="System Overview">
        <SystemOverview />
      </ErrorBoundary>

      {/* Trade Engine Controls */}
      <ErrorBoundary name="Global Trade Engine Controls">
        <GlobalTradeEngineControls />
      </ErrorBoundary>

      {/* Processing Progress Panel - Shows phase progress and metrics */}
      {selectedExchange && (
        <ErrorBoundary name="Processing Progress">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ProcessingProgressPanel connectionId={selectedExchange} />
          </div>
        </ErrorBoundary>
      )}

      {/* Main Connections (Active Connections) - With global engine guard, progression tracking, sticky state */}
      <ErrorBoundary name="Main Connections">
        <DashboardActiveConnectionsManager />
      </ErrorBoundary>

      {/* Intervals & Strategies Overview */}
      {filteredConnections.length > 0 && (
        <ErrorBoundary name="Intervals & Strategies">
          <IntervalsStrategiesOverview connections={filteredConnections} />
        </ErrorBoundary>
      )}

      {/* Statistics Overview V2 - Unified widget with all metrics */}
      {filteredConnections.length > 0 && (
        <div className="col-span-full">
          <ErrorBoundary name="Statistics Overview">
            <StatisticsOverviewV2 connections={filteredConnections} />
          </ErrorBoundary>
        </div>
      )}

      {/* System Monitoring Panel - CPU, Memory, Services, Database, Recent Activity */}
      <ErrorBoundary name="System Monitoring">
        <SystemMonitoringPanel />
      </ErrorBoundary>
    </div>
  )
}
