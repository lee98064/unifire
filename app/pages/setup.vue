<script setup lang="ts">
import type { SetupStatusT } from '#shared/schemas/auth'
import type { CertificateInfoT, ControllerStatusT, ControllerInputT } from '#shared/schemas/controller'

definePageMeta({ layout: 'auth' })

const { t } = useI18n()
const api = useApi()
const setup = useState<SetupStatusT | null>('setup-status')
const { fetch: refreshSession, loggedIn } = useUserSession()

type Step = 'admin' | 'controller' | 'review' | 'done'
const steps: { key: Step, icon: string }[] = [
  { key: 'admin', icon: 'i-lucide-user-round-plus' },
  { key: 'controller', icon: 'i-lucide-router' },
  { key: 'review', icon: 'i-lucide-list-checks' },
  { key: 'done', icon: 'i-lucide-party-popper' },
]
const step = ref<Step>(setup.value?.needsAdmin ? 'admin' : 'controller')
const stepIndex = computed(() => steps.findIndex(s => s.key === step.value))

async function reloadStatus() {
  setup.value = await $fetch<SetupStatusT>('/api/setup/status')
}

/* ── Step 1: admin ── */
const admin = reactive({ username: 'admin', displayName: '', password: '', confirm: '' })
const adminBusy = ref(false)
const adminValid = computed(() => admin.username.length >= 2 && admin.displayName && admin.password.length >= 8 && admin.password === admin.confirm)
async function createAdmin() {
  adminBusy.value = true
  try {
    await api.post('/api/setup/admin', { username: admin.username, displayName: admin.displayName, password: admin.password, locale: useI18n().locale.value })
    await refreshSession()
    await reloadStatus()
    step.value = setup.value?.mock ? 'review' : 'controller'
    if (setup.value?.mock) await runTest(true)
  }
  finally { adminBusy.value = false }
}

/* ── Step 2: controller ── */
const ctl = reactive<ControllerInputT>({ url: 'https://192.168.1.1', username: 'unifire', password: '', site: 'default', verifyMode: 'fingerprint', fingerprint: undefined, caPem: undefined })
const cert = ref<CertificateInfoT | null>(null)
const certTrusted = ref(false)
const inspecting = ref(false)
async function inspect() {
  inspecting.value = true
  cert.value = null
  certTrusted.value = false
  try { cert.value = await api.post<CertificateInfoT>('/api/setup/controller/inspect', { url: ctl.url }) }
  finally { inspecting.value = false }
}
function trust() {
  if (!cert.value) return
  ctl.fingerprint = cert.value.fingerprint
  certTrusted.value = true
}

const testing = ref(false)
const result = ref<ControllerStatusT | null>(null)
async function runTest(mock = false) {
  testing.value = true
  result.value = null
  try {
    result.value = mock
      ? await api.post<ControllerStatusT>('/api/controller/probe')
      : await api.post<ControllerStatusT>('/api/setup/controller/test', ctl)
    step.value = 'review'
  }
  finally { testing.value = false }
}
const canTest = computed(() => ctl.url && ctl.username && ctl.password && (ctl.verifyMode !== 'fingerprint' || certTrusted.value) && (ctl.verifyMode !== 'ca' || ctl.caPem))

/* ── Step 3: save ── */
const saving = ref(false)
async function save() {
  saving.value = true
  try {
    if (!setup.value?.mock) await api.put('/api/controller', ctl)
    await reloadStatus()
    step.value = 'done'
  }
  finally { saving.value = false }
}

const capLabels = computed(() => Object.fromEntries((result.value?.capabilities ?? []).map(c => [c.key, t(`caps.k.${c.key}`)])) as Record<string, string>)

onMounted(async () => {
  if (!setup.value) await reloadStatus()
  if (!setup.value?.needsAdmin && !loggedIn.value) await navigateTo('/login')
})
</script>

