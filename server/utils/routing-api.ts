import type { H3Event } from 'h3'
import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { readApiParams } from './api-error'

const params = z.object({ id: Id })
export async function routingId(event: H3Event) {
  return (await readApiParams(event, params)).id
}
