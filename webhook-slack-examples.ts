// Webhook Slack Notification Implementation Example
// This file demonstrates how to use the existing alerting infrastructure
// for webhook-based Slack notifications

import { alertManager, AlertSeverity } from '@/lib/alerting-system'

/**
 * Example: Configure and send webhook-based Slack notifications
 * 
 * The alert manager is already configured with webhook support.
 * This example shows how to integrate it into your application.
 */

// Example 1: Send a webhook alert to Slack
export async function sendSlackWebhookAlert() {
  try {
    await alertManager.sendAlert(
      'Exchange API Latency Alert',
      'Bybit exchange API response time exceeded 1000ms threshold',
      {
        severity: AlertSeverity.WARNING,
        source: 'exchange-monitor',
        metadata: {
          exchange: 'bybit',
          api_endpoint: '/v5/market/tickers',
          latency_ms: 1250,
          threshold_ms: 1000
        }
      }
    )
    console.log('Slack webhook alert sent successfully')
  } catch (error) {
    console.error('Failed to send Slack alert:', error)
  }
}

// Example 2: Critical error notification with context
export async function sendCriticalErrorNotification(error: Error, context?: any) {
  await alertManager.sendAlert(
    'Critical System Error',
    error.message,
    {
      severity: AlertSeverity.CRITICAL,
      source: 'error-handler',
      metadata: {
        ...context,
        error_stack: error.stack,
        error_type: error.name
      }
    }
  )
}

// Example 3: Position risk monitoring
export async function checkPositionRisk(position: any) {
  const liquidationPrice = position.liquidationPrice
  const currentPrice = position.currentPrice
  const riskRatio = Math.abs((currentPrice - liquidationPrice) / currentPrice * 100)

  if (riskRatio > 10) {
    await alertManager.sendAlert(
      'High Liquidation Risk',
      `Position ${position.symbol} is at ${riskRatio.toFixed(2)}% from liquidation`,
      {
        severity: riskRatio > 20 ? AlertSeverity.CRITICAL : AlertSeverity.ERROR,
        source: 'risk-monitor',
        metadata: {
          symbol: position.symbol,
          liquidation_price: liquidationPrice,
          current_price: currentPrice,
          risk_ratio: riskRatio.toFixed(2)
        }
      }
    )
  }
}

// Example 4: Exchange connection monitoring
export async function monitorExchangeConnection(exchange: string, status: 'connected' | 'disconnected') {
  if (status === 'disconnected') {
    await alertManager.sendAlert(
      `Exchange ${exchange} Connection Lost`,
      `Connection to ${exchange} exchange was unexpectedly lost`,
      {
        severity: AlertSeverity.ERROR,
        source: 'connection-monitor',
        metadata: {
          exchange,
          timestamp: new Date().toISOString(),
          auto_reconnect_enabled: true
        }
      }
    )
  }
}

// Example 5: Batch alert suppression with deduplication
export async function sendSuppressedAlert(type: string, message: string) {
  // The alert manager automatically handles deduplication
  // within the configured time window (default: 1 minute)
  await alertManager.sendAlert(
    `Alert: ${type}`,
    message,
    {
      severity: AlertSeverity.WARNING,
      source: 'batch-processor'
    }
  )
}

// Example 6: Programmatic alert configuration update
export function configureAlertSettings() {
  alertManager.updateConfig({
    channels: {
      webhook: {
        enabled: true,
        url: process.env.SLACK_WEBHOOK_URL,
        headers: {
          'Authorization': 'Bearer your-token-if-required'
        }
      }
    },
    minSeverity: AlertSeverity.WARNING,
    deduplication: {
      enabled: true,
      timeWindowMs: 60000 // 1 minute
    }
  })
}

// Example 7: Alert history retrieval for monitoring dashboard
export async function getRecentAlerts(limit: number = 10) {
  const history = alertManager.getAlertHistory(limit)
  const stats = alertManager.getAlertStats()
  
  return {
    recentAlerts: history,
    statistics: stats,
    totalAlerts: stats.total
  }
}

// Example 8: Integration with Next.js API route
/*
export async function POST(request: Request) {
  const body = await request.json()
  const { title, message, severity = 'warning' } = body
  
  await alertManager.sendAlert(title, message, {
    severity: severity as AlertSeverity,
    source: 'api-alert'
  })
  
  return Response.json({ success: true })
}
*/

console.log('Webhook Slack notification examples loaded')
console.log('Configure SLACK_WEBHOOK_URL in .env.local to enable notifications')