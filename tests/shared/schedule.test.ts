import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { cellAt, generateGrid, nextChange, segments, wallClock } from '../../shared/utils/schedule'

const ref = JSON.parse(readFileSync(new URL('../../docs/reference-egress-schedule.json', import.meta.url), 'utf8'))

/** Port of go-gost selected_exit() */
function selectedExit(hour: number): string {
  if (hour === 0) return ref.midnight.id
  const cycle = ref.vpn_cycle
  return cycle[(hour - 1) % cycle.length].id
}

describe('schedule', () => {
  const grid = generateGrid({
    pinned: [{ hour: 0, egressId: ref.midnight.id }],
    cycle: ref.vpn_cycle.map((e: { id: string }) => e.id),
    continuity: 'daily-reset',
    days: [0, 1, 2, 3, 4, 5, 6],
  })

  it('reproduces go-gost selected_exit() for all 24 hours on every day', () => {
    for (let d = 0; d < 7; d++)
      for (let h = 0; h < 24; h++) expect(grid[d]![h]).toBe(selectedExit(h))
  })

  it('evaluates in Asia/Taipei wall clock', () => {
    // 2026-11-25T17:30:00+08:00 is a Wednesday (day 2), hour 17 → IEM slot in the user's table
    const ts = Date.parse('2026-11-25T09:30:00Z')
    expect(wallClock(ts, 'Asia/Taipei')).toMatchObject({ day: 2, hour: 17, minute: 30 })
    expect(cellAt(grid, ts, 'Asia/Taipei')).toBe(selectedExit(17))
  })

  it('finds the next change at the top of the hour', () => {
    const ts = Date.parse('2026-11-25T09:30:00Z')
    const n = nextChange(grid, 'default', ts, 'Asia/Taipei')
    expect(n?.at).toBe(Date.parse('2026-11-25T10:00:00Z'))
    expect(n?.egressId).toBe(selectedExit(18))
  })

  it('merges equal adjacent hours into segments and falls back to default', () => {
    const g = generateGrid({ pinned: [], cycle: ['a'], continuity: 'daily-reset', days: [0] })
    const from = Date.parse('2026-11-22T16:00:00Z') // Mon 00:00 Taipei
    const segs = segments(g, 'def', from, from + 48 * 3600_000, 'Asia/Taipei')
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ egressId: 'a', fromSchedule: true, end: from + 24 * 3600_000 })
    expect(segs[1]).toMatchObject({ egressId: 'def', fromSchedule: false })
  })
})
