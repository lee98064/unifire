import { apiError } from '../../utils/api-error'
import { DAY, localDate, zonedInstant } from '../access-time'

export function reportMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  const start = new Date(month + '-01T00:00:00Z')
  if (start.getUTCFullYear() < 1970) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  const from = start.getTime()
  start.setUTCMonth(start.getUTCMonth() + 1)
  return { from, to: start.getTime() }
}

export function reportDays(from: number, to: number, timezone: string) {
  return Array.from({ length: (to - from) / DAY }, (_, index) => {
    const wall = from + index * DAY
    return { date: new Date(wall).toISOString().slice(0, 10), start: zonedInstant(wall, timezone) }
  })
}

export function usagePeriod(range: '7d' | '30d' | 'month', month: string | undefined, now: number, timezone: string) {
  const today = localDate(now, timezone)
  if (range === 'month') return reportMonth(month ?? new Date(today).toISOString().slice(0, 7))
  if (month !== undefined) reportMonth(month)
  return { from: today - (range === '7d' ? 6 : 29) * DAY, to: today + DAY }
}
