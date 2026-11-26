import type { ZodType } from 'zod'
import { api } from '#shared/api'
import { CertificateInfo } from '#shared/schemas/controller'
import { inspectCertificate } from '../../../unifi/tls'
import { readApiBody } from '../../../utils/api-error'
import { adminControllerHandler } from '../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { url } = await readApiBody(event, api.setupInspect.input! as ZodType<{ url: string }>)
  return CertificateInfo.parse(await inspectCertificate(url))
})
