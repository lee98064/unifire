import { z } from 'zod'
import type { H3Event } from 'h3'
import { Id } from '#shared/schemas/common'
import { readApiBody, readApiParams } from './api-error'

export function accessId(event: H3Event) {
  return readApiParams(event, z.object({ id: Id })).then(params => params.id)
}

export function readAccessPatch<T extends object>(event: H3Event, schema: z.ZodType<T>) {
  // A Zod partial still materializes defaults for omitted fields. Preserve PATCH semantics.
  return readApiBody(event, z.record(z.string(), z.unknown()).transform((input, ctx) => {
    const result = schema.safeParse(input)
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: 'errors.invalidInput' })
      return z.NEVER
    }
    return Object.fromEntries(Object.entries(result.data).filter(([key]) => Object.hasOwn(input, key))) as Partial<T>
  }))
}
