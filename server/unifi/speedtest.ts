import { Doc } from './endpoints/schemas'
import type { UnifiEndpoints } from './endpoints'
import { isUnsupported, UnifiError } from './errors'

export type SpeedtestReading = {
  ts: number | null
  wan: string | null
  downMbps: number
  upMbps: number
  latencyMs: number | null
}

function number(value: unknown) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function timestamp(value: unknown) {
  const numeric = number(value)
  const millis = numeric === null ? (typeof value === 'string' ? Date.parse(value) : NaN)
    : numeric < 1e11 ? numeric * 1000 : numeric
  return Number.isSafeInteger(millis) && millis > 0 ? millis : null
}

export function parseSpeedtest(payload: unknown) {
  let available = false
  let running = false
  const results: SpeedtestReading[] = []
  function read(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) read(item)
      return
    }
    const row = Doc.safeParse(value).data
    if (!row) return
    const state = row.status ?? row.speedtest_status
    const pending = row['speedtest-pending-interfaces']
    const isRunning = row.running === true || row.in_progress === true || Array.isArray(pending) && pending.length > 0
      || typeof state === 'string' && /^(running|pending|in[ _-]?progress|starting|download|upload)$/i.test(state)
    const knownState = typeof state === 'string'
      && /^(idle|finished|completed|success|succeeded|failed|error|not.running)$/i.test(state)
    const widget = row.speed_test ?? row.speedtest
    const widgetData = Doc.safeParse(widget).data?.data
    if (isRunning || knownState || typeof row.running === 'boolean' || Array.isArray(pending)
      || Array.isArray(widget) || Array.isArray(widgetData)) available = true
    running ||= isRunning
    const downMbps = number(row.download_mbps ?? row.xput_download ?? row.xput_down)
    const upMbps = number(row.upload_mbps ?? row.xput_upload ?? row.xput_up)
    if (downMbps !== null && upMbps !== null && !isRunning && !/^(error|failed)$/i.test(String(state ?? ''))) {
      const wan = row.network_id ?? row.wan_networkgroup ?? row.wan ?? row.interface
      results.push({ ts: timestamp(row.timestamp ?? row.rundate ?? row.time ?? row.ts), wan: typeof wan === 'string' ? wan : null,
        downMbps, upMbps, latencyMs: number(row.latency_ms ?? row.latency ?? row.ping_ms) })
      available = true
    }
    for (const field of ['data', 'last', 'result', 'speed_test', 'speedtest', 'speedtest-status', 'uplink']) {
      if (row[field] !== undefined) read(row[field])
    }
  }
  read(payload)
  return { available, running, results }
}

export async function readSpeedtest(api: UnifiEndpoints) {
  // A successful command can return an empty array when the firmware serves status elsewhere.
  const sources = [api.speedtestStatus, api.speedtestWidget, api.gateway] as const
  let available = false
  let running = false
  let failure: unknown
  for (const load of sources) {
    try {
      const reading = parseSpeedtest(await load())
      available ||= reading.available
      running ||= reading.running
      if (reading.results.length) return { available, running, results: reading.results }
    } catch (error) {
      if (!isUnsupported(error) && !(error instanceof UnifiError && error.code === 'UNIFI_INVALID_RESPONSE')) failure = error
    }
  }
  if (!available && failure) throw failure
  return { available, running, results: [] as SpeedtestReading[] }
}
