import { Ok } from '#shared/schemas/common'
import { useController } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async () => {
  await (await useController()).sync()
  return Ok.parse({ ok: true })
})
