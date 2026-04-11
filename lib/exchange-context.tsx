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
        
        const BASE_EXCHANGES = ["bybit", "bingx"]
        const toBoolean = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"
        
        const mainConnections = connections.filter((c: any) => {
          const exchange = (c.exchange || "").toLowerCase().trim()
          const isBase = BASE_EXCHANGES.includes(exchange)
          const isInserted = toBoolean(c.is_active_inserted) || toBoolean(c.is_dashboard_inserted)
          const isDashboardActive = toBoolean(c.is_enabled_dashboard)
          return isBase || isInserted || isDashboardActive
        })
        
        setActiveConnections(mainConnections)
        
        if (mainConnections.length > 0 && !selectedConnectionId) {
          const firstConnection = mainConnections[0]
          setSelectedConnectionId(firstConnection.id)
          setSelectedExchange(firstConnection.exchange || null)
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
