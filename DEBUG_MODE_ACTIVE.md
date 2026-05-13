# Development Debug Mode - Active

**Status**: ✅ Development server running on port 3002
**Started**: Now
**Debug Mode**: Enabled

---

## Server Status

- **Dev Server**: Running (PID: 561)
- **Port**: 3002
- **URL**: http://localhost:3002
- **Build**: Hot Module Replacement (HMR) enabled
- **Node Memory**: 8GB allocated

---

## Debug Features Enabled

### 1. Console Debugging
Use `console.log("[v0] ...")` statements in your code to trace execution:

```typescript
// Example:
console.log("[v0] Processing position:", position)
console.log("[v0] API response:", response)
console.log("[v0] State updated:", newState)
```

### 2. Browser DevTools
- **Access**: Open http://localhost:3002 and press F12
- **Console Tab**: View all [v0] logs and errors
- **Network Tab**: Monitor API calls
- **Performance Tab**: Track rendering performance
- **React DevTools**: Inspect component hierarchy

### 3. Server Logs
The terminal shows real-time server logs:
- Build messages
- API route logs
- Error traces
- Hot reload updates

### 4. Hot Module Replacement (HMR)
Changes to files are reflected immediately:
- Edit a component → Auto-refresh
- Edit an API route → Auto-restart
- Edit styles → Instant update
- No full page reload needed

---

## Debugging Workflow

### Step 1: Add Debug Logs
```typescript
// In your component or API route
console.log("[v0] Debug point 1: Starting operation")
console.log("[v0] State:", JSON.stringify(state, null, 2))
console.log("[v0] Error occurred:", error.message)
```

### Step 2: View Logs
- **Browser**: Open DevTools Console (F12)
- **Terminal**: Watch the dev server output
- **Network**: Monitor API calls in DevTools Network tab

### Step 3: Make Changes
- Edit files in your IDE
- Save changes
- Page auto-refreshes (HMR)
- Check new behavior

### Step 4: Remove Debug Logs
Once debugging is complete:
```bash
# Search for debug logs
grep -r "\[v0\]" app/ lib/ components/ --include="*.ts" --include="*.tsx"

# Remove them using the Edit tool
# Or use search/replace to remove all [v0] logs
```

---

## Common Debug Scenarios

### Debugging API Routes
```typescript
// File: app/api/example/route.ts
export async function POST(request: Request) {
  console.log("[v0] API request received")
  
  const data = await request.json()
  console.log("[v0] Request body:", JSON.stringify(data, null, 2))
  
  try {
    const result = await processData(data)
    console.log("[v0] Processing result:", result)
    return Response.json({ success: true, data: result })
  } catch (error) {
    console.error("[v0] API error:", error)
    return Response.json({ success: false, error: String(error) }, { status: 500 })
  }
}
```

### Debugging Components
```typescript
// File: components/example.tsx
'use client'

import { useState, useEffect } from 'react'

export function Example() {
  const [data, setData] = useState(null)
  
  useEffect(() => {
    console.log("[v0] Component mounted")
    
    fetch('/api/data')
      .then(res => res.json())
      .then(result => {
        console.log("[v0] Data loaded:", result)
        setData(result)
      })
      .catch(err => console.error("[v0] Fetch error:", err))
    
    return () => console.log("[v0] Component unmounted")
  }, [])
  
  console.log("[v0] Rendering with data:", data)
  return <div>{/* render */}</div>
}
```

### Debugging Database Operations
```typescript
// File: lib/database-coordinator.ts
async function storePosition(connectionId: string, symbol: string, position: Position) {
  console.log("[v0] Storing position:", { connectionId, symbol, ...position })
  
  try {
    SchemaValidators.position(position)
    console.log("[v0] Position validation passed")
    
    const result = await redis.hset(key, position)
    console.log("[v0] Redis store result:", result)
    
    return result
  } catch (error) {
    console.error("[v0] Store error:", error)
    throw error
  }
}
```

---

## Browser DevTools Guide

