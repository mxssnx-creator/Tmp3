# Webhook-Based Slack Notification Setup Guide

## Overview
This guide configures webhook-based Slack notifications for the CTS (Crypto Trading System) alerting infrastructure. The system already includes a robust alerting framework that supports multiple channels including Slack, webhooks, email, and PagerDuty.

## Architecture

### Alerting System (`lib/alerting-system.ts`)
- **Alert Severity Levels**: INFO, WARNING, ERROR, CRITICAL
- **Alert Channels**: Slack, PagerDuty, Email, Webhook
- **Features**: 
  - Deduplication (1-minute window)
  - Severity-based filtering
  - Multiple channel support
  - Error handling with fallback logging

### Alert Manager (`lib/alerting-system.ts`)
- Centralized `AlertManager` class
- Singleton instance exported as `alertManager`
- Supports async notification delivery to all channels
- Built-in retry and error handling

## Configuration Steps

### 1. Environment Variables

Create a `.env.local` file from the example:

```bash
cp .env.example .env.local
```

Add your Slack webhook URL to `.env.local`:

```env
# Slack Configuration
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### 2. Enable Webhook Channel

Update your alert configuration to enable webhooks. This can be done through the settings API or by modifying the alert manager configuration.

### 3. API Endpoints

The system provides REST endpoints for alert management:

- **POST** `/api/alerts` - Send alerts
- **GET** `/api/alerts` - Retrieve alert history  
- **DELETE** `/api/alerts` - Clear alert history

### 4. Usage Examples

#### Send a Basic Alert
```bash
curl -X POST http://localhost:3001/api/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "title": "High Latency Alert",
    "message": "Exchange latency exceeded threshold: 500ms",
    "severity": "warning",
    "source": "monitoring"
  }'
```

#### Send a Critical Alert with Metadata
```bash
curl -X POST http://localhost:3001/api/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Exchange Connection Failure",
    "message": "Lost connection to Bybit exchange",
    "severity": "critical",
    "source": "exchange-monitor",
    "metadata": {
      "exchange": "bybit",
      "connection_type": "websocket",
      "reconnect_attempts": 3
    }
  }'
```

#### Retrieve Alert History
```bash
curl http://localhost:3001/api/alerts?limit=20
```

## Integration Points

### Error Handler Integration (`lib/error-handler.ts`)
The error handler automatically sends critical non-operational errors to the alert system:

```typescript
if (error instanceof AppError && !error.isOperational) {
  await this.sendAlert(error, context)
}
```

### Alert Manager Integration
Alerts can be sent programmatically:

```typescript
import { alertManager } from '@/lib/alerting-system'

// Send alert with specific severity
await alertManager.sendAlert(
  'Position Liquidation Risk',
  'Uniswap position approaching liquidation threshold',
  { severity: AlertSeverity.CRITICAL, source: 'risk-monitor' }
)
```

## Slack Message Format

Slack notifications include:
- **Color-coded severity** (green=info, orange=warning, red=error, dark-red=critical)
- **Mention support** (optional user mentions via `mentionUsers` config)
- **Rich attachments** with:
  - Alert title and message
  - Severity level
  - Source identifier
  - Timestamp
  - Custom metadata fields

## Monitoring Best Practices

1. **Severity Thresholds**: Configure minimum severity levels per environment
   - Development: WARNING
   - Staging: WARNING
   - Production: ERROR

2. **Deduplication**: Enable to prevent alert spam (default: 1-minute window)

3. **Channel Configuration**: 
   - Use webhooks for external integrations
   - Use Slack for team notifications
   - Use email for formal alerts
   - Use PagerDuty for on-call escalation

## Troubleshooting

### Common Issues
- **Webhook URL not configured**: Check `channels.webhook.url` in config
- **Slack webhook invalid**: Verify URL format at https://api.slack.com/messaging/webhooks
- **Alerts not sending**: Check channel `enabled` flags in config
- **Duplicate alerts**: Verify deduplication settings

### Debug Mode
Enable debug logging in your application to trace alert delivery:
```typescript
alertManager.updateConfig({
  debug: true
})
```

## Security Considerations

1. **Webhook URLs**: Treat as secrets - store in environment variables, never commit to git
2. **Rate Limiting**: Implement client-side throttling to prevent API abuse
3. **Input Validation**: All alert fields are validated before sending
4. **Error Isolation**: Failed channel deliveries don't block other channels

## Next Steps

1. Configure your Slack webhook URL in `.env.local`
2. Test the alert system with the curl examples above
3. Integrate with your monitoring/error-handling code
4. Set up appropriate severity thresholds for your use case
5. Configure channel-specific settings (mentions, formatting, etc.)