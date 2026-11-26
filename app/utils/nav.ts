export interface NavItem {
  key: string
  to: string
  icon: string
  /** i18n key */
  label: string
  badge?: 'approvals' | 'requests' | 'incidents'
  children?: NavItem[]
}

/** Admin navigation, grouped like the UniFi Network sidebar. */
export const adminNav: NavItem[][] = [
  [
    { key: 'dashboard', to: '/', icon: 'i-lucide-layout-dashboard', label: 'nav.dashboard' },
  ],
  [
    { key: 'routes', to: '/routes', icon: 'i-lucide-waypoints', label: 'nav.routes' },
    { key: 'egresses', to: '/egresses', icon: 'i-lucide-globe', label: 'nav.egresses' },
  ],
  [
    { key: 'devices', to: '/devices', icon: 'i-lucide-server', label: 'nav.devices' },
    { key: 'topology', to: '/devices/topology', icon: 'i-lucide-network', label: 'nav.topology' },
    { key: 'poe', to: '/devices/poe', icon: 'i-lucide-zap', label: 'nav.poe' },
  ],
  [
    { key: 'clients', to: '/clients', icon: 'i-lucide-monitor-smartphone', label: 'nav.clients' },
    { key: 'people', to: '/people', icon: 'i-lucide-users', label: 'nav.people', badge: 'requests' },
    { key: 'approvals', to: '/approvals', icon: 'i-lucide-shield-check', label: 'nav.approvals', badge: 'approvals' },
    { key: 'quotas', to: '/quotas', icon: 'i-lucide-hourglass', label: 'nav.quotas' },
  ],
  [
    { key: 'rules', to: '/automation/rules', icon: 'i-lucide-workflow', label: 'nav.rules' },
    { key: 'guest-wifi', to: '/automation/guest-wifi', icon: 'i-lucide-qr-code', label: 'nav.guestWifi' },
    { key: 'wol', to: '/automation/wol', icon: 'i-lucide-power', label: 'nav.wol' },
  ],
  [
    { key: 'incidents', to: '/insight/incidents', icon: 'i-lucide-siren', label: 'nav.incidents', badge: 'incidents' },
    { key: 'snapshots', to: '/insight/snapshots', icon: 'i-lucide-history', label: 'nav.snapshots' },
    { key: 'audit', to: '/insight/audit', icon: 'i-lucide-scroll-text', label: 'nav.audit' },
    { key: 'reports', to: '/insight/reports', icon: 'i-lucide-chart-line', label: 'nav.reports' },
    { key: 'presence', to: '/insight/presence', icon: 'i-lucide-house', label: 'nav.presence' },
  ],
]

export const settingsNav: NavItem = { key: 'settings', to: '/settings', icon: 'i-lucide-settings', label: 'nav.settings' }

/** Mobile bottom bar (admin). The 5th item opens the "more" sheet. */
export const mobileTabs: NavItem[] = [
  { key: 'dashboard', to: '/', icon: 'i-lucide-layout-dashboard', label: 'nav.dashboard' },
  { key: 'routes', to: '/routes', icon: 'i-lucide-waypoints', label: 'nav.routesShort' },
  { key: 'people', to: '/people', icon: 'i-lucide-users', label: 'nav.people', badge: 'requests' },
  { key: 'approvals', to: '/approvals', icon: 'i-lucide-shield-check', label: 'nav.approvalsShort', badge: 'approvals' },
]

/** The nav target that best matches a path (longest prefix wins, so /devices/poe doesn't light up /devices). */
export function activeNavTo(path: string): string | null {
  const all = [...adminNav.flat(), settingsNav].map(i => i.to)
  const hits = all.filter(to => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)))
  return hits.sort((a, b) => b.length - a.length)[0] ?? null
}

export const navGroupLabels = ['', 'nav.group.routing', 'nav.group.infra', 'nav.group.access', 'nav.group.automation', 'nav.group.insight']
