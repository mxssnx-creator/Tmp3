# Exchange Context Coordination Guide

## Overview
This document explains how the Exchange Context system ensures that all data, processing, and content on each page correctly relies on the selected exchange/connection.

## Exchange Context System

### Core Components

#### 1. ExchangeProvider (`lib/exchange-context.tsx`)
- **Purpose**: Central provider managing selected exchange and connection context
- **Key States**:
  - `selectedExchange`: Currently selected exchange name (e.g., "bingx", "bybit")
  - `selectedConnectionId`: Currently selected connection ID
  - `selectedConnection`: Full connection object with all details
  - `activeConnections`: List of all active connections

#### 2. useExchange Hook
```typescript
const { 
  selectedExchange,      // Current exchange name
  setSelectedExchange,   // Update selected exchange
  selectedConnectionId,  // Current connection ID
  setSelectedConnectionId, // Update selected connection
  selectedConnection,    // Full connection object
  activeConnections,     // All active connections
  loadActiveConnections, // Refresh active connections
  isLoading              // Loading state
} = useExchange()
```

#### 3. GlobalExchangeSelector Component
- **Location**: `components/global-exchange-selector.tsx`
- **Purpose**: Provides UI for switching between active exchanges
- **Behavior**:
  - Displays all active connections
  - Updates exchange context when selection changes
  - Shows testnet badge if applicable

## Data Flow Architecture

### Main Page Connections

**Flow Diagram**:
```
ActiveConnectionCard (specific connection)
    ↓
  Displays: Progression data for THIS connection
  Uses: connection.connectionId for all API calls
  Provides: connectionId → ProgressionLogsDialog
```

**Key Files**:
- `components/dashboard/active-connection-card.tsx` - Individual connection card
- `components/dashboard/progression-logs-dialog.tsx` - Shows logs for specific connection
- Uses: `/api/connections/progression/{connectionId}` API endpoint

### QuickStart Dialogs

**Flow Diagram**:
```
QuickStartButton
    ↓
    Uses: useExchange() to get selectedConnectionId
    ↓
  QuickstartOverviewDialog
    - Accepts selectedConnectionId from context
    - Falls back to prop connectionId if provided
    - Final fallback to hardcoded "bingx-x01"
    ↓
  Uses: `/api/connections/progression/{selectedConnectionId}/logs`
```

**Updated Behavior**:
- QuickstartOverviewDialog now uses exchange context
- If no context, uses prop connectionId
- Displays data for the selected exchange

## Connection-Specific Data Endpoints

All these endpoints require `{connectionId}` parameter and return data specific to that connection:

```
GET /api/connections/progression/{connectionId}
  → Progression state for specific connection
  → Fields: cycles, trades, indications, strategies, etc.

GET /api/connections/progression/{connectionId}/logs
  → Logs specific to this connection
  → Uses Redis key: progression:{connectionId}

POST /api/trade-engine/quick-start
  → Enables/disables specific connection
  → Requires: action, symbols
  → Returns: connection ID, stats

GET /api/settings/connections/{connectionId}/live-trade
  → Status of live trading for this connection
```

## Implementation Checklist

### For Each Dialog/Component Displaying Data:

- [ ] **Import useExchange hook**: `import { useExchange } from "@/lib/exchange-context"`
- [ ] **Get selected connection**: `const { selectedConnectionId, selectedConnection } = useExchange()`
- [ ] **Use in API calls**: Pass `selectedConnectionId` to all API endpoints
- [ ] **Handle fallback**: If no context, use prop or default value
- [ ] **Update on context change**: useEffect dependency on `selectedConnectionId`
- [ ] **Display active connection**: Show which connection data is from

### For Each Page/Dialog:

1. **Main Connections Page** ✅
   - Each ActiveConnectionCard has its own connectionId
   - ProgressionLogsDialog receives connectionId from card
   - All data is connection-specific

2. **QuickStart Dialogs** ✅
   - QuickstartOverviewDialog now uses exchange context
   - Falls back to prop for override capability
   - Shows selected connection data

3. **Settings Pages**
   - Already connection-aware (pass connectionId in URL)
   - Use connection-specific API endpoints

## Current Implementation Status

### Exchange Context Integration

| Component | Status | Notes |
|-----------|--------|-------|
| ExchangeProvider | ✅ Active | Loads connections on mount |
| useExchange hook | ✅ Active | Used throughout app |
| GlobalExchangeSelector | ✅ Active | Allows switching exchanges |
| QuickstartOverviewDialog | ✅ Updated | Now uses exchange context |
| ProgressionLogsDialog | ✅ Active | Receives connectionId from parent |
| ActiveConnectionCard | ✅ Active | Has own connectionId, passes to dialogs |

### Data Flow Verification

All components now correctly:
1. Get selected connection from context or props
2. Pass connectionId to API endpoints
3. Display data for the correct connection
4. Update when connection changes

## API Data Consistency

### Progression State Tracking

Each connection maintains independent state in Redis:
```
progression:{connectionId}:state
  - cyclesCompleted
  - successfulCycles
  - failedCycles
  - totalTrades
  - indicationsCount
  - strategiesCount
  - etc.

progression:{connectionId}:logs
  - Log entries for this connection only
```

### No Data Bleeding

- Each connection's data is isolated by connectionId key
- API endpoints validate connectionId ownership
- Dialogs explicitly pass connectionId for queries

## Testing Exchange Context

### To Verify Correct Connection Is Selected:

1. **Open Main Page**
   - Note which connection is in "Active Connections"
   - Click "Progression Logs" button on a connection
   - Dialog shows correct connectionId in header

2. **Switch Exchange**
   - Use GlobalExchangeSelector to change connection
   - QuickStart dialogs update to show new connection
   - All metrics are for new connection

3. **Multiple Connections**
   - Each card shows independent progression
   - Logs show only logs for that connection
   - No data cross-contamination

## Future Enhancements

- [ ] Add connection indicator badge to all dialogs
- [ ] Add connection switching within dialogs
- [ ] Add per-connection historical data storage
- [ ] Add connection performance comparison view

---

**Last Updated**: 2026-04-04
**Status**: All exchange context coordination implemented and verified
