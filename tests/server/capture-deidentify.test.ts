import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDeidentifier } from '../../scripts/capture-deidentify'
import { captureWire, readOnlyTransport } from '../../scripts/capture-wire'
import { createUnifiTransport } from '../../server/unifi/client'
import { startMockController } from '../../server/unifi/mock'
import { SELF_MAC } from '../../server/unifi/mock/fixtures'

describe('wire capture de-identification', () => {
  it('joins MACs, private /24s, public IPs and normalized IPv6 inside rows and strings', () => {
    const scrub = createDeidentifier()
    expect(scrub.value({
      mac: 'A4:22:BB:44:55:6F', ip: '192.168.42.17', wan: '8.8.8.8', v6: 'FE80:0:0:0:0:0:0:1',
      clients: [{ mac: 'a4-22-bb-44-55-6f', ip: '192.168.42.18', other: '192.168.43.17' }],
      'A4:22:BB:44:55:6F': 'via a4:22:bb:44:55:6f, 192.168.42.17/24 and 8.8.8.8:53',
      addresses: 'http://[fe80::1%25eth0]:8443 via ::ffff:1.2.3.4 and [::1].',
      colonGroups: 'aa:bb:cc:dd:ee:ff:aa:bb',
    })).toEqual({
      mac: '02:00:00:00:00:01', ip: '10.0.0.17', wan: '203.0.113.1', v6: '2001:db8::1',
      clients: [{ mac: '02:00:00:00:00:01', ip: '10.0.0.18', other: '10.0.1.17' }],
      '02:00:00:00:00:01': 'via 02:00:00:00:00:01, 10.0.0.17/24 and 203.0.113.1:53',
      addresses: 'http://[2001:db8::1]:8443 via 2001:db8::2 and [2001:db8::3].',
      colonGroups: '2001:db8::4',
    })
  })

  it('maps names, hostnames and IDs across separate resources and preserves technical fields', () => {
    const scrub = createDeidentifier()
    expect(scrub.value({ name: 'Office AP', essid: 'Home', _id: 'unique-ap-id', hostname: 'console.local' }))
      .toEqual({ name: 'name-1', essid: 'essid-2', _id: 'id-1', hostname: 'hostname-3' })
    expect(scrub.value({
      last_uplink: { uplink_device_name: 'Office AP' }, displayName: 'Office AP', ssid: 'Home', wlan: 'Home',
      ap_id: 'unique-ap-id', device_name: 'Pat’s Laptop', note: null,
      url: 'https://console.local:443/control', hosts: ['*.CONSOLE.local', 'ryan-lab.cc', 'pat@ryan-lab.cc'],
      model: 'U7-Pro', model_name: 'UniFi U7 Pro', shortname: 'U7 Pro', type: 'uap',
      version: '7.1.2.3', console_display_version: '6.0.17', board_rev: 4, cpu: '0.7', num_sta: 3,
    })).toEqual({
      last_uplink: { uplink_device_name: 'uplink_device_name-1' }, displayName: 'displayName-1', ssid: 'ssid-2', wlan: 'wlan-2',
      ap_id: 'id-1', device_name: 'device_name-4', note: null,
      url: 'https://host-1.example:443/control', hosts: ['*.host-1.example', 'host-2.example', '<redacted>@host-2.example'],
      model: 'U7-Pro', model_name: 'UniFi U7 Pro', shortname: 'U7 Pro', type: 'uap',
      version: '7.1.2.3', console_display_version: '6.0.17', board_rev: 4, cpu: '0.7', num_sta: 3,
    })
  })

  it('drops x_ fields and retains sensitive keys with redacted values at any depth', () => {
    const scrub = createDeidentifier()
    const sensitive = Object.fromEntries([
      'password', 'secret', 'token', 'psk', 'privateKey', 'authMode', 'Cookie', 'serialNumber',
      'license', 'anon_id', 'device_id', 'sshPort', 'fingerprint', 'anonymous_controller_id',
    ].map(key => [key, 'private']))
    expect(scrub.value({ x_system: 'private', data: [{ nested: { X_private: 'private', ...sensitive } }], key: 'EVT_WU_Roam' }))
      .toEqual({ data: [{ nested: Object.fromEntries(Object.keys(sensitive).map(key => [key, '<redacted>'])) }], key: '<redacted>' })
  })

  it('scrubs names in free-text messages and keeps pseudonymous address references', () => {
    const scrub = createDeidentifier()
    expect(scrub.value({
      msg: 'Pat’s Laptop (A4:22:BB:44:55:6F:) roamed via http://workbench:8880.',
      url: 'http://workbench/path',
    })).toEqual({ msg: 'msg-1 02:00:00:00:00:01: host-1.example', url: 'http://host-1.example/path' })
  })

  it('skips a pseudonym when it equals the source address', () => {
    const scrub = createDeidentifier()
    expect(scrub.value(['02:00:00:00:00:01', '10.0.0.1', '203.0.113.1', '2001:db8::1']))
      .toEqual(['02:00:00:00:00:02', '10.0.1.1', '203.0.113.2', '2001:db8::2'])
  })
})

