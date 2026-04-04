"use client"

import { DashboardShell } from "@/components/dashboard-shell"
import { Dashboard } from "@/components/dashboard/dashboard"
import { Suspense, type ReactNode } from "react"
import { Card } from "@/components/ui/card"
import React from "react"

function DashboardLoading() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <Card className="p-8 max-w-md text-center">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded"></div>
          <div className="h-4 bg-gray-200 rounded"></div>
          <div className="h-4 bg-gray-200 rounded w-5/6"></div>
        </div>
        <p className="text-sm text-gray-500 mt-4">Loading dashboard...</p>
      </Card>
    </div>
  )
}

interface PageErrorBoundaryProps {
  children: ReactNode
}

interface PageErrorBoundaryState {
  hasError: boolean
  error?: Error
}

class PageErrorBoundary extends React.Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  constructor(props: PageErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    console.error("[v0] [PageError] Error in Home page:", error)
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: any) {
    console.error("[v0] [PageError] Stack trace:", info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen bg-red-50">
          <Card className="p-8 max-w-md text-center border-red-200">
            <h1 className="text-lg font-bold text-red-900 mb-4">Dashboard Error</h1>
            <p className="text-sm text-red-700 mb-4">
              {this.state.error?.message || "Failed to load dashboard. Please refresh the page."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
            >
              Refresh Page
            </button>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}

export default function Home() {
  return (
    <PageErrorBoundary>
      <DashboardShell>
        <Suspense fallback={<DashboardLoading />}>
          <Dashboard />
        </Suspense>
      </DashboardShell>
    </PageErrorBoundary>
  )
}
