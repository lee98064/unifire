import type { SetupStatusT } from '#shared/schemas/auth'

const PUBLIC = [/^\/login$/, /^\/setup$/, /^\/kiosk\//]
const MEMBER_ALLOWED = [/^\/me$/, /^\/account$/]

export default defineNuxtRouteMiddleware(async (to) => {
  const setup = useState<SetupStatusT | null>('setup-status', () => null)
  if (!setup.value) {
    setup.value = await $fetch<SetupStatusT>('/api/setup/status').catch(() => null)
  }
  if (to.path.startsWith('/kiosk/')) return

  if (setup.value?.needsAdmin) {
    return to.path === '/setup' ? undefined : navigateTo('/setup')
  }

  const { loggedIn, user, fetch: fetchSession } = useUserSession()
  if (!loggedIn.value) await fetchSession()
  if (!loggedIn.value) {
    return PUBLIC.some(r => r.test(to.path)) && to.path !== '/setup' ? undefined : navigateTo({ path: '/login', query: to.path !== '/' ? { next: to.fullPath } : undefined })
  }

  if (to.path === '/login') return navigateTo(user.value?.role === 'admin' ? '/' : '/me')

  if (user.value?.role === 'member') {
    return MEMBER_ALLOWED.some(r => r.test(to.path)) ? undefined : navigateTo('/me')
  }

  if (setup.value?.needsController && to.path !== '/setup' && !to.path.startsWith('/settings')) {
    return navigateTo('/setup')
  }
})
