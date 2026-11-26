import { Cron } from 'croner'
import { validateTimezone } from '../services/settings'
import { apiError } from '../utils/api-error'

export type CronSpec = { cron: string, timezone: string }

export function validateCron(spec: CronSpec) {
  validateTimezone(spec.timezone)
  try { new Cron(spec.cron, { timezone: spec.timezone, paused: true, unref: true }).stop() }
  catch { throw apiError(400, 'INVALID_AUTOMATION_CRON', 'errors.invalidAutomationCron') }
}

export function nextCron(spec: CronSpec, at: number) {
  const cron = new Cron(spec.cron, { timezone: spec.timezone, paused: true, unref: true })
  try { return cron.nextRun(new Date(at))?.getTime() ?? null } finally { cron.stop() }
}

export function createCronJobs() {
  const jobs = new Map<string, { spec: string, job: Cron }>()
  function remove(id: string) {
    jobs.get(id)?.job.stop()
    jobs.delete(id)
  }
  return {
    set(id: string, spec: CronSpec | null, work: () => Promise<unknown>) {
      if (!spec) return remove(id)
      const key = JSON.stringify([spec.timezone, spec.cron])
      if (jobs.get(id)?.spec === key) return
      remove(id)
      const job = new Cron(spec.cron, { timezone: spec.timezone, unref: true, protect: true },
        async () => { await work().catch(() => {}) })
      jobs.set(id, { spec: key, job })
    },
    stop() { for (const id of jobs.keys()) remove(id) },
  }
}
