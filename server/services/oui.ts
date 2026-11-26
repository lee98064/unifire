export const oui = {
  '00:1c:b3': 'Apple',
  '00:16:32': 'Samsung',
  '3c:5a:b4': 'Google',
  '00:0e:58': 'Sonos',
  '00:11:32': 'Synology',
  'b8:27:eb': 'Raspberry Pi',
  '24:0a:c4': 'Espressif',
  '78:8a:20': 'Ubiquiti',
  '00:09:bf': 'Nintendo',
  '00:01:4a': 'Sony',
  '00:1c:62': 'LG',
  '64:09:80': 'Xiaomi',
  '00:1b:21': 'Intel',
} as const

export function macVendor(mac: string, reported?: string | null) {
  const randomizedMac = (Number.parseInt(mac.slice(0, 2), 16) & 2) !== 0
  const vendor = randomizedMac ? null : (reported?.trim() || (oui as Record<string, string>)[mac.slice(0, 8)] || null)
  return { randomizedMac, vendor }
}
