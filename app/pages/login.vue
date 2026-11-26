<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const { t } = useI18n()
const route = useRoute()
const { fetch: refreshSession, user } = useUserSession()
const { authenticate } = useWebAuthn({ authenticateEndpoint: '/api/auth/webauthn/authenticate' })
const state = reactive({ username: '', password: '' })
const loading = ref(false)
const passkeyLoading = ref(false)
const error = ref<string | null>(null)
const showPw = ref(false)

async function done() {
  await refreshSession()
  const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : null
  await navigateTo(next ?? (user.value?.role === 'admin' ? '/' : '/me'))
}

async function submit() {
  error.value = null
  loading.value = true
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: state })
    await done()
  }
  catch (e) {
    const info = apiErrorInfo(e)
    error.value = info.status === 429 ? t('login.rateLimited') : t('login.invalid')
  }
  finally { loading.value = false }
}

async function passkey() {
  error.value = null
  passkeyLoading.value = true
  try {
    await authenticate(state.username || undefined)
    await done()
  }
  catch { error.value = t('login.passkeyFailed') }
  finally { passkeyLoading.value = false }
}
</script>

<template>
  <div class="w-full max-w-[400px]">
    <div class="flex flex-col items-center mb-7">
      <AppLogo :size="52" />
      <h1 class="mt-4 text-2xl font-semibold tracking-tight text-highlighted">{{ t('login.title') }}</h1>
      <p class="mt-1.5 text-[13px] text-muted">{{ t('login.subtitle') }}</p>
    </div>

    <div class="uf-card shadow-(--uf-shadow-lg) p-6 sm:p-7">
      <form class="space-y-4" @submit.prevent="submit">
        <UFormField :label="t('login.username')" name="username">
          <UInput v-model="state.username" autocomplete="username webauthn" size="lg" class="w-full" icon="i-lucide-user-round" autofocus />
        </UFormField>
        <UFormField :label="t('login.password')" name="password">
          <UInput v-model="state.password" :type="showPw ? 'text' : 'password'" autocomplete="current-password" size="lg" class="w-full" icon="i-lucide-key-round">
            <template #trailing>
              <UButton color="neutral" variant="link" size="sm" :icon="showPw ? 'i-lucide-eye-off' : 'i-lucide-eye'" :aria-label="t('login.togglePassword')" @click="showPw = !showPw" />
            </template>
          </UInput>
        </UFormField>

        <Transition enter-from-class="opacity-0 -translate-y-1" enter-active-class="transition duration-200">
          <div v-if="error" class="flex items-center gap-2 text-[13px] text-error bg-error/8 ring-1 ring-error/20 rounded-md px-3 py-2">
            <UIcon name="i-lucide-circle-alert" class="size-4 shrink-0" />{{ error }}
          </div>
        </Transition>

        <UButton type="submit" block size="lg" :loading="loading" :disabled="!state.username || !state.password">{{ t('login.submit') }}</UButton>
      </form>

      <div class="flex items-center gap-3 my-5">
        <div class="flex-1 border-t border-(--ui-border-muted)" />
        <span class="text-[11px] uppercase tracking-wider text-dimmed">{{ t('common.or') }}</span>
        <div class="flex-1 border-t border-(--ui-border-muted)" />
      </div>

      <UButton block size="lg" color="neutral" variant="outline" icon="i-lucide-fingerprint" :loading="passkeyLoading" @click="passkey">
        {{ t('login.passkey') }}
      </UButton>
    </div>

    <p class="mt-6 text-center text-[12px] text-dimmed">Unifire · {{ useRuntimeConfig().public.appVersion }}</p>
  </div>
</template>
