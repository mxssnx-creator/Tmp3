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
  const LOAD_COOLDOWN = 60000 // 60 seconds between refreshes

  const loadActiveConnections = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true
    if (loadingRef.current) return
    if (!force && Date.now() - lastLoadRef.current < LOAD_COOLDOWN) return

    loadingRef.current = true
    setIsLoading(true)
    try {
      console.log("[v0] [Exchange Context] Loading Main Connections...")
      const response = await fetch("/api/settings/connections", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      })
      if (response.ok) {
        const data = await response.json()
        const connections = data.connections || []
        
        const mainConnections = connections.filter((c: any) => {
          return c.is_active_inserted === "1" || c.is_active_inserted === true || c.is_dashboard_inserted === "1" || c.is_dashboard_inserted === true
        })
        
        setActiveConnections(mainConnections)
        console.log("[v0] [Exchange Context] Loaded", mainConnections.length, "Main Connections")
        
        if (mainConnections.length > 0 && !selectedConnectionId) {
          setSelectedConnectionId(mainConnections[0].id)
          setSelectedExchange(mainConnections[0].exchange || null)
        }
      }
    } catch (error) {
      console.error("[v0] [Exchange Context] Failed to load connections:", error)
    } finally {
      loadingRef.current = false
      setIsLoading(false)
      lastLoadRef.current = Date.now()
    }
  }, [selectedConnectionId])

  // Only load on mount, remove interval to prevent loops
  useEffect(() => {
    loadActiveConnections()
  }, []) // Empty dependency array - load once on mount only

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
