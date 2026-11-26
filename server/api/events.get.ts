import { createEventStream, defineEventHandler, setResponseHeader } from 'h3'
import type { LiveEventT } from '#shared/schemas/system'
import { activeSessionUser, requireAccount } from '../utils/auth'
import { canReceiveEvent, liveBus } from '../utils/bus'
import { forgetEventStream, trackEventStream } from '../utils/event-streams'

const heartbeatMs = 20_000

export default defineEventHandler(async event => {
  const { session } = await requireAccount(event)
  const stream = createEventStream(event, { autoclose: false })
  const { res } = event.node
  setResponseHeader(event, 'X-Accel-Buffering', 'no')

  let closed = false

  function close() {
    if (closed) return
    closed = true
    forgetEventStream(close)
    res.off('close', close)
    clearInterval(heartbeat)
    unsubscribe()
    void stream.close().catch(() => {})
  }

  function sendEvent(message: LiveEventT) {
    if (res.writableNeedDrain || res.destroyed) return close()
    void stream.push({ event: message.type, data: JSON.stringify(message.data) }).catch(close)
  }

  const unsubscribe = liveBus.subscribe(message => {
    const user = activeSessionUser(session)
    if (!user) return close()
    if (canReceiveEvent(user, message)) sendEvent(message)
  })
  const heartbeat = setInterval(() => {
    if (!activeSessionUser(session) || res.writableNeedDrain || res.destroyed) return close()
    res.write(': heartbeat\n\n')
  }, heartbeatMs)
  heartbeat.unref()
  res.once('close', close)

  const sending = stream.send()
  setResponseHeader(event, 'Cache-Control', 'no-store')
  trackEventStream(close)
  if (!closed) sendEvent({ type: 'hello', data: { ts: Date.now() } })
  return sending
})
