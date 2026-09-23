import type { Toast } from './types';
import { useEffect, useState, type RefObject } from 'react';
import { Clock3, Search, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from './components';
import { api, working, type Session, type ChatCommand, type CommandCatalog } from './types';

export const dateTime = (at?: number) => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded';
export function duration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function useNow() { const [now, setNow] = useState(Date.now()); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []); return now; }
export function RunningTime({ session: s }: { session: Session }) {
  const now = useNow();
  return <span className="running-time" title="Agent processing and terminal runtime. Waiting for your approval pauses the clock."><Clock3 size={12} />{duration((s.runningMs || 0) + (s.runningSince != null ? now - s.runningSince : 0))} running</span>;
}
export function SessionTiming({ session: s }: { session: Session }) {
  return <section className="session-timing"><h3>Task time</h3><RunningTime session={s} /><dl>
    <dt>Opened</dt><dd>{dateTime(s.createdAt)}</dd>
    {s.lastOpenedAt !== s.createdAt && s.lastOpenedAt && <><dt>Reopened</dt><dd>{dateTime(s.lastOpenedAt)}</dd></>}
    <dt>Last finished</dt><dd>{s.lastFinishedAt ? dateTime(s.lastFinishedAt) : 'No completed run recorded'}</dd>
    <dt>{s.closed ? 'Closed' : 'Last closed'}</dt><dd>{s.closedAt ? dateTime(s.closedAt) : s.closed ? 'Not recorded' : 'Still open'}</dd>
    {s.archived && <><dt>Archived</dt><dd>{dateTime(s.archivedAt)}</dd></>}
  </dl>{s.timingTrackedAt && s.timingTrackedAt > s.createdAt + 1000 && <p className="detail-caption">Running time tracked since {dateTime(s.timingTrackedAt)}. Earlier runtime was not recorded.</p>}
    {!!s.timeline?.length && <details className="session-history"><summary>Task history</summary><ol>{s.timeline.slice(-20).reverse().map((e, i) => <li key={i}><span>{e.kind}</span><time title={new Date(e.at).toLocaleString()}>{dateTime(e.at)}</time></li>)}</ol></details>}
  </section>;
}
export function DeleteTaskDialog({ session: s, close, onDeleted, toast }: { session: Session; close: () => void; onDeleted: (id: string) => void; toast: Toast }) {
  const [deleting, setDeleting] = useState(false), active = working(s) || s.status === 'running';
  return <Modal open onOpenChange={open => !open && !deleting && close()} title={`Delete “${s.name}”?`} description="This permanently removes its conversation, draft, and temporary attachments from Haven. Project files and the provider’s own history stay untouched.">
    <p className="detail-caption">This cannot be undone. Archive the task instead if you want to return to it.</p>
    {active && <p className="inline-error" role="alert">This task is running. Stop it before deleting.</p>}
    <div className="modal-footer"><button className="button secondary" onClick={close} disabled={deleting}>Keep task</button>{active ? <button className="button secondary" onClick={() => api('stop', { id: s.id }).catch(e => toast(e.message, 'error'))}>Stop task</button> : <button className="button danger" disabled={deleting} onClick={async () => { setDeleting(true); try { await api('delete', { id: s.id }); onDeleted(s.id); close(); toast('Task deleted'); } catch (e: any) { toast(e.message, 'error'); setDeleting(false); } }}><Trash2 size={14} />Delete permanently</button>}</div>
  </Modal>;
}
function useCommands(id: string, enabled: boolean, discover = false) {
  const [catalog, setCatalog] = useState<CommandCatalog>({ commands: [] }), [loading, setLoading] = useState(false), [revision, refresh] = useState(0);
  useEffect(() => {
    if (!enabled) return; let cancelled = false; setLoading(true);
    (async () => {
      try {
        const local = await api<CommandCatalog>('commands', { id, localOnly: true });
        if (!cancelled) setCatalog(current => current.commands.length ? current : local);
        if (!discover) { if (!cancelled) setCatalog(local); return; }
        const value = await api<CommandCatalog>('commands', { id, reload: revision > 0 });
        if (!cancelled) setCatalog(value);
      } catch (e: any) { if (!cancelled) setCatalog(current => ({ ...current, error: e.message })); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [id, enabled, revision, discover]);
  return { catalog, loading, refresh: () => refresh(n => n + 1) };
}
const matching = (commands: ChatCommand[], search: string) => commands.filter(c => `${c.name} ${c.description}`.toLowerCase().includes(search.replace(/^\//, '').toLowerCase()));
function CommandRows({ commands, selected, pick }: { commands: ChatCommand[]; selected?: number; pick: (name: string) => void }) {
  return <>{commands.map((c, i) => <button id={`slash-option-${i}`} key={c.name} type="button" role="option" aria-selected={selected === i} className={`command-option ${selected === i ? 'selected' : ''}`} onMouseDown={e => e.preventDefault()} onClick={() => pick(c.name)}><span><strong>/{c.name}</strong><small>{c.description || c.argumentHint}</small></span><span className="command-kind">{c.kind === 'haven' ? 'Haven' : c.kind === 'provider' ? 'Agent' : 'Skill'}</span></button>)}</>;
}
export function SlashSuggestions({ id, draft, input, pick }: { id: string; draft: string; input: RefObject<HTMLTextAreaElement | null>; pick: (name: string) => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null), [selected, setSelected] = useState(0);
  const enabled = /^\/[\p{L}\p{N}\p{M}_:-]*$/u.test(draft) && dismissed !== draft;
  const { catalog, loading } = useCommands(id, enabled);
  const results = matching(catalog.commands, draft).slice(0, 40);
  const index = Math.min(selected, Math.max(0, results.length - 1));
  useEffect(() => { setSelected(0); }, [draft]);
  useEffect(() => {
    const el = input.current; if (!enabled || !el) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.isComposing || e.shiftKey) return;
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(draft); }
      if (results.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Enter' || e.key === 'Tab') pick(results[index].name);
        else setSelected((index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
      }
    };
    el.setAttribute('aria-controls', 'slash-suggestions'); el.setAttribute('aria-autocomplete', 'list');
    if (results.length) el.setAttribute('aria-activedescendant', `slash-option-${index}`);
    el.addEventListener('keydown', key);
    document.getElementById(`slash-option-${index}`)?.scrollIntoView({ block: 'nearest' });
    return () => { el.removeEventListener('keydown', key); el.removeAttribute('aria-controls'); el.removeAttribute('aria-autocomplete'); el.removeAttribute('aria-activedescendant'); };
  }, [enabled, draft, results, index, input, pick]);
  if (!enabled) return null;
  return <div className="slash-suggestions"><div className="command-heading">Commands, skills & protocols <span>↑ ↓ · Enter to insert · Esc to dismiss</span></div><div id="slash-suggestions" role="listbox" aria-label="Slash commands" className="command-results"><CommandRows commands={results} selected={index} pick={pick} />{!results.length && <p className="empty-note">{loading ? 'Loading your commands…' : 'No matching command. Try /help, or // for literal text.'}</p>}</div>{catalog.error && <p className="inline-error">{catalog.error}</p>}</div>;
}
export function CommandBrowser({ id, skillsOnly, close, pick }: { id: string; skillsOnly: boolean; close: () => void; pick: (name: string) => void }) {
  const [search, setSearch] = useState(''); const { catalog, loading, refresh } = useCommands(id, true, true);
  const results = matching(catalog.commands.filter(c => !skillsOnly || c.kind === 'skill'), search);
  return <Modal open onOpenChange={open => !open && close()} title={skillsOnly ? 'Your skills & protocols.' : 'A shortcut for your next step.'} description="Commands come from this agent and working folder. Choose one to add it to your draft, then send when ready."><div className="command-search"><Search size={16} /><input autoFocus aria-label="Search commands" placeholder="Find a command, skill, or protocol…" value={search} onChange={e => setSearch(e.target.value)} /><button aria-label="Refresh commands" disabled={loading} onClick={refresh}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div><div role="listbox" aria-label="Available commands" className="command-results browser-results"><CommandRows commands={results} pick={name => { pick(name); close(); }} />{!results.length && <p className="empty-note">{loading ? 'Loading your commands…' : 'No matching commands.'}</p>}</div>{catalog.error && <p className="inline-error" role="alert">{catalog.error}</p>}</Modal>;
}
