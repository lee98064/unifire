import { z } from 'zod'

/** Epoch milliseconds. All timestamps in the API are epoch ms (number). */
export const Ts = z.number().int().nonnegative()

/** Lower-case colon-separated MAC, e.g. "bc:24:11:4a:01:14". */
export const Mac = z
  .string()
  .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, 'invalid MAC')

/** "HH:MM" 24h wall-clock time in the configured timezone. */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** ISO weekday index used everywhere: 0 = Monday … 6 = Sunday. */
export const Weekday = z.number().int().min(0).max(6)

export const Id = z.string().min(1)

export const Page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
})

export const Paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() })

export const Ok = z.object({ ok: z.literal(true) })

/** Standard error body produced by the API (via createError data). */
export const ApiError = z.object({
  statusCode: z.number(),
  message: z.string(),
  /** Machine-readable code, e.g. "UNIFI_UNREACHABLE", "ROUTE_NOT_OWNED", "DRY_RUN". */
  code: z.string().optional(),
  details: z.unknown().optional(),
})

/** A weekly time window, may cross midnight (start > end). */
export const WeeklyWindow = z.object({
  days: z.array(Weekday).min(1),
  start: HHMM,
  end: HHMM,
  enabled: z.boolean().default(true),
})

export type TsT = z.infer<typeof Ts>
export type MacT = z.infer<typeof Mac>
export type WeeklyWindowT = z.infer<typeof WeeklyWindow>
export type ApiErrorT = z.infer<typeof ApiError>
