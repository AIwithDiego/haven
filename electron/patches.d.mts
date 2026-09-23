import type { State, Session, Message } from '../src/types';
export type StatePatch = { revision: number; globals?: Partial<State>; order?: string[]; sessions: { id: string; task?: Omit<Session, 'messages'>; messages?: { order?: string[]; upsert: Message[] } }[] };
export function applyPatch(state: State, patch: StatePatch): State;
export function filterTasks(tasks: Session[], search: string): Session[];
export class StatePublisher {
  revision: number;
  next(state: State, dirty?: Set<string> | null): { full?: State; patch?: StatePatch } | null;
}