<template>
  <div class="w-full max-w-[640px]">
    <div class="flex items-center justify-center gap-3 mb-6">
      <AppLogo :size="40" />
      <div>
        <div class="text-lg font-semibold tracking-tight text-highlighted">{{ t('setup.title') }}</div>
        <div class="text-[12.5px] text-muted">{{ t('setup.subtitle') }}</div>
      </div>
    </div>

    <!-- Stepper -->
    <ol class="flex items-center mb-6 px-2">
      <li v-for="(s, i) in steps" :key="s.key" class="flex items-center" :class="i < steps.length - 1 ? 'flex-1' : ''">
        <div class="flex flex-col items-center gap-1.5">
          <span
            class="size-9 rounded-full flex items-center justify-center ring-1 transition-all duration-300"
            :class="i < stepIndex ? 'bg-success text-white ring-success' : i === stepIndex ? 'bg-primary text-white ring-primary shadow-(--uf-glow)' : 'bg-(--uf-surface) text-dimmed ring-(--ui-border)'"
          >
            <UIcon :name="i < stepIndex ? 'i-lucide-check' : s.icon" class="size-4" />
          </span>
          <span class="text-[11.5px] font-medium" :class="i <= stepIndex ? 'text-highlighted' : 'text-dimmed'">{{ t(`setup.steps.${s.key}`) }}</span>
        </div>
        <div v-if="i < steps.length - 1" class="flex-1 h-px mx-2 -mt-5 transition-colors" :class="i < stepIndex ? 'bg-success' : 'bg-(--ui-border)'" />
      </li>
    </ol>

    <div class="uf-card shadow-(--uf-shadow-lg) p-6 sm:p-7">
      <!-- 1. Admin -->
      <form v-if="step === 'admin'" class="space-y-4" @submit.prevent="createAdmin">
        <div>
          <h2 class="text-base font-semibold text-highlighted">{{ t('setup.admin.title') }}</h2>
          <p class="text-[13px] text-muted mt-1">{{ t('setup.admin.desc') }}</p>
        </div>
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField :label="t('login.username')"><UInput v-model="admin.username" class="w-full" autocomplete="username" /></UFormField>
          <UFormField :label="t('setup.admin.displayName')"><UInput v-model="admin.displayName" class="w-full" :placeholder="t('setup.admin.displayNamePh')" /></UFormField>
          <UFormField :label="t('login.password')" :hint="t('setup.admin.pwHint')"><UInput v-model="admin.password" type="password" class="w-full" autocomplete="new-password" /></UFormField>
          <UFormField :label="t('setup.admin.confirm')" :error="admin.confirm && admin.confirm !== admin.password ? t('setup.admin.mismatch') : undefined">
            <UInput v-model="admin.confirm" type="password" class="w-full" autocomplete="new-password" />
          </UFormField>
        </div>
        <div class="flex justify-end pt-2">
          <UButton type="submit" size="lg" trailing-icon="i-lucide-arrow-right" :disabled="!adminValid" :loading="adminBusy">{{ t('common.continue') }}</UButton>
        </div>
      </form>

      <!-- 2. Controller -->
      <div v-else-if="step === 'controller'" class="space-y-5">
        <div>
          <h2 class="text-base font-semibold text-highlighted">{{ t('setup.controller.title') }}</h2>
          <p class="text-[13px] text-muted mt-1">{{ t('setup.controller.desc') }}</p>
        </div>

        <UAlert color="info" variant="subtle" icon="i-lucide-info" :title="t('setup.controller.accountTip')" :description="t('setup.controller.accountTipBody')" />

        <UFormField :label="t('setup.controller.url')" :hint="t('setup.controller.urlHint')">
          <div class="flex gap-2">
            <UInput v-model="ctl.url" class="flex-1" icon="i-lucide-link" placeholder="https://192.168.1.1" @update:model-value="certTrusted = false; cert = null" />
            <UButton v-if="ctl.verifyMode === 'fingerprint'" color="neutral" variant="outline" icon="i-lucide-shield-question" :loading="inspecting" @click="inspect">{{ t('setup.controller.inspect') }}</UButton>
          </div>
        </UFormField>

        <!-- TOFU certificate card -->
        <Transition enter-from-class="opacity-0 scale-[0.98]" enter-active-class="transition duration-200">
          <div v-if="cert" class="rounded-lg ring-1 p-4 space-y-3" :class="certTrusted ? 'ring-success/40 bg-success/5' : 'ring-warning/40 bg-warning/5'">
            <div class="flex items-center gap-2">
              <UIcon :name="certTrusted ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'" class="size-5" :class="certTrusted ? 'text-success' : 'text-warning'" />
              <span class="text-sm font-semibold text-highlighted">{{ certTrusted ? t('setup.controller.certTrusted') : t('setup.controller.certVerify') }}</span>
              <UBadge v-if="cert.selfSigned" color="neutral" variant="subtle" size="sm">{{ t('setup.controller.selfSigned') }}</UBadge>
            </div>
            <dl class="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
              <dt class="text-dimmed">{{ t('setup.controller.subject') }}</dt><dd class="text-toned truncate">{{ cert.subject }}</dd>
              <dt class="text-dimmed">{{ t('setup.controller.validTo') }}</dt><dd class="text-toned">{{ cert.validTo }}</dd>
              <dt class="text-dimmed">SHA-256</dt><dd class="uf-mono text-highlighted break-all leading-relaxed">{{ cert.fingerprint }}</dd>
            </dl>
            <p v-if="!certTrusted" class="text-[12px] text-muted">{{ t('setup.controller.certCompare') }}</p>
            <UButton v-if="!certTrusted" size="sm" color="warning" icon="i-lucide-check" @click="trust">{{ t('setup.controller.trust') }}</UButton>
          </div>
        </Transition>

        <div class="grid sm:grid-cols-3 gap-4">
          <UFormField :label="t('login.username')"><UInput v-model="ctl.username" class="w-full" autocomplete="off" /></UFormField>
          <UFormField :label="t('login.password')"><UInput v-model="ctl.password" type="password" class="w-full" autocomplete="new-password" /></UFormField>
          <UFormField :label="t('setup.controller.site')"><UInput v-model="ctl.site" class="w-full" /></UFormField>
        </div>

        <UCollapsible>
          <UButton color="neutral" variant="link" size="sm" trailing-icon="i-lucide-chevron-down" class="px-0">{{ t('setup.controller.advanced') }}</UButton>
          <template #content>
            <div class="pt-3 space-y-3">
              <UFormField :label="t('setup.controller.verifyMode')">
                <URadioGroup
                  v-model="ctl.verifyMode"
                  orientation="horizontal"
                  :items="[
                    { value: 'fingerprint', label: t('setup.controller.vmFingerprint') },
                    { value: 'ca', label: t('setup.controller.vmCa') },
                    { value: 'insecure', label: t('setup.controller.vmInsecure') },
                  ]"
                />
              </UFormField>
              <UFormField v-if="ctl.verifyMode === 'ca'" :label="t('setup.controller.caPem')">
                <UTextarea v-model="ctl.caPem" :rows="5" class="w-full uf-mono" placeholder="-----BEGIN CERTIFICATE-----" />
              </UFormField>
              <UAlert v-if="ctl.verifyMode === 'insecure'" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="t('setup.controller.insecureWarn')" />
            </div>
          </template>
        </UCollapsible>

        <div class="flex justify-between items-center pt-2">
          <span class="text-[12px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-lock" class="size-3.5" />{{ t('setup.controller.encrypted') }}</span>
          <UButton size="lg" icon="i-lucide-plug-zap" :disabled="!canTest" :loading="testing" @click="runTest()">{{ t('setup.controller.test') }}</UButton>
        </div>
      </div>

      <!-- 3. Review -->
      <div v-else-if="step === 'review'" class="space-y-5">
        <div class="flex items-start gap-3">
          <span class="size-10 rounded-full flex items-center justify-center" :class="result?.connected ? 'bg-success/12 text-success' : 'bg-error/12 text-error'">
            <UIcon :name="result?.connected ? 'i-lucide-plug' : 'i-lucide-unplug'" class="size-5" />
          </span>
          <div class="flex-1 min-w-0">
            <h2 class="text-base font-semibold text-highlighted">{{ result?.connected ? t('setup.review.connected') : t('setup.review.failed') }}</h2>
            <p class="text-[13px] text-muted mt-0.5">
              <template v-if="result?.connected">{{ result.model }} · Network {{ result.networkVersion }} · UniFi OS {{ result.consoleVersion }}</template>
              <template v-else>{{ result?.lastError }}</template>
            </p>
          </div>
          <UBadge v-if="result?.mock" color="secondary" variant="subtle" icon="i-lucide-flask-conical">{{ t('topbar.mock') }}</UBadge>
        </div>

        <div v-if="result?.connected" class="grid grid-cols-2 gap-3">
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="uf-section-title">{{ t('setup.review.selfHost') }}</div>
            <div class="mt-1.5 text-sm text-highlighted uf-mono">{{ result.selfIp ?? '—' }}</div>
            <div class="text-[12px] text-dimmed uf-mono">{{ result.selfMac ?? t('setup.review.selfNotFound') }}</div>
          </div>
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="uf-section-title">{{ t('setup.review.mode') }}</div>
            <div class="mt-1.5 flex items-center gap-1.5 text-sm font-medium" :class="result.mode === 'dry-run' ? 'text-warning' : 'text-success'">
              <UIcon :name="result.mode === 'dry-run' ? 'i-lucide-shield-alert' : 'i-lucide-zap'" class="size-4" />
              {{ result.mode === 'dry-run' ? t('topbar.dryRun') : t('settings.controller.live') }}
            </div>
            <div class="text-[12px] text-dimmed">{{ result.mode === 'dry-run' ? t('setup.review.dryRunNote') : '' }}</div>
          </div>
        </div>

        <div v-if="result">
          <div class="uf-section-title mb-2">{{ t('setup.review.capabilities') }}</div>
          <CapabilityMatrix :caps="result.capabilities" :labels="capLabels" />
        </div>

        <div class="flex justify-between pt-2">
          <UButton v-if="!result?.mock" color="neutral" variant="ghost" icon="i-lucide-arrow-left" @click="step = 'controller'">{{ t('common.back') }}</UButton>
          <span v-else />
          <UButton size="lg" trailing-icon="i-lucide-arrow-right" :disabled="!result?.connected" :loading="saving" @click="save">{{ t('setup.review.save') }}</UButton>
        </div>
      </div>

      <!-- 4. Done -->
      <div v-else class="text-center py-6">
        <div class="relative mx-auto size-16 mb-5">
          <div class="absolute inset-0 rounded-full bg-success/25 blur-xl" />
          <div class="relative size-16 rounded-full bg-success text-white flex items-center justify-center"><UIcon name="i-lucide-check" class="size-8" /></div>
        </div>
        <h2 class="text-lg font-semibold text-highlighted">{{ t('setup.done.title') }}</h2>
        <p class="text-[13px] text-muted mt-1.5 max-w-sm mx-auto">{{ t('setup.done.desc') }}</p>
        <div class="mt-6 grid sm:grid-cols-3 gap-2 text-left">
          <NuxtLink to="/egresses" class="uf-card uf-card-hover p-3"><UIcon name="i-lucide-radar" class="size-5 text-primary" /><div class="mt-2 text-[13px] font-medium text-highlighted">{{ t('setup.done.next1') }}</div></NuxtLink>
          <NuxtLink to="/routes" class="uf-card uf-card-hover p-3"><UIcon name="i-lucide-calendar-clock" class="size-5 text-vpn" /><div class="mt-2 text-[13px] font-medium text-highlighted">{{ t('setup.done.next2') }}</div></NuxtLink>
          <NuxtLink to="/people" class="uf-card uf-card-hover p-3"><UIcon name="i-lucide-users" class="size-5 text-success" /><div class="mt-2 text-[13px] font-medium text-highlighted">{{ t('setup.done.next3') }}</div></NuxtLink>
        </div>
        <UButton class="mt-6" size="lg" to="/" trailing-icon="i-lucide-arrow-right">{{ t('setup.done.go') }}</UButton>
      </div>
    </div>
  </div>
</template>
