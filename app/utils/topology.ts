import type { TopologyEdgeT, TopologyNodeT, TopologyT } from '#shared/schemas/infra'

export type Overlay = 'traffic' | 'poe' | 'health' | 'people'

export const COL_W = 270
export const ROW_H = 92

/**
 * Left → right tidy tree: egress nodes in column 0, the gateway in column 1, then one column per
 * uplink hop; client groups hang one column right of their device. Leaves get consecutive rows and
 * parents are centred on their children, so cables never cross.
 */
export function layoutTopology(topo: Pick<TopologyT, 'nodes'>): Map<string, { x: number, y: number }> {
  const pos = new Map<string, { x: number, y: number }>()
  const children = new Map<string, TopologyNodeT[]>()
  const egress: TopologyNodeT[] = []
  const roots: TopologyNodeT[] = []
  for (const n of topo.nodes) {
    if (n.kind === 'egress') { egress.push(n); continue }
    if (!n.parentId || !topo.nodes.some(m => m.id === n.parentId)) { roots.push(n); continue }
    const list = children.get(n.parentId) ?? []
    list.push(n)
    children.set(n.parentId, list)
  }
  // devices first, client groups last, then by label — keeps switches above the client fan-out
  const order = (a: TopologyNodeT, b: TopologyNodeT) =>
    Number(a.kind === 'client_group') - Number(b.kind === 'client_group') || a.label.localeCompare(b.label)
  let row = 0
  function place(n: TopologyNodeT, depth: number): number {
    const kids = (children.get(n.id) ?? []).sort(order)
    let y: number
    if (!kids.length) y = row++ * ROW_H
    else {
      const ys = kids.map(k => place(k, depth + 1))
      y = (ys[0]! + ys.at(-1)!) / 2
    }
    pos.set(n.id, { x: depth * COL_W, y })
    return y
  }
  for (const r of roots.sort(order)) {
    place(r, 1)
    row += 0.5
  }
  // egress column centred on the gateway(s)
  const gw = roots.find(r => r.kind === 'gateway') ?? roots[0]
  const cy = gw ? pos.get(gw.id)!.y : 0
  const eh = ROW_H * 0.72
  egress.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).forEach((e, i) => {
    pos.set(e.id, { x: 0, y: cy + (i - (egress.length - 1) / 2) * eh })
  })
  return pos
}

/** Utilisation → colour ramp used on cables. */
export function utilColor(pct: number | null | undefined): string {
  if (pct == null) return 'var(--ui-text-dimmed)'
  if (pct >= 80) return 'var(--color-ufred-500)'
  if (pct >= 50) return 'var(--color-ufamber-500)'
  return 'var(--color-ufgreen-500)'
}

/** How many packets to animate on a cable: log scale of the throughput, 0 when idle. */
export function packetCount(e: Pick<TopologyEdgeT, 'downBps' | 'upBps'>): number {
  const bps = Math.max(e.downBps ?? 0, e.upBps ?? 0)
  if (bps < 50_000) return 0
  return Math.min(4, Math.max(1, Math.round(Math.log10(bps) - 4)))
}
