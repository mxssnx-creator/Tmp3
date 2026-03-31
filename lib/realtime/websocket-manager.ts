/**
 * WebSocket Manager
 * Manages WebSocket connections for real-time data streaming
 */

export interface WebSocketConfig {
  url: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  heartbeatInterval?: number
}

export type MessageHandler = (data: any) => void

export class WebSocketManager {
  private ws: WebSocket | null = null
  private config: WebSocketConfig
  private reconnectAttempts = 0
  private messageHandlers: Map<string, MessageHandler[]> = new Map()
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private isConnecting = false

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      ...config,
    }
  }

  /**
   * Connect to WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve()
        return
      }

      if (this.isConnecting) {
        reject(new Error("Connection already in progress"))
        return
      }

      this.isConnecting = true

      try {
        this.ws = new WebSocket(this.config.url)

        this.ws.onopen = () => {
          console.log("[v0] WebSocket connected")
          this.isConnecting = false
          this.reconnectAttempts = 0
          this.startHeartbeat()
          resolve()
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            this.handleMessage(data)
          } catch (error) {
            console.error("[v0] Failed to parse WebSocket message:", error)
          }
        }

        this.ws.onerror = (error) => {
          console.error("[v0] WebSocket error:", error)
          this.isConnecting = false
          reject(error)
        }

        this.ws.onclose = () => {
          console.log("[v0] WebSocket closed")
          this.isConnecting = false
          this.stopHeartbeat()
          this.attemptReconnect()
        }
      } catch (error) {
        this.isConnecting = false
        reject(error)
      }
    })
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.stopHeartbeat()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Send message through WebSocket
   */
  send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    } else {
      console.warn("[v0] WebSocket not connected, cannot send message")
    }
  }

  /**
   * Subscribe to specific message type
   */
  subscribe(channel: string, handler: MessageHandler): void {
    if (!this.messageHandlers.has(channel)) {
      this.messageHandlers.set(channel, [])
    }
    this.messageHandlers.get(channel)!.push(handler)
  }

  /**
   * Unsubscribe from message type
   */
  unsubscribe(channel: string, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(channel)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index > -1) {
        handlers.splice(index, 1)
      }
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: any): void {
    const channel = data.channel || data.type || "default"
    const handlers = this.messageHandlers.get(channel)

    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data)
        } catch (error) {
          console.error(`[v0] Error in message handler for channel ${channel}:`, error)
        }
      })
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" })
      }
    }, this.config.heartbeatInterval)
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }
  }

  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts!) {
      console.error("[v0] Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    console.log(`[v0] Attempting to reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error("[v0] Reconnect failed:", error)
      })
    }, this.config.reconnectInterval)
  }

  /**
   * Get connection status
   */
  getStatus(): string {
    if (!this.ws) return "disconnected"
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return "connecting"
      case WebSocket.OPEN:
        return "connected"
      case WebSocket.CLOSING:
        return "closing"
      case WebSocket.CLOSED:
        return "disconnected"
      default:
        return "unknown"
    }
  }
}
