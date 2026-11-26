<script setup lang="ts">
import type { AuditEventT, AuditCategoryT } from '#shared/schemas/insight'

const { t } = useI18n()
const fmt = useFormat()
const category = ref<AuditCategoryT | null>(null)
const actor = ref<string | null>(null)
const qInput = ref('')
const q = refDebounced(qInput, 300)

const items = ref<AuditEventT[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const done = ref(false)
async function load(reset = false) {
  if (loading.value || (done.value && !reset)) return
  loading.value = true
  try {
    const res = await $fetch<{ items: AuditEventT[], nextCursor: string | null }>('/api/audit', {
      query: { category: category.value ?? undefined, actor: actor.value ?? undefined, q: q.value || undefined, cursor: reset ? undefined : cursor.value ?? undefined, limit: 50 },
    })
    items.value = reset ? res.items : [...items.value, ...res.items]
    cursor.value = res.nextCursor
    done.value = !res.nextCursor
  }
  finally { loading.value = false }
}
watch([category, actor, q], () => { done.value = false; load(true) }, { immediate: true })
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(sentinel, ([e]) => { if (e?.isIntersecting) load() })
useLive().on('audit', (ev) => {
  if ((!category.value || ev.category === category.value) && (!actor.value || ev.actor.type === actor.value) && !q.value) items.value = [ev, ...items.value]
})

const grouped = computed(() => {
  const out: { day: string, events: AuditEventT[] }[] = []
  for (const ev of items.value) {
    const day = fmt.date(ev.ts)
    const last = out.at(-1)
    if (last?.day === day) last.events.push(ev)
    else out.push({ day, events: [ev] })
  }
  return out
})
const categories: AuditCategoryT[] = ['route', 'egress', 'client', 'approval', 'quota', 'pause', 'config', 'rule', 'poe', 'wifi', 'wol', 'snapshot', 'auth', 'system']
const actors = ['unifire', 'user', 'external', 'unifi-log', 'rule', 'system']
</script>

<template>
  <div>
    <PageHeader :title="t('nav.audit')" :description="t('audit.desc')" icon="i-lucide-scroll-text" />

    <div class="uf-card p-3 mb-4 space-y-3">
      <div class="flex flex-col sm:flex-row gap-2">
        <UInput v-model="qInput" icon="i-lucide-search" :placeholder="t('audit.search')" class="sm:w-72" size="sm" />
        <div class="flex gap-1 flex-wrap">
          <button
            v-for="a in actors"
            :key="a"
            type="button"
            class="h-8 px-3 rounded-full text-[12px] font-medium ring-1 transition"
            :class="actor === a ? 'bg-primary/10 text-primary ring-primary/30' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'"
            @click="actor = actor === a ? null : a"
          >{{ t(`audit.actor.${a}`) }}</button>
        </div>
      </div>
      <div class="flex gap-1 flex-wrap">
        <button
          v-for="c in categories"
          :key="c"
          type="button"
          class="h-7 px-2.5 rounded-md text-[12px] transition"
          :class="category === c ? 'bg-(--ui-bg-inverted) text-(--ui-text-inverted)' : 'text-toned hover:bg-(--uf-hover)'"
          @click="category = category === c ? null : c"
        >{{ t(`audit.category.${c}`) }}</button>
      </div>
    </div>

    <div class="space-y-6">
      <section v-for="g in grouped" :key="g.day">
        <div class="sticky top-14 z-10 py-2 uf-glass -mx-1 px-1"><span class="uf-section-title">{{ g.day }}</span></div>
        <div class="uf-card divide-y divide-(--ui-border-muted)">
          <div v-for="ev in g.events" :key="ev.id" class="px-4 py-3.5 flex gap-3">
            <span class="text-[11.5px] text-dimmed uf-num w-11 shrink-0 pt-1.5">{{ fmt.time(ev.ts) }}</span>
            <AuditItem :event="ev" class="flex-1" />
          </div>
        </div>
      </section>
      <div ref="sentinel" class="h-10 flex items-center justify-center">
        <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-5 text-dimmed animate-spin" />
        <span v-else-if="done && items.length" class="text-[12px] text-dimmed">{{ t('audit.end') }}</span>
      </div>
      <div v-if="done && !items.length" class="uf-card"><EmptyState icon="i-lucide-scroll-text" :title="t('audit.empty')" /></div>
    </div>
  </div>
</template>
