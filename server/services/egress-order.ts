type Orderable = { id: string, kind: string, wanGroup: string | null }

/** UniFi's wan_networkgroup: "WAN" is WAN1, then "WAN2", "WAN3", … */
function wanNumber(group: string | null) {
  const match = /^WAN(\d*)$/i.exec(group ?? '')
  return match ? Number(match[1] || 1) : Number.MAX_SAFE_INTEGER
}

/** Display order: WANs first as WAN1, WAN2, WAN3…, then VPN clients; UniFi id keeps the order stable. */
export function compareEgresses(a: Orderable, b: Orderable) {
  return Number(b.kind === 'wan') - Number(a.kind === 'wan')
    || (a.kind === 'wan' && b.kind === 'wan' ? wanNumber(a.wanGroup) - wanNumber(b.wanGroup) : 0)
    || a.id.localeCompare(b.id, 'en', { numeric: true })
}
