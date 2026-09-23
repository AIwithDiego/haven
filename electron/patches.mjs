// This module is shared by the main process and the renderer; no native APIs.
const json = value => JSON.stringify(value);
export class StatePublisher {
  revision = 0;
  tasks = new Map();
  next(state, dirty = null) {
    const { sessions, revision: _revision, ...globals } = state;
    const sessionOrder = sessions.map(s => s.id), order = json(sessionOrder), globalText = json(globals), updates = [];
    const initial = this.revision === 0;
    for (const session of sessions) {
      const previous = this.tasks.get(session.id);
      if (previous && dirty && !dirty.has(session.id)) continue;
      const { messages, ...task } = session, taskText = json(task), messageOrder = messages.map(m => m.id), orderText = json(messageOrder);
      const signatures = new Map(), upsert = [];
      for (const message of messages) { const signature = json(message); signatures.set(message.id, signature); if (previous?.messages.get(message.id) !== signature) upsert.push(message); }
      const update = { id: session.id };
      if (previous?.task !== taskText) update.task = task;
      if (upsert.length || previous?.order !== orderText) update.messages = { upsert, ...(previous?.order !== orderText ? { order: messageOrder } : {}) };
      if (update.task || update.messages) updates.push(update);
      this.tasks.set(session.id, { task: taskText, messages: signatures, order: orderText });
    }
    for (const id of this.tasks.keys()) if (!sessionOrder.includes(id)) this.tasks.delete(id);
    const patch = { revision: this.revision + 1, sessions: updates };
    if (this.globals !== globalText) patch.globals = globals;
    if (this.order !== order) patch.order = sessionOrder;
    this.globals = globalText; this.order = order;
    if (!initial && !updates.length && !patch.globals && !patch.order) return null;
    this.revision++;
    return initial ? { full: { ...state, revision: this.revision } } : { patch };
  }
}
export function applyPatch(state, patch) {
  if (patch.revision <= (state.revision || 0)) return state;
  const tasks = new Map(state.sessions.map(s => [s.id, s]));
  for (const update of patch.sessions) {
    const old = tasks.get(update.id), task = update.task ? { ...update.task, messages: old?.messages || [] } : { ...old };
    if (update.messages) {
      const messages = new Map(task.messages.map(m => [m.id, m]));
      for (const message of update.messages.upsert) messages.set(message.id, message);
      task.messages = (update.messages.order || task.messages.map(m => m.id)).map(id => messages.get(id));
    }
    tasks.set(update.id, task);
  }
  return { ...state, ...patch.globals, revision: patch.revision, sessions: (patch.order || state.sessions.map(s => s.id)).map(id => tasks.get(id)) };
}
export function filterTasks(tasks, search) {
  const term = search.trim().toLowerCase();
  if (!term) return tasks;
  return tasks.filter(s => `${s.name} ${s.cwd} ${s.messages.map(m => m.text).join(' ')}`.toLowerCase().includes(term));
}
