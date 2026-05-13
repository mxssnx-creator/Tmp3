# Dev Debug Mode - Quick Start Guide

**Status**: ✅ ACTIVE
**Server**: Running on http://localhost:3002
**Time**: May 13, 2026

---

## Immediate Actions

### 1. Open Your Browser
```
URL: http://localhost:3002
```

### 2. Open DevTools
```
Press: F12 (or Cmd+Option+I on Mac)
Tab: Console
Filter: [v0]
```

### 3. Start Debugging
```typescript
// Add to any file:
console.log("[v0] Debug message here")
```

### 4. Watch Changes
```
Edit file → Save → Auto-reload (HMR) → See changes
```

---

## Debug Checklist

### Before Starting
- [ ] Dev server running (http://localhost:3002)
- [ ] No build errors shown
- [ ] Browser console open (F12)
- [ ] Network tab visible

### While Debugging
- [ ] Adding [v0] logs to trace execution
- [ ] Checking browser console for messages
- [ ] Monitoring Network tab for API calls
- [ ] Making file changes and watching HMR
- [ ] Verifying changes work as expected

### After Debugging
- [ ] Remove all [v0] debug logs
- [ ] Verify no console errors
- [ ] Test application thoroughly
- [ ] Commit clean code without debug statements

---

## One-Line Examples

### Log Variable State
```typescript
console.log("[v0] Variable name:", variableName)
```

### Log Function Entry/Exit
```typescript
console.log("[v0] Function started")
// ... function body ...
console.log("[v0] Function completed")
```

### Log API Call Response
```typescript
console.log("[v0] API response:", JSON.stringify(response, null, 2))
```

### Log Error
```typescript
console.error("[v0] Error occurred:", error.message)
```

### Log Timing
```typescript
const start = Date.now()
// ... operation ...
console.log("[v0] Operation took", Date.now() - start, 'ms')
```

---

## File Locations

**Component Files**
```
components/
lib/
app/
  - page.tsx
  - layout.tsx
  - api/
```

**Debug Files Created**
```
DEBUG_MODE_ACTIVE.md (full guide)
DEBUG_MODE_QUICK_START.md (this file)
```

---

## Common Issues & Solutions

### Issue: Changes not appearing
**Solution**: 
- Check terminal for compilation errors
- Hard refresh browser (Ctrl+Shift+R or Cmd+Shift+R)
- Check DevTools Network tab

### Issue: Console logs not showing
**Solution**:
- Check DevTools is open (F12)
- Check filter is clear (or set to "[v0]")
- Refresh page (Ctrl+R)

### Issue: API calls failing
**Solution**:
- Check DevTools Network tab
- Click request to see response
- Check server logs in terminal
- Add [v0] logs to API route

### Issue: HMR not working
**Solution**:
- Check terminal for errors
- Restart dev server: Kill process and run `npm run dev`
- Clear browser cache

---

## Terminal Commands

```bash
# Check dev server is running
ps aux | grep "next dev"

# Kill and restart dev server
pkill -f "next dev"
npm run dev

# Search for debug logs in code
grep -r "\[v0\]" app/ lib/ components/ --include="*.ts" --include="*.tsx"

# View recent logs
tail -20 /tmp/dev-server.log
```

---

## Performance Tips

### Fast Debugging
1. Add [v0] log near problem area
2. Save file (auto-reload)
3. Check console output
4. Done - no page refresh needed

### Focused Testing
1. Open DevTools Network tab
2. Filter by "api" to see only API calls
3. Click requests to inspect
4. Verify response data matches expectations

### Code Navigation
1. Right-click variable name in browser
2. Select "Go to definition"
3. Jump directly to source code
4. Make changes and HMR reloads

---

## Status Check

```
Dev Server:     ✅ Running (port 3002)
HMR:            ✅ Active
Console:        ✅ Ready (F12)
Network Tab:    ✅ Ready (F12 → Network)
Build System:   ✅ Ready
Debug Mode:     ✅ ENABLED
```

---

## You're Ready!

Everything is set up. Go debug! 🚀

