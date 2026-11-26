import { timingSafeEqual, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { connect, TLSSocket } from 'node:tls'
import { buildConnector } from 'undici'
import type { CertificateInfoT, ControllerInputT } from '#shared/schemas/controller'
import { UnifiError } from './errors'

type Trust = Pick<ControllerInputT, 'verifyMode' | 'fingerprint' | 'caPem'>
export const CONNECT_TIMEOUT = 5000

export function controllerUrl(value: string, allowLocalHttp = false): URL {
  const url = new URL(value)
  const allowed = url.protocol === 'https:' || (allowLocalHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1')
  if (!allowed || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new UnifiError('UNIFI_INVALID_URL')
  }
  return url
}

export function normalizeFingerprint(value?: string) {
  return value?.trim().replaceAll(':', '').toUpperCase() ?? ''
}

export function makeConnector(trust: Trust, onConnect?: (address?: string) => void) {
  const { verifyMode } = trust
  const fingerprint = normalizeFingerprint(trust.fingerprint)
  if (verifyMode === 'fingerprint' && !/^[\dA-F]{64}$/.test(fingerprint)) {
    throw new UnifiError('UNIFI_INVALID_FINGERPRINT')
  }
  if (verifyMode === 'ca' && !trust.caPem?.trim()) throw new UnifiError('UNIFI_CA_REQUIRED')

  const pin = Buffer.from(fingerprint, 'hex')
  const connectSocket = buildConnector({
    rejectUnauthorized: verifyMode === 'ca',
    ca: verifyMode === 'ca' ? trust.caPem : undefined,
    timeout: CONNECT_TIMEOUT, allowH2: false,
    // A resumed session need not include its peer certificate.
    maxCachedSessions: 0,
  })
  const connector: typeof connectSocket = (options, callback) => {
    const hostname = options.hostname.replace(/^\[|\]$/g, '')
    const servername = options.servername ?? (isIP(hostname) ? undefined : hostname)
    connectSocket({ ...options, hostname, servername }, (error, socket) => {
      if (error) return callback(error, null)
      if (!socket) return callback(new UnifiError('UNIFI_UNREACHABLE'), null)
      if (verifyMode === 'fingerprint') {
        const peer = socket instanceof TLSSocket ? socket.getPeerCertificate().fingerprint256 : undefined
        const actual = Buffer.from(normalizeFingerprint(peer), 'hex')
        if (actual.length !== pin.length || !timingSafeEqual(actual, pin)) {
          socket.destroy()
          return callback(new UnifiError('UNIFI_FINGERPRINT_MISMATCH'), null)
        }
      }
      onConnect?.(socket.localAddress?.replace(/^::ffff:/, ''))
      callback(null, socket)
    })
  }
  return connector
}

export async function inspectCertificate(value: string): Promise<CertificateInfoT> {
  const url = controllerUrl(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve, reject) => {
    const socket = connect({
      host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    })
    const timeout = setTimeout(() => socket.destroy(new UnifiError('UNIFI_TIMEOUT')), CONNECT_TIMEOUT)
    socket.once('close', () => clearTimeout(timeout))
    socket.once('error', error => reject(error instanceof UnifiError ? error : new UnifiError('UNIFI_TLS', undefined, { cause: error })))
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerX509Certificate()
        if (!(peer instanceof X509Certificate)) throw new UnifiError('UNIFI_TLS')
        resolve({
          fingerprint: peer.fingerprint256,
          subject: peer.subject,
          issuer: peer.issuer,
          validFrom: peer.validFrom,
          validTo: peer.validTo,
          selfSigned: peer.checkIssued(peer) && peer.verify(peer.publicKey),
          altNames: (peer.subjectAltName?.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/g) ?? []).map(name => name.trim()),
        })
      } catch {
        reject(new UnifiError('UNIFI_TLS'))
      } finally {
        socket.destroy()
      }
    })
  })
}
