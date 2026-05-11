import { EventEmitter } from 'node:events';

export type FamilyEvent =
  | { type: 'instance.claimed'; instanceId: string }
  | { type: 'instance.submitted'; instanceId: string }
  | { type: 'instance.approved'; instanceId: string }
  | { type: 'instance.rejected'; instanceId: string }
  | { type: 'instance.materialized'; instanceId: string }
  | { type: 'instance.missed'; instanceId: string }
  | { type: 'chore.updated'; choreId: string }
  | { type: 'badge.awarded'; memberType: 'user' | 'kid'; memberId: string; badgeCode: string }
  | { type: 'goal.hit'; goalId: string; memberType: 'user' | 'kid'; memberId: string }
  | { type: 'goal.updated'; goalId: string }
  | {
      type: 'week.closed';
      weekId: string;
      championMemberType: 'user' | 'kid' | null;
      championMemberId: string | null;
      championAmountCents: number | null;
    }
  | { type: 'level.up'; memberType: 'user' | 'kid'; memberId: string; level: number }
  | { type: 'ledger.paid'; memberType?: 'user' | 'kid'; memberId?: string; count: number }
  | { type: 'family.updated' };

class FamilyBus {
  private emitters = new Map<string, EventEmitter>();

  private getEmitter(familyId: string): EventEmitter {
    let e = this.emitters.get(familyId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(64);
      this.emitters.set(familyId, e);
    }
    return e;
  }

  publish(familyId: string, event: FamilyEvent): void {
    this.getEmitter(familyId).emit('event', event);
  }

  subscribe(familyId: string, handler: (event: FamilyEvent) => void): () => void {
    const e = this.getEmitter(familyId);
    e.on('event', handler);
    return () => e.off('event', handler);
  }
}

export const bus = new FamilyBus();
