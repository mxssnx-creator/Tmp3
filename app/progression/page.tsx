"use client"

import { Suspense } from "react"

export default function ProgressionPage() {
  return (
    <Suspense fallback={<div className="p-8">Loading progression...</div>}>
      <ProgressionContent />
    </Suspense>
  )
}

function ProgressionContent() {
  return (
    <main className="flex flex-col gap-8 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold">Progression Tracking</h1>
        <p className="text-muted-foreground">
          Monitor strategy progression across all active connections
        </p>
      </div>

      <div className="grid gap-6">
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold mb-4">Progression Status</h2>
          <p className="text-sm text-muted-foreground">
            Select a connection to view progression metrics, track cycles, analyze trades, and verify strategy coordination.
          </p>
          <div className="mt-6 space-y-4">
            <div className="p-4 bg-muted rounded-md">
              <p className="text-sm font-medium">No Active Connection</p>
              <p className="text-xs text-muted-foreground mt-1">
                Connect to an exchange in the main dashboard to begin tracking progression.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm font-medium text-muted-foreground">Cycles</div>
            <div className="text-3xl font-bold mt-2">0</div>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm font-medium text-muted-foreground">Trades</div>
            <div className="text-3xl font-bold mt-2">0</div>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm font-medium text-muted-foreground">Positions</div>
            <div className="text-3xl font-bold mt-2">0</div>
          </div>
        </div>
      </div>
    </main>
  )
}
