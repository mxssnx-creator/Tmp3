#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Pure-logic verification of the multi-step trailing state machine
 * introduced in `lib/trade-engine/realtime-processor.ts → updateTrailingStop`.
 *
 * The real function reads/writes a Redis hash, so it can't be unit-tested
 * without Upstash. This script reproduces the state-machine logic as a
 * pure function and walks a synthetic volatile-symbol price series
 * through it, asserting every transition the spec requires.
 *
 * Mirror-of-record — keep in sync with the real implementation.
 *
 * Spec ratios (Settings → Strategy → Trailing):
 *   start ∈ {0.3, 0.6, 0.9, 1.2, 1.5}    activation gain ratio
 *   stop  ∈ {0.1, 0.2, 0.3, 0.4, 0.5}    trail distance ratio
 *   step  = stop / 2                      ratchet increment ratio
 */

let pass = 0, fail = 0
const failures = []
function ok(c, label, ctx) { if (c) pass++; else { fail++; failures.push({ label, ctx }) } }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)) }

function tick(pos, px) {
  const entry = +pos.entry_price, side = pos.side
  const startR = +pos.trailing_start_ratio, stopR = +pos.trailing_stop_ratio, stepR = +pos.trailing_step_ratio
  const wasActive = pos.trailing_active === "1"
  const anchor = +pos.trailing_anchor, curStop = +pos.trailing_stop_price
  const gain = side === "long" ? (px - entry) / entry : (entry - px) / entry
  if (!wasActive) {
    if (gain < startR) return "noop"
    pos.trailing_active = "1"; pos.trailing_anchor = String(px)
    pos.trailing_stop_price = String(side === "long" ? px * (1 - stopR) : px * (1 + stopR))
    return "activate"
  }
  const stepDist = anchor * stepR
  if (side === "long") {
    if (px <= anchor + stepDist) return "hold"
    const newStop = px * (1 - stopR)
    if (curStop > 0 && newStop <= curStop) { pos.trailing_anchor = String(px); return "anchor-only" }
    pos.trailing_anchor = String(px); pos.trailing_stop_price = String(newStop); return "ratchet"
  } else {
    if (px >= anchor - stepDist) return "hold"
    const newStop = px * (1 + stopR)
    if (curStop > 0 && newStop >= curStop) { pos.trailing_anchor = String(px); return "anchor-only" }
    pos.trailing_anchor = String(px); pos.trailing_stop_price = String(newStop); return "ratchet"
  }
}

function isHit(pos, px) {
  const s = +pos.trailing_stop_price
  if (s <= 0) return false
  return pos.side === "long" ? px <= s : px >= s
}

function makePos({ side = "long", entry = 100, start = 0.3, stop = 0.1 } = {}) {
  return {
    side, entry_price: String(entry),
    trailing_start_ratio: String(start),
    trailing_stop_ratio: String(stop),
    trailing_step_ratio: String(stop / 2),
    trailing_active: "0", trailing_anchor: "0", trailing_stop_price: "0",
  }
}

console.log("=".repeat(72))
console.log("Multi-Step Trailing - Pure Logic Verification")
console.log("=".repeat(72))

// T1: dormant under start
{
  console.log("\n[T1] LONG dormant under start threshold")
  const p = makePos({ start: 0.3, stop: 0.1 })
  for (const x of [105, 115, 125, 128]) ok(tick(p, x) === "noop", `T1 noop @${x}`)
  ok(p.trailing_active === "0", "T1 not armed")
  ok(+p.trailing_stop_price === 0, "T1 stop=0")
  console.log("  PASS")
}

// T2: activation at exact threshold
{
  console.log("\n[T2] LONG activates at exact threshold")
  const p = makePos({ start: 0.3, stop: 0.1 })
  ok(tick(p, 130) === "activate", "T2 activate")
  ok(p.trailing_active === "1", "T2 armed")
  ok(near(+p.trailing_anchor, 130), "T2 anchor=130")
  ok(near(+p.trailing_stop_price, 117), "T2 stop=117")
  console.log(`  anchor=${p.trailing_anchor} stop=${p.trailing_stop_price}  PASS`)
}

// T3: ratchet on Δ ≥ step×anchor
{
  console.log("\n[T3] LONG ratchets on advance")
  const p = makePos({ start: 0.3, stop: 0.1 })
  tick(p, 130) // arm: anchor=130, stop=117, step=6.5
  ok(tick(p, 134) === "hold", "T3 hold @134 Δ4<6.5")
  ok(near(+p.trailing_stop_price, 117), "T3 stop unchanged after hold")
  ok(tick(p, 140) === "ratchet", "T3 ratchet @140")
  ok(near(+p.trailing_anchor, 140), "T3 anchor=140")
  ok(near(+p.trailing_stop_price, 126), "T3 stop=126")
  // step now = 140 × 0.05 = 7
  ok(tick(p, 145) === "hold", "T3 hold @145 Δ5<7")
  ok(tick(p, 150) === "ratchet", "T3 ratchet @150")
  ok(near(+p.trailing_anchor, 150), "T3 anchor=150")
  ok(near(+p.trailing_stop_price, 135), "T3 stop=135")
  console.log("  ladder 117 -> 126 -> 135  PASS")
}

