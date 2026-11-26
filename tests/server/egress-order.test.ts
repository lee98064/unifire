import { describe, expect, it } from 'vitest'
import { compareEgresses } from '../../server/services/egress-order'

describe('egress order', () => {
  it('lists WAN1, WAN2, WAN3 first regardless of UniFi id, then VPN clients by id', () => {
    const rows = [
      { id: 'a1', kind: 'wireguard', wanGroup: null },
      { id: 'b2', kind: 'wan', wanGroup: 'WAN3' },
      { id: 'c3', kind: 'wan', wanGroup: 'WAN' },
      { id: 'a0', kind: 'openvpn', wanGroup: null },
      { id: 'd4', kind: 'wan', wanGroup: 'WAN2' },
    ]
    expect([...rows].sort(compareEgresses).map(row => row.wanGroup ?? row.id)).toEqual(['WAN', 'WAN2', 'WAN3', 'a0', 'a1'])
  })
})
