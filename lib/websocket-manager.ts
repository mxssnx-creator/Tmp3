/**
 * WebSocket Manager for Real-Time Updates
 * Handles connection management, event subscriptions, and message routing
 */

export type WebSocketEventType =
  | 'position-update'
  | 'strategy-update'
  | 'indication-update'
  | 'settings-update'
  | 'engine-status'
  | 'processing-progress'
  | 'error'

export interface WebSocketMessage {
  type: WebSocketEventType
  connectionId: string
  data: any
  timestamp: string
  sequence: number
}

export interface PositionUpdate {
  id: string
  symbol: string
  currentPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  status: 'open' | 'closing' | 'closed'
  updatedAt: string
}

export interface StrategyUpdate {
  id: string
  symbol: string
  profit_factor: number
  win_rate: number
  active_positions: number
  updatedAt: string
}

export interface IndicationUpdate {
  id: string
  symbol: string
  direction: 'UP' | 'DOWN' | 'NEUTRAL'
  confidence: number
  strength: number
  timestamp: string
}

export interface ProcessingProgress {
  connectionId: string
  phase: 'prehistoric' | 'realtime' | 'strategy' | 'indication'
  progress: number // 0-100
  itemsProcessed: number
  totalItems: number
  currentTimeframe: string
  estimatedTimeRemaining: number // seconds
}

export interface EngineStatus {
  connectionId: string
  state: 'idle' | 'loading' | 'processing' | 'trading' | 'error'
  activeProcesses: string[]
  lastUpdate: string
  cycleCount: number
  errorCount: number
}

export class WebSocketManager {
  private ws: WebSocket | null = null
  private url: string
  private connectionId: string
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 3000
  private subscriptions: Map<WebSocketEventType, Set<(data: any) => void>> = new Map()
  private messageQueue: WebSocketMessage[] = []
  private isConnecting = false
  private messageSequence = 0

  constructor(connectionId: string, url?: string) {
    this.connectionId = connectionId
    this.url = url || this.buildWebSocketUrl()
  }

  private buildWebSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    return `${protocol}//${host}/api/ws`
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        resolve()
        return
      }

      if (this.isConnecting) {
        resolve()
        return
      }

      this.isConnecting = true

      try {
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected')
          this.isConnecting = false
          this.reconnectAttempts = 0
          this.sendQueuedMessages()
          resolve()
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error)
          this.isConnecting = false
          this.emit('error', { message: 'WebSocket error', error })
          reject(error)
        }

        this.ws.onclose = () => {
          console.log('[WebSocket] Disconnected')
          this.isConnecting = false
          this.ws = null
          this.attemptReconnect()
        }
      } catch (error) {
        console.error('[WebSocket] Connection failed:', error)
        this.isConnecting = false
        reject(error)
      }
    })
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  public subscribe(eventType: WebSocketEventType, callback: (data: any) => void): () => void {
    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, new Set())
    }
    this.subscriptions.get(eventType)!.add(callback)

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(eventType)
      if (subs) {
        subs.delete(callback)
      }
    }
  }

  public emit(eventType: WebSocketEventType, data: any): void {
    const callbacks = this.subscriptions.get(eventType)
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          callback(data)
        } catch (error) {
          console.error(`[WebSocket] Error in subscription callback for ${eventType}:`, error)
        }
      })
    }
  }

  private handleMessage(rawData: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(rawData)

      // Only process messages for current connection
      if (message.connectionId !== this.connectionId && message.connectionId !== '*') {
        return
      }

      this.emit(message.type, message.data)
    } catch (error) {
      console.error('[WebSocket] Failed to parse message:', error)
    }
  }

  public send(eventType: WebSocketEventType, data: any): void {
    const message: WebSocketMessage = {
      type: eventType,
      connectionId: this.connectionId,
      data,
      timestamp: new Date().toISOString(),
      sequence: ++this.messageSequence,
    }

    const payload = JSON.stringify(message)

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
    } else {
      // Queue message if not connected
      this.messageQueue.push(message)
    }
  }

  private sendQueuedMessages(): void {
    while (this.messageQueue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift()
      if (message) {
        this.ws.send(JSON.stringify(message))
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('[WebSocket] Reconnection failed:', error)
        })
      }, delay)
    } else {
      console.error('[WebSocket] Max reconnection attempts reached')
      this.emit('error', { message: 'WebSocket reconnection failed' })
    }
  }

  public getConnectionState(): string {
    if (!this.ws) return 'DISCONNECTED'
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'CONNECTING'
      case WebSocket.OPEN:
        return 'CONNECTED'
      case WebSocket.CLOSING:
        return 'CLOSING'
      case WebSocket.CLOSED:
        return 'DISCONNECTED'
      default:
        return 'UNKNOWN'
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}

// Global singleton for WebSocket management
let wsManager: WebSocketManager | null = null

export function getWebSocketManager(connectionId: string): WebSocketManager {
  if (!wsManager || wsManager['connectionId'] !== connectionId) {
    if (wsManager) {
      wsManager.disconnect()
    }
    wsManager = new WebSocketManager(connectionId)
  }
  return wsManager
}

export function disconnectWebSocket(): void {
  if (wsManager) {
    wsManager.disconnect()
    wsManager = null
  }
}
