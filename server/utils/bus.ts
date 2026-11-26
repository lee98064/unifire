import { EventEmitter } from 'node:events'
import type { SessionUserT } from '#shared/schemas/auth'
import { LiveEvent, type LiveEventT } from '#shared/schemas/system'

export function createLiveBus() {
  const emitter = new EventEmitter().setMaxListeners(0)
  return {
    emit(event: LiveEventT) {
      emitter.emit('live', LiveEvent.parse(event))
    },
    subscribe(listener: (event: LiveEventT) => void) {
      emitter.on('live', listener)
      return () => { emitter.off('live', listener) }
    },
  }
}

export const liveBus = createLiveBus()

export function canReceiveEvent(user: Pick<SessionUserT, 'role' | 'personId'>, event: LiveEventT) {
  if (user.role === 'admin' || event.type === 'hello') return true
  if (!user.personId) return false
  switch (event.type) {
    case 'presence':
    case 'quota':
    case 'extension.request':
      return event.data.personId === user.personId
    default:
      return false
  }
}
