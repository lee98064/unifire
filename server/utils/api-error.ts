import { createError, getValidatedQuery, getValidatedRouterParams, readValidatedBody } from 'h3'
import type { H3Event } from 'h3'
import type { ZodType } from 'zod'

export function apiError(statusCode: number, code: string, message: string) {
  return createError({ statusCode, message, data: { code } })
}

export async function readApiBody<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  try {
    return await readValidatedBody(event, input => schema.parse(input))
  } catch {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
}

export async function readApiQuery<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  try {
    return await getValidatedQuery(event, input => schema.parse(input))
  } catch {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
}

export async function readApiParams<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  try {
    return await getValidatedRouterParams(event, input => schema.parse(input), { decode: true })
  } catch {
    throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  }
}
