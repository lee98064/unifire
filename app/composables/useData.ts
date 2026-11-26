import type { EgressT } from '#shared/schemas/egress'
import type { ControllerStatusT } from '#shared/schemas/controller'
import type { PersonT, ApprovalItemT, ExtensionRequestT } from '#shared/schemas/access'
import type { NetworkT } from '~/utils/types'

/** Shared egress list (WAN + VPN clients) — used by chips, pickers and the schedule editor. */
export function useEgresses() {
  const res = useFetch<EgressT[]>('/api/egresses', { key: 'egresses', default: () => [], dedupe: 'defer' })
  const byId = computed(() => new Map(res.data.value.map(e => [e.id, e])))
  const get = (id: string | null | undefined) => (id ? byId.value.get(id) : undefined)
  const wans = computed(() => res.data.value.filter(e => e.kind === 'wan'))
  const vpns = computed(() => res.data.value.filter(e => e.kind !== 'wan'))
  return { ...res, egresses: res.data, byId, get, wans, vpns }
}

export function useControllerStatus() {
  const { loggedIn, user } = useUserSession()
  const res = useFetch<ControllerStatusT | null>('/api/controller', {
    key: 'controller-status',
    default: () => null,
    immediate: loggedIn.value && user.value?.role === 'admin',
    dedupe: 'defer',
  })
  const isDryRun = computed(() => res.data.value?.mode === 'dry-run')
  const isMock = computed(() => !!res.data.value?.mock)
  return { ...res, status: res.data, isDryRun, isMock }
}

export function usePeople() {
  const res = useFetch<PersonT[]>('/api/people', { key: 'people', default: () => [], dedupe: 'defer' })
  const byId = computed(() => new Map(res.data.value.map(p => [p.id, p])))
  return { ...res, people: res.data, byId, get: (id: string | null | undefined) => (id ? byId.value.get(id) : undefined) }
}

export function useNetworks() {
  const res = useFetch<NetworkT[]>('/api/networks', { key: 'networks', default: () => [], dedupe: 'defer' })
  const byId = computed(() => new Map(res.data.value.map(n => [n.id, n])))
  return { ...res, networks: res.data, byId }
}

/** Counts shown as nav badges. */
export function useBadges() {
  const approvals = useFetch<ApprovalItemT[]>('/api/approvals', { key: 'approvals', default: () => [], dedupe: 'defer' })
  const requests = useFetch<ExtensionRequestT[]>('/api/extension-requests', { key: 'extension-requests', query: { status: 'pending' }, default: () => [], dedupe: 'defer' })
  return {
    approvals: computed(() => approvals.data.value.length),
    requests: computed(() => requests.data.value.filter(r => r.status === 'pending').length),
  }
}
