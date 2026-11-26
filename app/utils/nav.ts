export interface NavItem {
  key: string
  to: string
  icon: string
  /** i18n key */
  label: string
  badge?: 'approvals' | 'requests'
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
    { key: 'clients', to: '/clients', icon: 'i-lucide-monitor-smartphone', label: 'nav.clients' },
    { key: 'people', to: '/people', icon: 'i-lucide-users', label: 'nav.people', badge: 'requests' },
    { key: 'approvals', to: '/approvals', icon: 'i-lucide-shield-check', label: 'nav.approvals', badge: 'approvals' },
    { key: 'quotas', to: '/quotas', icon: 'i-lucide-hourglass', label: 'nav.quotas' },
  ],
  [
    { key: 'rules', to: '/automation/rules', icon: 'i-lucide-workflow', label: 'nav.rules' },
    { key: 'watchdogs', to: '/automation/watchdogs', icon: 'i-lucide-plug-zap', label: 'nav.watchdogs' },
    { key: 'guest-wifi', to: '/automation/guest-wifi', icon: 'i-lucide-qr-code', label: 'nav.guestWifi' },
    { key: 'wol', to: '/automation/wol', icon: 'i-lucide-power', label: 'nav.wol' },
  ],
  [
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

export const navGroupLabels = ['', 'nav.group.routing', 'nav.group.access', 'nav.group.automation', 'nav.group.insight']
