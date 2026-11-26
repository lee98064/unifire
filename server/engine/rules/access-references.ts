import { eq } from 'drizzle-orm'
import { RuleAction, type RuleT } from '#shared/schemas/automation'
import type { Db } from '../../db'
import { groups, people, rules } from '../../db/schema'
import { apiError } from '../../utils/api-error'
import { decrypt, encrypt } from '../../utils/crypto'

type Target = { type: 'group' | 'person', id: string }
type Action = RuleT['actions'][number]

function accessTarget(action: Action): Target | undefined {
  switch (action.type) {
    case 'group.pause':
    case 'group.resume': return { type: 'group', id: action.groupId }
    case 'pause':
    case 'resume': return { type: 'person', id: action.personId }
    case 'block':
    case 'unblock': return action.target.type === 'client' ? undefined : { type: action.target.type, id: action.target.id }
  }
}

export function checkAccessActions(db: Pick<Db, 'select'>, actions: Action[]) {
  for (const action of actions) {
    const target = accessTarget(action)
    if (!target) continue
    if (target.type === 'group' && !db.select({ id: groups.id }).from(groups).where(eq(groups.id, target.id)).get()) {
      throw apiError(404, 'GROUP_NOT_FOUND', 'errors.groupNotFound')
    }
    if (target.type === 'person' && !db.select({ id: people.id }).from(people).where(eq(people.id, target.id)).get()) {
      throw apiError(404, 'PERSON_NOT_FOUND', 'errors.personNotFound')
    }
  }
}

export function removeAccessActions(tx: Pick<Db, 'select' | 'update' | 'delete'>, target: Target) {
  const affected: string[] = []
  for (const row of tx.select({ id: rules.id, actions: rules.actions, encrypted: rules.encryptedActions }).from(rules).all()) {
    const actions = row.encrypted ? RuleAction.array().parse(decrypt(row.encrypted)) : row.actions
    const remaining = actions.filter(action => {
      const ref = accessTarget(action)
      return ref?.type !== target.type || ref.id !== target.id
    })
    if (remaining.length === actions.length) continue
    if (remaining.length) tx.update(rules).set({ actions: [], encryptedActions: encrypt(remaining) }).where(eq(rules.id, row.id)).run()
    // The shared rule schema requires at least one action. Rule-run history has its own retention.
    else tx.delete(rules).where(eq(rules.id, row.id)).run()
    affected.push(row.id)
  }
  return affected
}
