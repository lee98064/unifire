export function segment(value: string) {
  if (value === '.' || value === '..') throw new Error('Invalid path segment')
  return encodeURIComponent(value)
}

export function osPaths(site: string) {
  const name = segment(site)
  const prefix = '/proxy/network'
  return {
    login: '/api/auth/login',
    sites: `${prefix}/api/self/sites`,
    classic: (path: string) => `${prefix}/api/s/${name}/${path}`,
    v2: (path: string) => `${prefix}/v2/api/site/${name}/${path}`,
    stats: (path: string) => `${prefix}/v2/api/stats/${path}`,
    events: `${prefix}/wss/s/${name}/events`,
  }
}
