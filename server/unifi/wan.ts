import { Doc, type WireDevice, type WireDoc } from './endpoints/schemas'

const wanKey = (value: unknown) => typeof value === 'string' ? value.toLowerCase().replace(/^wan$/, 'wan1') : null
export function wanTelemetry(gateway: WireDevice | null | undefined, group: string | null) {
  const key = wanKey(group)
  if (!gateway || !key || !/^wan\d+$/.test(key)) return null
  const wan = Doc.safeParse(gateway[key]).data
  const uplink = Doc.safeParse(gateway.uplink).data
  const table = Array.isArray(gateway.uplink_table) ? gateway.uplink_table : []
  const records = [...table.map(value => Doc.safeParse(value).data), uplink].filter((record): record is WireDoc => !!record)
  const match = records.find(record => [record.wan_networkgroup, record.wan, record.name].some(value => wanKey(value) === key)
    || typeof wan?.ifname === 'string' && wan.ifname === (record.ifname ?? record.name)
    || typeof wan?.port_idx === 'number' && wan.port_idx === record.port_idx)
  return wan || match ? { ...match, ...wan } : null
}

export function bytesPerSecondToBps(value: unknown) {
  const bytes = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof bytes === 'number' && Number.isFinite(bytes * 8) && bytes >= 0 ? bytes * 8 : null
}

export function wanRates(doc: WireDoc | null | undefined) {
  return { rxBps: bytesPerSecondToBps(doc?.['rx_bytes-r']), txBps: bytesPerSecondToBps(doc?.['tx_bytes-r']) }
}

export function gatewayRates(device: WireDevice, groups: (string | null)[]) {
  const rates = groups.map(group => wanRates(wanTelemetry(device, group)))
  if (rates.length && rates.every(row => row.rxBps !== null && row.txBps !== null)) {
    return rates.reduce<{ rxBps: number, txBps: number }>((total, row) => ({ rxBps: total.rxBps + row.rxBps!, txBps: total.txBps + row.txBps! }),
      { rxBps: 0, txBps: 0 })
  }
  const uplink = Doc.safeParse(device.uplink).data
  const aggregate = wanRates(device)
  return aggregate.rxBps !== null && aggregate.txBps !== null ? aggregate : groups.length <= 1 ? wanRates(uplink) : aggregate
}

function statusOf(value: WireDoc | null | undefined) {
  if (!value) return null
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : null
  if (value.up === false || value.is_up === false || value.reachable === false || value.is_reachable === false
    || status && ['down', 'error', 'offline', 'disconnected', 'failed'].includes(status)) return false
  if (value.up === true || value.is_up === true || value.reachable === true || value.is_reachable === true
    || status && ['ok', 'up', 'healthy', 'connected', 'online'].includes(status)) return true
  return null
}

export function wanStatus(gateway: WireDevice | null, records: WireDoc[], group: string | null) {
  const key = wanKey(group)
  if (!key || !/^wan\d+$/.test(key)) return null
  const reports = records.filter(record => [record.subsystem, record.wan_networkgroup, record.wan]
    .some(value => wanKey(value) === key))
  const statuses = [statusOf(wanTelemetry(gateway, group)), ...reports.map(statusOf)]
  return statuses.includes(false) ? false : statuses.includes(true) ? true : null
}
