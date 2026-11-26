/**
 * Pure schedule helpers shared by UI and server.
 * Grid convention: grid[day][hour], day 0 = Monday … 6 = Sunday, hour 0–23, in an IANA timezone.
 * A null cell means "use the route's default egress".
 */

export type Grid = (string | null)[][]

export interface RotationGeneratorInput {
  pinned: { hour: number, egressId: string }[]
  cycle: string[]
  continuity: 'daily-reset' | 'continuous'
  days: number[]
}

export function emptyGrid(fill: string | null = null): Grid {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => fill))
}

export function cloneGrid(g: Grid): Grid {
  return g.map(row => [...row])
}

/**
 * Fill a grid from a rotation generator.
 * With `pinned: [{hour:0, egressId: WAN1}]`, `cycle: [A,B,C,B,D,A,E]`, `daily-reset`
 * this reproduces the go-gost `selected_exit()` exactly: hour 0 → WAN1, hour h≥1 → cycle[(h-1) % 7].
 */
export function generateGrid(gen: RotationGeneratorInput, base?: Grid): Grid {
  const grid = base ? cloneGrid(base) : emptyGrid()
  if (!gen.cycle.length) return grid
  const pinned = new Map(gen.pinned.map(p => [p.hour, p.egressId]))
  const freePerDay = 24 - pinned.size
  for (const day of gen.days) {
    let idx = gen.continuity === 'continuous' ? day * freePerDay : 0
    for (let hour = 0; hour < 24; hour++) {
      const pin = pinned.get(hour)
      if (pin !== undefined) {
        grid[day]![hour] = pin
      }
      else {
        grid[day]![hour] = gen.cycle[idx % gen.cycle.length]!
        idx++
      }
    }
  }
  return grid
}

const partsCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string) {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    partsCache.set(tz, f)
  }
  return f
}
const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

/** Wall-clock weekday (0=Mon) / hour / minute / second of `ts` in `tz`. */
export function wallClock(ts: number, tz: string): { day: number, hour: number, minute: number, second: number } {
  const parts = formatter(tz).formatToParts(ts)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0'
  return { day: WEEKDAYS[get('weekday')] ?? 0, hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')) }
}

/** Egress scheduled at `ts` (null if the cell is empty → caller falls back to default). */
export function cellAt(grid: Grid, ts: number, tz: string): string | null {
  const { day, hour } = wallClock(ts, tz)
  return grid[day]?.[hour] ?? null
}

/** Start of the wall-clock hour containing `ts` (epoch ms), DST-safe enough for hourly grids. */
export function hourStart(ts: number, tz: string): number {
  const { minute, second } = wallClock(ts, tz)
  return ts - (minute * 60 + second) * 1000 - (ts % 1000)
}

export interface Segment { start: number, end: number, egressId: string, fromSchedule: boolean }

/**
 * Expand a grid into contiguous segments between `from` and `to` (epoch ms).
 * Empty cells resolve to `defaultEgressId` with fromSchedule=false.
 */
export function segments(grid: Grid | null, defaultEgressId: string, from: number, to: number, tz: string): Segment[] {
  const out: Segment[] = []
  let cursor = from
  let t = hourStart(from, tz)
  while (cursor < to) {
    const next = Math.min(to, t + 3_600_000)
    const cell = grid ? cellAt(grid, t, tz) : null
    const egressId = cell ?? defaultEgressId
    const fromSchedule = cell != null
    const last = out.at(-1)
    if (last && last.egressId === egressId && last.fromSchedule === fromSchedule) last.end = next
    else out.push({ start: cursor, end: next, egressId, fromSchedule })
    cursor = next
    t += 3_600_000
  }
  return out
}

/** Next instant after `ts` where the scheduled egress differs from the current one (within `horizonH`). */
export function nextChange(grid: Grid | null, defaultEgressId: string, ts: number, tz: string, horizonH = 24 * 8): { at: number, egressId: string } | null {
  if (!grid) return null
  const current = cellAt(grid, ts, tz) ?? defaultEgressId
  let t = hourStart(ts, tz) + 3_600_000
  for (let i = 0; i < horizonH; i++, t += 3_600_000) {
    const e = cellAt(grid, t, tz) ?? defaultEgressId
    if (e !== current) return { at: t, egressId: e }
  }
  return null
}

/** Count of distinct egresses used and hours per egress (for the editor legend). */
export function gridStats(grid: Grid, defaultEgressId: string | null): Map<string, number> {
  const m = new Map<string, number>()
  for (const row of grid) for (const c of row) {
    const k = c ?? defaultEgressId
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}
