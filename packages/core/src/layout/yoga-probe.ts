/**
 * Dev-only probe for yoga-layout WASM OOB reproduction.
 *
 * Records create/free/measure-set events in a bounded ring buffer and captures
 * `memory access out of bounds` errors thrown from the WASM finalize callback.
 * Each exported function early-returns when not running under vite DEV, so prod
 * pays zero cost (no allocation, no listener).
 *
 * Reading site: CDP `Runtime.evaluate('globalThis.__YOGA_PROBE__')` exposes the
 * ring (`events`) and the oob capture (`oob`). The ptr field name on
 * `yoga-layout`'s `NodeImpl` is hard-coded to `_ptr` (the wrapAssembly binding).
 */

const RING_CAPACITY = 4096
const OOB_CAPACITY = 32
const RECENT_SNAPSHOT = 64

type YogaNodeLike = { _ptr?: unknown } & object

export interface ProbeEvent {
  t: number
  kind: 'create' | 'free' | 'measure-set'
  seq: number
  ptr: number | null
  nodeId?: string
}

export interface OobEvent {
  t: number
  message: string
  stack: string
  recentEvents: ProbeEvent[]
}

export interface YogaProbeState {
  events: ProbeEvent[]
  oob: OobEvent[]
}

const seqMap = new WeakMap<object, number>()
let nextSeq = 1

const events: ProbeEvent[] = []
const oob: OobEvent[] = []
let oobInstalled = false

declare global {
  interface Window {
    __YOGA_PROBE__?: YogaProbeState
  }
}

if (typeof globalThis !== 'undefined') {
  ;(globalThis as { __YOGA_PROBE__?: YogaProbeState }).__YOGA_PROBE__ = {
    events,
    oob
  }
}

function isDevMode(): boolean {
  return 'env' in import.meta && import.meta.env?.DEV === true
}

function extractPtr(node: object): number | null {
  const candidate = node as YogaNodeLike
  const ptr = candidate._ptr
  if (typeof ptr === 'number' && Number.isFinite(ptr)) return ptr
  return null
}

function record(event: ProbeEvent): void {
  if (events.length >= RING_CAPACITY) {
    events.shift()
  }
  events.push(event)
  if (events.length > RING_CAPACITY) {
    events.splice(0, events.length - RING_CAPACITY)
  }
}

function snapshotRecent(): ProbeEvent[] {
  const start = Math.max(0, events.length - RECENT_SNAPSHOT)
  return events.slice(start)
}

export function probeYogaEvent(kind: ProbeEvent['kind'], node: object, nodeId?: string): void {
  if (!isDevMode()) return
  recordYogaEvent(kind, node, nodeId)
}

// Same as probeYogaEvent but skips the DEV gate. Test-only entry point —
// keeps the public API prod-zero-cost while letting unit tests exercise the
// ring/seq logic without faking import.meta.env.DEV.
export function recordYogaEvent(kind: ProbeEvent['kind'], node: object, nodeId?: string): void {
  let seq = seqMap.get(node)
  if (seq === undefined) {
    seq = nextSeq++
    seqMap.set(node, seq)
  }
  record({
    t: performance.now(),
    kind,
    seq,
    ptr: extractPtr(node),
    nodeId
  })
}

export function installYogaOobCapture(): void {
  if (!isDevMode()) return
  if (typeof window === 'undefined') return
  if (oobInstalled) return
  oobInstalled = true

  window.addEventListener('error', handleWindowError)
}

// Exposed for tests; production wires the listener via installYogaOobCapture.
// Splitting the handler lets the test exercise message filtering without
// touching window listeners.
export function handleWindowError(event: { message?: string; error?: { stack?: string } }): void {
  const message = event.message ?? ''
  if (!message.includes('memory access out of bounds')) return
  const error = event.error as { stack?: string } | undefined
  if (oob.length >= OOB_CAPACITY) {
    oob.shift()
  }
  oob.push({
    t: performance.now(),
    message,
    stack: error?.stack ?? '',
    recentEvents: snapshotRecent()
  })
  if (oob.length > OOB_CAPACITY) {
    oob.splice(0, oob.length - OOB_CAPACITY)
  }
}

export function resetYogaProbe(): void {
  events.length = 0
  oob.length = 0
}
