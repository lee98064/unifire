import type { QuotaT } from '#shared/schemas/access'
import type { WeeklyWindowT } from '#shared/schemas/common'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const formatters = new Map<string, Intl.DateTimeFormat>()
export function localEpoch(at: number, timezone: string) {
  let format = formatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
      hourCycle: 'h23',
    })
    formatters.set(timezone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, Number(part.value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour, parts.minute)
}

// Wall-clock dates are represented on a UTC calendar for arithmetic only.
export function localDate(at: number, timezone: string) {
  return Math.floor(localEpoch(at, timezone) / DAY) * DAY
}

export function weekday(date: number) {
  return (new Date(date).getUTCDay() + 6) % 7
}

export function zonedInstant(wall: number, timezone: string, end = false) {
  const offsets = new Set([wall - DAY, wall, wall + DAY].map(at => localEpoch(at, timezone) - at))
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b)
  const matching = candidates.filter(at => localEpoch(at, timezone) === wall)
  // In a gap, shift forward by the gap. In an overlap, cover both occurrences for bedtime.
  return (end ? matching.at(-1) : matching[0]) ?? candidates.at(-1)!
}

export function quotaPeriod(at: number, timezone: string, period: QuotaT['period']) {
  const date = localDate(at, timezone)
  const day = weekday(date)
  const calendar = new Date(date)
  let start = date
  let end = date + DAY
  if (period === 'weekly') {
    start = date - day * DAY
    end = start + 7 * DAY
  } else if (period === 'monthly') {
    start = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), 1)
    end = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 1)
  }
  return { start: zonedInstant(start, timezone), end: zonedInstant(end, timezone), day }
}

function clockMinutes(hhmm: string) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
}

export function bedtimeWindows(windows: WeeklyWindowT[], at: number, timezone: string, daysAhead = 0) {
  const date = localDate(at, timezone)
  const result: { start: number, end: number }[] = []
  for (let offset = -1; offset <= daysAhead; offset++) {
    const day = date + offset * DAY
    for (const window of windows) {
      if (!window.enabled || !window.days.includes(weekday(day))) continue
      const start = clockMinutes(window.start)
      const end = clockMinutes(window.end)
      if (end === start) continue
      const entry = {
        start: zonedInstant(day + start * MINUTE, timezone),
        end: zonedInstant(day + (end < start ? DAY : 0) + end * MINUTE, timezone, true),
      }
      if (entry.end > Math.max(at, entry.start)) result.push(entry)
    }
  }
  return result.sort((left, right) => left.start - right.start)
}
