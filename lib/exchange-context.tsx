"use client"

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react"

interface ExchangeContextType {
  selectedExchange: string | null
  setSelectedExchange: (exchange: string | null) => void
  selectedConnectionId: string | null
  setSelectedConnectionId: (connectionId: string | null) => void
  selectedConnection: any | null
  activeConnections: any[]
  loadActiveConnections: (options?: { force?: boolean }) => Promise<void>
  isLoading: boolean
}

const ExchangeContext = createContext<ExchangeContextType | undefined>(undefined)

export function ExchangeProvider({ children }: { children: ReactNode }) {
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [activeConnections, setActiveConnections] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const loadingRef = useRef(false)
  const lastLoadRef = useRef(0)
  // Use a ref to read selectedConnectionId inside the callback without stale closure
  const selectedConnectionIdRef = useRef<string | null>(null)
  const LOAD_COOLDOWN = 10000 // 10 seconds between refreshes

  const loadActiveConnections = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true
    if (loadingRef.current) return
    if (!force && Date.now() - lastLoadRef.current < LOAD_COOLDOWN) return

    loadingRef.current = true
    setIsLoading(true)
    try {
      const response = await fetch("/api/settings/connections", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      })
      if (response.ok) {
        const data = await response.json()
        const connections = data.connections || []
        
        const toBoolean = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"

        // STABLE ASSIGNMENT RULE: a connection appears in Main Connections ONLY when
        // the user has explicitly assigned it (is_active_inserted / is_dashboard_inserted /
        // is_assigned) or the dashboard toggle is currently on (is_enabled_dashboard).
        // We do NOT auto-include connections just because they are base (bybit/bingx);
        // that was the root cause of cards "re-appearing" after enable/delete.
        const mainConnections = connections.filter((c: any) => {
          const isInserted =
            toBoolean(c.is_active_inserted) ||
            toBoolean(c.is_dashboard_inserted) ||
            toBoolean(c.is_assigned)
          const isDashboardActive = toBoolean(c.is_enabled_dashboard)
          return isInserted || isDashboardActive
        })
        
        setActiveConnections(mainConnections)
        
        // Auto-select only when no connection is currently selected.
        // Read from ref to avoid stale closure (state is always null inside useCallback).
        if (mainConnections.length > 0 && !selectedConnectionIdRef.current) {
          // Prefer BingX, then fall back to first available connection
          const preferred =
            mainConnections.find((c: any) => (c.exchange || "").toLowerCase() === "bingx") ||
            mainConnections[0]
          setSelectedConnectionId(preferred.id)
          setSelectedExchange(preferred.exchange || null)
          selectedConnectionIdRef.current = preferred.id
        }
      }
    } catch (error) {
      console.error("[ExchangeContext] Failed to load connections:", error)
    } finally {
      loadingRef.current = false
      setIsLoading(false)
      lastLoadRef.current = Date.now()
    }
  }, [])

  // Load on mount; also refresh when connections are toggled or added/removed
  useEffect(() => {
    loadActiveConnections()

    const handleConnectionChange = () => {
      loadActiveConnections({ force: true })
    }

    if (typeof window !== "undefined") {
      window.addEventListener("connection-toggled", handleConnectionChange)
      window.addEventListener("connection-removed", handleConnectionChange)
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("connection-toggled", handleConnectionChange)
        window.removeEventListener("connection-removed", handleConnectionChange)
      }
    }
  }, [])

  const selectedConnection = activeConnections.find((connection: any) => connection.id === selectedConnectionId) || null

  return (
    <ExchangeContext.Provider
      value={{
        selectedExchange,
        setSelectedExchange: (exchange) => {
          setSelectedExchange(exchange)
          const matching = activeConnections.find((connection: any) => connection.exchange === exchange)
          setSelectedConnectionId(matching?.id || null)
        },
        selectedConnectionId,
        setSelectedConnectionId: (connectionId) => {
          setSelectedConnectionId(connectionId)
          selectedConnectionIdRef.current = connectionId
          const matching = activeConnections.find((connection: any) => connection.id === connectionId)
          setSelectedExchange(matching?.exchange || null)
        },
        selectedConnection,
        activeConnections,
        loadActiveConnections,
        isLoading,
      }}
    >
      {children}
    </ExchangeContext.Provider>
  )
}

export function useExchange() {
  const context = useContext(ExchangeContext)
  if (context === undefined) {
    throw new Error("useExchange must be used within an ExchangeProvider")
  }
  return context
}
