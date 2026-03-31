import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getSettings, setSettings } from "@/lib/redis-db"
import { auditLogger } from "@/lib/audit-logger"
import { apiErrorHandler, ApiError } from "@/lib/api-error-handler"
import { SystemLogger } from "@/lib/system-logger"

// API Category - used in all responses for type tracking
const API_CATEGORY = "trading.orders"

// Order validation constants
const ORDER_LIMITS = {
  MAX_AMOUNT_USDT: 100000, // Max $100k per order
  MAX_QUANTITY: 1000000, // Max 1M units per order
  MIN_AMOUNT_USDT: 10, // Min $10 per order
  MAX_ORDERS_PER_MINUTE: 500, // Maximum rate limit - no practical limit
}

// Simple per-user rate limiter for order creation
const orderTimestamps = new Map<string, number[]>()

function checkOrderRateLimit(userId: string): boolean {
  const now = Date.now()
  const timestamps = orderTimestamps.get(userId) || []
  // Remove timestamps older than 1 minute
  const recent = timestamps.filter((ts) => now - ts < 60000)
  if (recent.length >= ORDER_LIMITS.MAX_ORDERS_PER_MINUTE) {
    return false
  }
  recent.push(now)
  orderTimestamps.set(userId, recent)
  return true
}

function validateOrder(order: any): { valid: boolean; error?: string } {
  if (!order.quantity || typeof order.quantity !== "number") {
    return { valid: false, error: "Invalid quantity" }
  }

  if (order.quantity <= 0) {
    return { valid: false, error: "Quantity must be positive" }
  }

  if (order.quantity > ORDER_LIMITS.MAX_QUANTITY) {
    return { valid: false, error: `Quantity exceeds limit of ${ORDER_LIMITS.MAX_QUANTITY}` }
  }

  // For limit orders, validate price
  if (order.order_type === "limit" && (!order.price || typeof order.price !== "number")) {
    return { valid: false, error: "Limit orders require a price" }
  }

  if (order.price && order.price <= 0) {
    return { valid: false, error: "Price must be positive" }
  }

  // Estimate order value for limit orders
  if (order.price && order.quantity) {
    const orderValue = order.price * order.quantity
    if (orderValue > ORDER_LIMITS.MAX_AMOUNT_USDT) {
      return { valid: false, error: `Order value exceeds limit of $${ORDER_LIMITS.MAX_AMOUNT_USDT}` }
    }
    if (orderValue < ORDER_LIMITS.MIN_AMOUNT_USDT) {
      return { valid: false, error: `Order value below minimum of $${ORDER_LIMITS.MIN_AMOUNT_USDT}` }
    }
  }

  if (!["BUY", "SELL"].includes(order.side?.toUpperCase() || "")) {
    return { valid: false, error: "Side must be BUY or SELL" }
  }

  if (!["limit", "market"].includes(order.order_type?.toLowerCase() || "")) {
    return { valid: false, error: "Order type must be limit or market" }
  }

  return { valid: true }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      throw new ApiError("Not authenticated", {
        statusCode: 401,
        code: "UNAUTHORIZED",
        context: { operation: "get_orders" },
      })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const limit = Math.min(Number.parseInt(searchParams.get("limit") || "50"), 500)

    const allOrders = (await getSettings("orders")) || []
    let filtered = allOrders.filter((o: any) => o.user_id === user.id)

    if (status) {
      if (!["pending", "filled", "partially_filled", "cancelled", "rejected"].includes(status)) {
        throw new ApiError("Invalid status filter", {
          statusCode: 400,
          code: "VALIDATION_ERROR",
          details: { status },
        })
      }
      filtered = filtered.filter((o: any) => o.status === status)
    }

    filtered = filtered.slice(0, limit)

    return NextResponse.json({
      success: true,
      category: API_CATEGORY,
      timestamp: new Date().toISOString(),
      data: filtered,
      count: filtered.length,
    })
  } catch (error) {
    console.error("[v0] Get orders error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        category: API_CATEGORY,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Not authenticated", category: API_CATEGORY },
        { status: 401 }
      )
    }

    // Rate limit check
    const isAllowed = checkOrderRateLimit(String(user.id))
    if (!isAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Rate limit exceeded: max 500 orders per minute",
          category: API_CATEGORY,
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      )
    }

    let bodyData
    try {
      bodyData = await request.json()
    } catch (e) {
      return NextResponse.json(
        { success: false, error: "Invalid JSON in request body", category: API_CATEGORY },
        { status: 400 }
      )
    }

    const { connection_id, symbol, order_type, side, price, quantity, time_in_force } = bodyData

    // Required field validation
    if (!connection_id || !symbol || !order_type || !side || !quantity) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: connection_id, symbol, order_type, side, quantity",
          category: API_CATEGORY,
        },
        { status: 400 }
      )
    }

    // Order validation
    const validation = validateOrder({ quantity, price, order_type, side })
    if (!validation.valid) {
      console.warn(`[v0] Order validation failed for user ${user.id}: ${validation.error}`)
      return NextResponse.json(
        { success: false, error: validation.error, category: API_CATEGORY },
        { status: 400 }
      )
    }

    // Symbol validation (basic format check)
    if (typeof symbol !== "string" || symbol.length < 2 || symbol.length > 20) {
      return NextResponse.json(
        { success: false, error: "Invalid symbol format", category: API_CATEGORY },
        { status: 400 }
      )
    }

    const existing = (await getSettings("orders")) || []
    const newOrder = {
      id: `order:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
      user_id: String(user.id),
      connection_id,
      symbol: symbol.toUpperCase(),
      order_type: order_type.toLowerCase(),
      side: side.toUpperCase(),
      price: price || null,
      quantity,
      remaining_quantity: quantity,
      time_in_force: time_in_force || "GTC",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Log order creation for audit
    await auditLogger.log({
      user_id: String(user.id),
      action: "order_create",
      entity_type: "order",
      entity_id: newOrder.id,
      details: {
        symbol: newOrder.symbol,
        side: newOrder.side,
        quantity: newOrder.quantity,
        price: newOrder.price,
        order_type: newOrder.order_type,
      },
      status: "success",
      connection_id,
    })

    console.log(
      `[v0] [Audit] Order created by ${user.id}: ${symbol} ${side} ${quantity}@${price || "market"}`
    )

    existing.push(newOrder)
    await setSettings("orders", existing)

    return NextResponse.json({
      success: true,
      category: API_CATEGORY,
      timestamp: new Date().toISOString(),
      data: newOrder,
    })
  } catch (error) {
    console.error("[v0] Create order error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        category: API_CATEGORY,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