describe('wire collector', () => {
  it('blocks all explicit writes and GETs outside the capture allowlist before login', async () => {
    const mock = await startMockController()
    const transport = createUnifiTransport(mock.config, { mock: true })
    try {
      const reader = readOnlyTransport(transport)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(() => reader.request(method, reader.paths.classic('rest/device'))).toThrow('UNIFI_CAPTURE_READ_ONLY')
      }
      expect(() => reader.request('GET', reader.paths.classic('cmd/devmgr'))).toThrow('UNIFI_CAPTURE_READ_ONLY')
      expect(() => reader.request('POST', reader.paths.login)).toThrow('UNIFI_CAPTURE_READ_ONLY')
      expect(mock.loginAttempts).toBe(0)
      expect(mock.mutationCount).toBe(0)
    } finally {
      await transport.close()
      await mock.close()
    }
  })

  it('captures pinned HTTPS and WSS with one mapping, bounded client samples and independent probe failures', async () => {
    const tls = {
      key: readFileSync(new URL('./fixtures/wp2-test-key.pem', import.meta.url)),
      cert: readFileSync(new URL('./fixtures/wp2-test-cert.pem', import.meta.url)),
    }
    const mock = await startMockController({ tls })
    const fingerprint = new X509Certificate(tls.cert).fingerprint256
    const transport = createUnifiTransport({ ...mock.config, verifyMode: 'fingerprint', fingerprint })
    mock.injectFailure('GET', mock.paths.classic('stat/health'), '403')
    const timer = setInterval(() => {
      mock.emit('sta:sync', [{ mac: SELF_MAC, name: 'Unifire demo host' }])
      mock.emit('events', [{ key: 'EVT_WU_Roam', user: SELF_MAC }, { key: 'EVT_WU_RoamRadio', detail: 'ap.local' }])
    }, 40)
    try {
      const result = await captureWire(transport, { site: mock.config.site, networkVersion: null, seconds: 1, maxClients: 2 })
      expect(result).toMatchObject({ networkVersion: '11.0.104', site: expect.stringMatching(/^site-\d+$/), summary: [
        { type: 'udm', model: 'UDMPRO' }, { type: 'usw', model: 'USPM16P', portCount: 18, poePorts: 16 },
        { type: 'usw', model: 'USWED35' }, { type: 'uap', model: 'U7PRO' },
        { type: 'udm', model: 'UDMA69B' }, { type: 'uap', model: 'U6M' },
      ] })
      expect(result.resources['stat/health']).toEqual({ ok: false, status: 403, error: 'UNIFI_FORBIDDEN' })
      for (const key of ['v2/device', 'v2/devices']) expect(result.resources[key]).toMatchObject({ ok: false, status: 404 })
      expect(Object.keys(result.resources).filter(key => key.startsWith('stat/device/'))).toHaveLength(3)
      const switchMac = result.summary.find(device => device.model === 'USWED35')?.pseudoMac
      const stations = result.resources['stat/sta']
      expect(stations).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ sw_mac: switchMac })]) })
      for (const key of ['stat/sta', 'v2/clients/active?includeTrafficUsage=true&includeUnifiDevices=true']) {
        const resource = result.resources[key]
        expect(resource?.ok).toBe(true)
        const rows = resource?.ok ? resource.data as { is_wired: boolean }[] : []
        expect(rows.map(row => row.is_wired).sort()).toEqual([false, false, true, true])
      }
      const wlan = result.resources['rest/wlanconf']
      expect(wlan?.ok && Array.isArray(wlan.data) ? Object.keys(wlan.data[0]).sort() : []).toEqual([
        '_id', 'enabled', 'is_guest', 'name', 'networkconf_id',
      ])
      const kinds = result.ws.kinds
      expect(kinds['sta:sync']?.count).toBeGreaterThan(3)
      expect(kinds['sta:sync']?.samples).toHaveLength(3)
      const events = kinds.events?.eventKeys
      expect(events?.EVT_WU_Roam?.count).toBe(kinds.events?.count)
      expect(events?.EVT_WU_Roam?.samples[0]).toEqual({
        key: '<redacted>', user: expect.stringMatching(/^02:00:00:00:/),
      })
      expect(events?.EVT_WU_RoamRadio?.samples[0]).toEqual({ key: '<redacted>', detail: expect.stringMatching(/^host-\d+\.example$/) })
      expect(JSON.stringify(result)).not.toContain(SELF_MAC)
      expect(mock.loginAttempts).toBe(1)
      expect(mock.mutationCount).toBe(0)
    } finally {
      clearInterval(timer)
      await transport.close()
      await mock.close()
    }
  })
})
