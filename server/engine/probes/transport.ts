import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { SettingsT } from '#shared/schemas/system'
import type { ControllerService } from '../../services/controller'

type Method = SettingsT['probe']['method']
export interface ProbeTransport {
  attempt(ip: string, method: Method, egressId: string, at: number, attempt: number): Promise<number | null>
  supports(method: Method): Promise<boolean>
}

const TIMEOUT = 1_000

function tcp(ip: string, port: number) {
  return new Promise<number | null>(resolve => {
    const start = performance.now()
    const socket = connect({ host: ip, port })
    function finish(ok: boolean) {
      socket.destroy()
      resolve(ok ? performance.now() - start : null)
    }
    socket.setTimeout(TIMEOUT, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
  })
}

function dns(ip: string) {
  return new Promise<number | null>(resolve => {
    const id = randomInt(0x10000)
    // A recursive query for NS records at the DNS root.
    const request = Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1])
    request.writeUInt16BE(id)
    const socket = createSocket('udp4')
    const start = performance.now()
    let done = false
    const timer = setTimeout(() => finish(false), TIMEOUT)
    function finish(ok: boolean) {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      resolve(ok ? performance.now() - start : null)
    }
    socket.once('error', () => finish(false))
    socket.on('message', answer => {
      if (answer.length >= 12 && answer.readUInt16BE(0) === id && (answer[2]! & 0x80) && (answer[3]! & 0x0f) === 0) finish(true)
    })
    socket.connect(53, ip, () => socket.send(request, error => { if (error) finish(false) }))
  })
}

function ping(ip: string) {
  return new Promise<number | null>(resolve => {
    execFile('ping', ['-n', '-c', '1', '-W', '1', ip], { timeout: 1_200, maxBuffer: 4096 }, (error, stdout) => {
      const match = stdout.match(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/)
      resolve(!error && match ? Number(match[1]) : null)
    })
  })
}

export function realProbeTransport(): ProbeTransport {
  let icmp: Promise<boolean> | undefined
  return {
    async attempt(ip, method) {
      switch (method) {
        case 'tcp': return await tcp(ip, 443) ?? await tcp(ip, 53)
        case 'dns': return dns(ip)
        case 'icmp': return ping(ip)
      }
    },
    async supports(method) {
      if (method !== 'icmp') return true
      icmp ??= new Promise(resolve => {
        const child = execFile('ping', ['-V'], { timeout: TIMEOUT }, () => {})
        child.once('spawn', () => resolve(true))
        child.once('error', () => resolve(false))
      })
      return icmp
    },
  }
}

export function mockProbeTransport(probe: NonNullable<ControllerService['mockProbe']>): ProbeTransport {
  return {
    supports: async () => true,
    async attempt(_ip, _method, id, at, attempt) {
      const sample = probe(id, at)
      if (!sample?.up || sample.latencyMs === null) return null
      const salt = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0)
      if ((Math.floor(at / 1000) + salt * 13 + attempt * 17) % 113 === 0) return null
      return Math.max(1, sample.latencyMs + [-2, 0, 3][attempt % 3]!)
    },
  }
}
