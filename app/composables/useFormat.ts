/** Locale-aware formatting helpers (bytes, rates, durations, times in the site timezone). */
export function useFormat() {
  const { locale, t } = useI18n()
  const tz = useState<string>('site-tz', () => 'Asia/Taipei')
  const intlLocale = computed(() => (locale.value === 'zh-TW' ? 'zh-Hant-TW' : 'en-US'))

  // Decimal (SI) units like UniFi and ISP data caps: 1 GB = 10^9 bytes. Quota editors use the same factor.
  function bytes(n: number | null | undefined, digits = 1): string {
    if (n == null || Number.isNaN(n)) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    let v = Math.abs(n)
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
    return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
  }

  function bps(n: number | null | undefined): string {
    if (n == null) return '—'
    const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
    let i = 0
    let v = n
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
  }

  function ms(n: number | null | undefined): string {
    if (n == null) return '—'
    return n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n)} ms`
  }

  function pct(n: number | null | undefined, digits = 0): string {
    if (n == null) return '—'
    return `${n.toFixed(digits)}%`
  }

  /** "1 小時 20 分" / "1h 20m" */
  function minutes(total: number | null | undefined): string {
    if (total == null) return '—'
    const m = Math.round(total)
    const h = Math.floor(m / 60)
    const r = m % 60
    if (h && r) return t('fmt.hm', { h, m: r })
    if (h) return t('fmt.h', { h })
    return t('fmt.m', { m: r })
  }

  function duration(msTotal: number): string {
    return minutes(msTotal / 60000)
  }

  function time(ts: number | null | undefined, opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }): string {
    if (ts == null) return '—'
    return new Intl.DateTimeFormat(intlLocale.value, { timeZone: tz.value, ...opts }).format(ts)
  }

  function dateTime(ts: number | null | undefined): string {
    return time(ts, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  }

  function date(ts: number | null | undefined): string {
    return time(ts, { year: 'numeric', month: 'numeric', day: 'numeric' })
  }

  const rtf = computed(() => new Intl.RelativeTimeFormat(intlLocale.value, { numeric: 'auto', style: 'short' }))
  function ago(ts: number | null | undefined, now = Date.now()): string {
    if (ts == null) return '—'
    const diff = (ts - now) / 1000
    const abs = Math.abs(diff)
    if (abs < 45) return t('fmt.justNow')
    if (abs < 3600) return rtf.value.format(Math.round(diff / 60), 'minute')
    if (abs < 86400) return rtf.value.format(Math.round(diff / 3600), 'hour')
    return rtf.value.format(Math.round(diff / 86400), 'day')
  }

  /** "in 23 min" for future timestamps, short. */
  function until(ts: number | null | undefined, now = Date.now()): string {
    if (ts == null) return '—'
    return ago(ts, now)
  }

  /** Weekday short label, 0 = Monday. */
  function weekday(i: number, style: 'short' | 'narrow' | 'long' = 'short'): string {
    // 2024-01-01 was a Monday.
    return new Intl.DateTimeFormat(intlLocale.value, { weekday: style, timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + i))
  }

  return { tz, intlLocale, bytes, bps, ms, pct, minutes, duration, time, dateTime, date, ago, until, weekday }
}
