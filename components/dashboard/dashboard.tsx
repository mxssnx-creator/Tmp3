"use client"

import React, { useEffect, useMemo, ReactNode } from "react"
import { useExchange } from "@/lib/exchange-context"
import { useConnectionState } from "@/lib/connection-state"
import { SystemOverview } from "./system-overview"
import { GlobalTradeEngineControls } from "./global-trade-engine-controls"
import { DashboardActiveConnectionsManager } from "./dashboard-active-connections-manager"
import { IntervalsStrategiesOverview } from "./intervals-strategies-overview"
import { StatisticsOverviewV2 } from "./statistics-overview-v2"
import { SystemMonitoringPanel } from "./system-monitoring-panel"
import { ProcessingProgressPanel } from "./processing-progress-panel"
import { Card } from "@/components/ui/card"
import { PageHeader } from "@/components/page-header"

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
  const { selectedExchange } = useExchange()
  const { 
    exchangeConnectionsActive, 
    loadExchangeConnectionsActive, 
  } = useConnectionState()

  // Filter connections by selected exchange
  const filteredConnections = useMemo(() => {
    if (!selectedExchange) {
      return exchangeConnectionsActive
    }
    return exchangeConnectionsActive.filter(conn => conn.exchange === selectedExchange)
  }, [exchangeConnectionsActive, selectedExchange])

  // Resolve the active connection ID for processing panel
  const activeConnectionId = useMemo(() => {
    if (selectedExchange) {
      const match = exchangeConnectionsActive.find(c => c.exchange === selectedExchange)
      return match?.id || null
    }
    return exchangeConnectionsActive[0]?.id || null
  }, [selectedExchange, exchangeConnectionsActive])

  useEffect(() => {
    loadExchangeConnectionsActive().catch(err => {
      console.warn("[v0] [Dashboard] Failed to load connections:", err)
    })
  }, [])

  return (
    <div className="flex-1 space-y-6 px-0 pb-6">
      <PageHeader 
        title="CTS v3.2 Dashboard" 
        description="Monitor and control your Main Connections (Active Connections)"
        showExchangeSelector
      />

      {/* Smart Overview - Comprehensive system status */}
      <ErrorBoundary name="System Overview">
        <SystemOverview />
      </ErrorBoundary>

      {/* Trade Engine Controls */}
      <ErrorBoundary name="Global Trade Engine Controls">
        <GlobalTradeEngineControls />
      </ErrorBoundary>

      {/* Processing Progress Panel - Shows phase progress and metrics */}
      {activeConnectionId && (
        <ErrorBoundary name="Processing Progress">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ProcessingProgressPanel connectionId={activeConnectionId} />
          </div>
        </ErrorBoundary>
      )}

      {/* Main Connections (Active Connections) - With global engine guard, progression tracking, sticky state */}
      <ErrorBoundary name="Main Connections">
        <DashboardActiveConnectionsManager />
      </ErrorBoundary>

      {/* Intervals & Strategies Overview */}
      <ErrorBoundary name="Intervals & Strategies">
        <IntervalsStrategiesOverview connections={filteredConnections} />
      </ErrorBoundary>

      {/* Statistics Overview V2 - Unified widget with all metrics */}
      <div className="col-span-full">
        <ErrorBoundary name="Statistics Overview">
          <StatisticsOverviewV2 connections={filteredConnections} />
        </ErrorBoundary>
      </div>

      {/* System Monitoring Panel - CPU, Memory, Services, Database, Recent Activity */}
      <ErrorBoundary name="System Monitoring">
        <SystemMonitoringPanel />
      </ErrorBoundary>
    </div>
  )
}
