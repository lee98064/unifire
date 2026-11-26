import { Cron } from 'croner'
import { Settings, SettingsInput, type SettingsT } from '#shared/schemas/system'
import { useDb } from '../db'
import { settings } from '../db/schema'
import { apiError } from '../utils/api-error'

const defaults: SettingsT = {
  timezone: 'Asia/Taipei',
  siteUrl: null,
  probe: {
    intervalSec: 30,
    ipPool: [
      '9.9.9.9', '149.112.112.112', '8.8.8.8', '8.8.4.4',
      '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15',
      '185.222.222.222', '45.11.45.11', '76.76.2.0', '76.76.10.0',
      // dns0.eu (193.110.81.0, 185.253.5.0) shut down in 2025; DNS4EU (86.54.11.1) is EU-only and slow elsewhere.
      '194.242.2.2', '9.9.9.10', '149.112.112.10', '185.228.168.9',
    ],
    sweepIntervalMin: 60,
    method: 'tcp',
    failThreshold: 3,
  },
  approval: { mode: 'notify', matchRandomizedByHostname: true },
  presence: { graceMinutes: 10 },
  usage: { activeThresholdBytes: 51200, retainRawDays: 14 },
  snapshots: { cron: '0 3 * * *', retainDays: 90, preWrite: true },
  broadcastOverrides: {},
  selfMacOverride: null,
  excludedRouteIds: [],
}

export function validateTimezone(timezone: string) {
  try {
    if (/^[+-]/.test(timezone)) throw new Error('Expected a named time zone')
    new Intl.DateTimeFormat('en', { timeZone: timezone })
  } catch {
    throw apiError(400, 'INVALID_TIMEZONE', 'errors.invalidTimezone')
  }
}

const settingsKeys = Settings.keyof().options
const settingsKey = Settings.keyof()

export function createSettingsService(db = useDb()) {
  function get(): SettingsT {
    const values = Object.fromEntries(db.select().from(settings).all().filter(
      row => settingsKey.safeParse(row.key).success,
    ).map(row => [row.key, row.value]))
    return Settings.parse({ ...defaults, ...values })
  }

  function patch(input: Partial<SettingsT>): SettingsT {
    const changes = SettingsInput.parse(input)
    if (changes.timezone !== undefined) validateTimezone(changes.timezone)
    if (changes.snapshots?.cron) {
      try { new Cron(changes.snapshots.cron, { paused: true, timezone: changes.timezone ?? get().timezone }).stop() }
      catch { throw apiError(400, 'INVALID_SNAPSHOT_CRON', 'errors.invalidSnapshotCron') }
    }
    const rows = settingsKeys.flatMap(key => {
      const value = changes[key]
      return value === undefined ? [] : [{ key, value }]
    })
    return db.transaction(() => {
      for (const row of rows) {
        db.insert(settings).values(row)
          .onConflictDoUpdate({ target: settings.key, set: { value: row.value } }).run()
      }
      return get()
    })
  }

  return { get, patch }
}