// T4: never relaxes stop
{
  console.log("\n[T4] LONG never relaxes; close at stop")
  const p = makePos({ start: 0.3, stop: 0.1 })
  for (const x of [130, 140, 150]) tick(p, x)
  ok(tick(p, 145) === "hold", "T4 backwash holds")
  ok(near(+p.trailing_stop_price, 135), "T4 stop preserved")
  ok(!isHit(p, 145), "T4 not closed @145")
  ok(!isHit(p, 136), "T4 not closed @136")
  ok(isHit(p, 135), "T4 closed @135")
  ok(isHit(p, 130), "T4 closed @130")
  console.log("  stop locked @135  PASS")
}

// T5: SHORT mirror
{
  console.log("\n[T5] SHORT mirrored ladder")
  const p = makePos({ side: "short", entry: 200, start: 0.3, stop: 0.1 })
  ok(tick(p, 140) === "activate", "T5 short arm")
  ok(near(+p.trailing_stop_price, 154), "T5 stop=154")
  ok(tick(p, 130) === "ratchet", "T5 ratchet @130")
  ok(near(+p.trailing_stop_price, 143), "T5 stop=143")
  ok(tick(p, 132) === "hold", "T5 hold @132 backwash")
  ok(tick(p, 120) === "ratchet", "T5 ratchet @120")
  ok(near(+p.trailing_stop_price, 132), "T5 stop=132")
  ok(!isHit(p, 131), "T5 not closed @131")
  ok(isHit(p, 132), "T5 closed @132")
  ok(isHit(p, 145), "T5 closed @145")
  console.log("  short ladder 154 -> 143 -> 132  PASS")
}

// T6: pump-and-fade end-to-end
{
  console.log("\n[T6] Volatile pump-and-fade end-to-end")
  const p = makePos({ start: 0.3, stop: 0.1 })
  const series = [
    101, 99, 103, 105, 102, 108, 112, 118, 125,
    132,
    138, 142, 145, 152, 158, 165, 170, 175, 180,
    178, 182, 174, 169, 164, 158,
  ]
  let armedAt = -1, closedAt = -1, prevStop = 0
  for (let i = 0; i < series.length; i++) {
    const px = series[i]
    const r = tick(p, px)
    if (r === "activate" && armedAt < 0) armedAt = i
    const s = +p.trailing_stop_price
    if (armedAt >= 0) {
      ok(s >= prevStop, `T6 monotonic @${i}`)
      prevStop = s
    }
    if (armedAt >= 0 && isHit(p, px) && closedAt < 0) closedAt = i
  }
  ok(armedAt >= 0, "T6 armed")
  ok(closedAt >= 0, "T6 closed on fade")
  ok(closedAt > armedAt, "T6 close after arm")
  console.log(`  armed @tick ${armedAt} (px=${series[armedAt]}), closed @tick ${closedAt} (px=${series[closedAt]}), final stop=${p.trailing_stop_price}  PASS`)
}

// T7: every spec variant
{
  console.log("\n[T7] All 25 spec variants well-formed")
  const starts = [0.3, 0.6, 0.9, 1.2, 1.5]
  const stops = [0.1, 0.2, 0.3, 0.4, 0.5]
  let n = 0
  for (const s of starts) for (const k of stops) {
    n++
    const p = makePos({ start: s, stop: k })
    const arm = 100 * (1 + s)
    ok(tick(p, arm) === "activate", `T7 ${s}:${k} arm`)
    ok(near(+p.trailing_stop_price, arm * (1 - k), 1e-9), `T7 ${s}:${k} stop`)
    ok(near(+p.trailing_step_ratio, k / 2, 1e-12), `T7 ${s}:${k} step=stop/2`)
  }
  ok(n === 25, "T7 25 variants")
  console.log(`  ${n}/25 variants  PASS`)
}

console.log("\n" + "=".repeat(72))
console.log(`Result: ${pass} passed, ${fail} failed`)
console.log("=".repeat(72))
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) {
    console.log("  - " + f.label)
    if (f.ctx) console.log("    " + JSON.stringify(f.ctx))
  }
  process.exit(1)
}
process.exit(0)