### Console Tab
```
Click F12 → Console tab
- Search: "Filter: [v0]" to see only debug logs
- Clear: Ctrl+L to clear console
- Copy: Right-click → Copy to clipboard
```

### Network Tab
```
Click F12 → Network tab
- Monitor: All API calls in real-time
- Inspect: Click request to see details
- Filter: Type "api" to show only API calls
- Performance: See timing for each request
```

### Sources Tab
```
Click F12 → Sources tab
- Set Breakpoints: Click line number
- Step Through: F10 (step over), F11 (step into)
- Watch Variables: Add to watch expressions
- Call Stack: See function call hierarchy
```

### Application Tab
```
Click F12 → Application tab
- Local Storage: View stored data
- Session Storage: View session data
- Cookies: Inspect all cookies
- Cache: View cached assets
```

---

## Terminal Output Format

You'll see output like:
```
> my-v0-project@0.1.0 dev
> NODE_OPTIONS='--max-old-space-size=8192' next dev -p 3002

  ▲ Next.js 14.0.0
  - Local:        http://localhost:3002
  - Environments: .env.local

 ✓ Compiled /app/page.tsx in 1.2s (123 modules)
 ✓ Compiled /app/api/example/route.ts in 0.8s (45 modules)

[v0] Debug log here
GET /api/data 200 in 45ms
```

---

## Monitoring Active Development

### Watch for Compilation Errors
- Red errors in terminal = Build failed
- Yellow warnings = May cause issues
- Green checkmarks = All good

### Track File Changes
- Edit a file → Terminal shows compilation
- Check if compilation succeeds (✓)
- Page should auto-refresh

### Monitor API Calls
- **Terminal**: See route compilations
- **Network Tab**: See call timing and responses
- **[v0] Logs**: See your debug output

---

## Performance Debugging

### Measure Operation Time
```typescript
console.log("[v0] Starting heavy operation")
const start = Date.now()

// ... do work ...

const duration = Date.now() - start
console.log("[v0] Operation completed in", duration, 'ms')
```

### Profile Component Rendering
```typescript
console.log("[v0] Component rendering started")
// React renders component
console.log("[v0] Component rendering completed")
```

### Monitor Database Operations
```typescript
console.log("[v0] Query start:", new Date().toISOString())
const result = await dbQuery()
console.log("[v0] Query end:", new Date().toISOString())
```

---

## Cleanup After Debugging

When finished debugging:

1. **Remove Debug Logs**
   ```bash
   grep -r "\[v0\]" app/ lib/ components/ --include="*.ts" --include="*.tsx"
   # Use Edit tool to remove them
   ```

2. **Verify No Console Errors**
   - Open DevTools Console (F12)
   - Should show no errors or warnings

3. **Test Full Application**
   - Navigate through all pages
   - Verify all features work
   - Check for any regressions

4. **Commit Clean Code**
   - No [v0] debug logs
   - All tests passing
   - Ready for production

---

## Useful Commands

```bash
# Check dev server status
ps aux | grep "next dev"

# View dev server logs
tail -f /tmp/dev-server.log

# Kill dev server and restart
pkill -f "next dev"
npm run dev

# Check for compile errors
curl http://localhost:3002/_next/static/chunks/pages/_app.js 2>&1 | head -5

# Monitor all API calls in real-time
curl -v http://localhost:3002/api/example
```

---

## Current Session Status

- **Dev Server**: ✅ Running
- **Port**: 3002
- **HMR**: ✅ Active
- **Debug Mode**: ✅ Enabled
- **Ready**: Yes, start debugging!

---

## Next Steps

1. ✅ Dev server is running
2. ✅ Debug mode is active
3. ⏭ Open http://localhost:3002 in your browser
4. ⏭ Press F12 to open DevTools
5. ⏭ Add [v0] console.log statements to your code
6. ⏭ Make changes and watch HMR reload
7. ⏭ Check browser console and Network tab

---

**Debug Mode Started**: Now
**Status**: Ready to debug
**URL**: http://localhost:3002

