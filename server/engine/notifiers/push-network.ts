import { lookup } from 'node:dns'
import { Agent } from 'node:https'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

function publicAddress(address: string) {
  return isIP(address) === 4 ? !blocked.check(address, 'ipv4')
    : globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function publicPushHost(host: string) {
  const address = host.replace(/^\[|\]$/g, '')
  return isIP(address) ? publicAddress(address) : host.includes('.')
}

// Members can register browser endpoints. Check the actual address selected for TLS,
// so a DNS change between subscription and delivery cannot send a request to the LAN.
export const pushAgent = new Agent({
  lookup(host, options, callback) {
    lookup(host, { ...options, all: true }, (error, records) => {
      if (error) return callback(error, '')
      const allowed = records.filter(record => publicAddress(record.address))
      const first = allowed[0]
      if (!first) return callback(new Error('Push endpoint has no public address'), '')
      if (options.all) return callback(null, allowed)
      callback(null, first.address, first.family)
    })
  },
})
