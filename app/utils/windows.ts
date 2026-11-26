import type { WeeklyWindowT } from '#shared/schemas/common'
import { wallClock } from '#shared/utils/schedule'

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** Per-weekday segments (minutes from midnight, 0 = Monday) covered by the windows; crossing midnight spills into the next day. */
export function daySegments(windows: WeeklyWindowT[]): { start: number, end: number }[][] {
  const days: { start: number, end: number }[][] = Array.from({ length: 7 }, () => [])
  for (const w of windows) {
    if (!w.enabled) continue
    const s = mins(w.start)
    const e = mins(w.end)
    if (s === e) continue
    for (const d of w.days) {
      if (s < e) days[d]!.push({ start: s, end: e })
      else {
        days[d]!.push({ start: s, end: 1440 })
        days[(d + 1) % 7]!.push({ start: 0, end: e })
      }
    }
  }
  return days.map(segs => merge(segs))
}

function merge(segs: { start: number, end: number }[]) {
  const sorted = [...segs].sort((a, b) => a.start - b.start)
  const out: { start: number, end: number }[] = []
  for (const s of sorted) {
    const last = out.at(-1)
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

export function hoursPerWeek(windows: WeeklyWindowT[]) {
  return daySegments(windows).flat().reduce((sum, s) => sum + (s.end - s.start), 0) / 60
}

export function inWindows(windows: WeeklyWindowT[], ts: number, tz: string) {
  const c = wallClock(ts, tz)
  const m = c.hour * 60 + c.minute
  return daySegments(windows)[c.day]!.some(s => m >= s.start && m < s.end)
}

/** Off intervals in [from, from + hours) sampled at 5-min resolution in the given timezone. */
export function upcomingWindows(windows: WeeklyWindowT[], tz: string, from = Date.now(), hours = 48) {
  const step = 5 * 60_000
  const start = Math.floor(from / step) * step
  const out: { start: number, end: number }[] = []
  let open: number | null = null
  for (let ts = start; ts <= start + hours * 3_600_000; ts += step) {
    const off = inWindows(windows, ts, tz)
    if (off && open == null) open = ts
    if (!off && open != null) { out.push({ start: open, end: ts }); open = null }
  }
  if (open != null) out.push({ start: open, end: start + hours * 3_600_000 })
  return out
}
