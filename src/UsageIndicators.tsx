import { useEffect, useState } from 'react';
import { ChevronRight, Info, RefreshCw } from 'lucide-react';
import { AgentMark, IconButton, Modal } from './components';
import { api, type ProviderUsage, type Session, type State, type Toast, type UsageWindow } from './types';
import './usage-indicators.css';

const providerName = (engine: string) => engine === 'codex' ? 'Codex' : 'Claude';
const percentText = (value: number) => `${Number(value.toFixed(1))}%`;
const tokenText = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const fullTime = (value?: number) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet reported';
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  return now;
}
function resetText(at: number | undefined, now: number) {
  if (!at) return 'Reset time not reported';
  const minutes = Math.ceil((at - now) / 60000);
  if (minutes <= 0) return 'Reset passed · refresh needed';
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function Meter({ value, label, expired = false }: { value?: number; label: string; expired?: boolean }) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const percent = known ? Math.max(0, Math.min(100, value)) : 0;
  return <div className={`usage-meter ${known ? '' : 'unknown'} ${expired ? 'expired' : ''} ${percent >= 90 ? 'high' : percent >= 75 ? 'medium' : ''}`}
    role={known ? 'meter' : undefined} aria-label={label} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={known ? percent : undefined} aria-valuetext={known ? `${percentText(percent)} used${expired ? ', last reported before reset' : ''}` : undefined}>
    {known && <span style={{ width: `${percent}%` }} />}
  </div>;
}

export function ContextMeter({ session }: { session: Session }) {
  const [details, setDetails] = useState(false);
  if (session.engine === 'terminal') return null;
  const usage = session.contextUsage;
  const known = usage && Number.isFinite(usage.usedTokens) && usage.contextWindow > 0;
  const percent = known ? Math.min(100, Math.max(0, usage.usedTokens / usage.contextWindow * 100)) : undefined;
  return <div className="context-meter">
    <div className="context-meter-label"><button onClick={() => setDetails(true)} aria-label="Context window details">Context <Info size={12} /></button>
      <span>{known ? <><strong>{usage.estimated ? '~' : ''}{percentText(percent!)} used</strong><span className="context-token-count"> · {tokenText(usage.usedTokens)} / {tokenText(usage.contextWindow)}</span></> : 'Not yet reported'}</span>
    </div>
    <Meter value={percent} label="Task context window" />
    <Modal open={details} onOpenChange={setDetails} title="Room for this conversation" description="How much of this task’s context window the agent is using.">
      {known ? <><div className="context-detail-number">{usage.estimated ? '~' : ''}{percentText(percent!)} <small>used</small></div><p className="usage-explanation">{usage.usedTokens.toLocaleString()} of {usage.contextWindow.toLocaleString()} tokens{usage.estimated ? ' (estimated)' : ''}.</p><Meter value={percent} label="Context usage details" /><p className="usage-explanation">{usage.estimated ? 'Claude estimates the current context against its compaction window.' : 'The latest context reported by Codex, rather than tokens accumulated across the whole task.'} Compaction can make room as the conversation grows. Unsent drafts are not included.</p><p className="usage-timestamp">Last reported {fullTime(usage.updatedAt)}</p></> : <p className="usage-explanation">The provider has not reported context for this task yet. This bar updates as the agent works.</p>}
    </Modal>
  </div>;
}

function WindowUsage({ window: item, name, now, detailed = false }: { window: UsageWindow; name: string; now: number; detailed?: boolean }) {
  const expired = !!item.resetsAt && item.resetsAt <= now;
  const known = typeof item.usedPercent === 'number';
  return <div className={`usage-window ${detailed ? 'detailed' : ''}`} title={resetText(item.resetsAt, now)}>
    <div className="usage-window-label"><span>{item.label}</span><strong>{known ? `${expired ? 'Last ' : ''}${percentText(item.usedPercent!)}` : item.status === 'rejected' ? 'Limit reached' : 'Not reported'}</strong></div>
    <Meter value={item.usedPercent} label={`${name} ${item.label} usage`} expired={expired} />
    {detailed && <small>{resetText(item.resetsAt, now)}{item.resetsAt && item.resetsAt > now ? ` · ${fullTime(item.resetsAt)}` : ''}</small>}
  </div>;
}

export function ProviderUsagePanel({ usage, toast, compact = false }: { usage: State['providerUsage']; toast: Toast; compact?: boolean }) {
  const [selected, setSelected] = useState<'codex' | 'claude' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow();
  const refresh = async () => {
    setRefreshing(true);
    try { await api('usage:refresh'); } catch (error: any) { toast(error.message, 'error'); } finally { setRefreshing(false); }
  };
  const selectedUsage: ProviderUsage | undefined = selected ? usage?.[selected] : undefined;
  return <section className={`provider-usage ${compact ? 'compact' : ''}`} aria-label="Agent usage">
    <div className="provider-usage-heading"><span>AGENT USAGE</span><IconButton label="Refresh agent usage" disabled={refreshing} onClick={refresh}><RefreshCw size={12} className={refreshing ? 'spin' : ''} /></IconButton></div>
    {(['codex', 'claude'] as const).map(engine => {
      const item = usage?.[engine], name = providerName(engine);
      const stale = item?.updatedAt && now - item.updatedAt > 15 * 60000;
      return <div className="usage-provider" key={engine}>
        <button className="usage-provider-details" title={`${name}: ${(item?.windows || []).map(w => `${w.label}: ${w.usedPercent === undefined ? 'not reported' : percentText(w.usedPercent)}`).join(', ') || 'usage unavailable'} · ${stale || item?.status === 'error' ? 'Last reported · ' : ''}Updated ${fullTime(item?.updatedAt)}`} aria-label={`${name} usage details`} onClick={() => setSelected(engine)}><AgentMark engine={engine} size={15} /><strong>{name}</strong><small>{compact ? (item?.windows.length ? item.windows.slice(0, 2).map(w => w.usedPercent === undefined ? '—' : `${Math.round(w.usedPercent)}%`).join(' · ') : item?.status === 'loading' ? '…' : '—') : item?.status === 'loading' ? 'Updating…' : item?.windows.length && (stale || item.status === 'error') ? 'Last reported' : ''}</small><ChevronRight size={12} /></button>
        {item?.windows.length ? <div className="usage-windows">{item.windows.slice(0, 2).map(window => <WindowUsage key={window.id} window={window} name={name} now={now} />)}</div> : <p className="usage-unavailable">{item?.status === 'loading' ? 'Checking account limits…' : 'Usage unavailable'}</p>}
      </div>;
    })}
    <Modal open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }} title={`${providerName(selected || 'codex')} usage`} description="Account-wide limits, shared across your tasks and other apps.">
      {selectedUsage?.plan && <p className="usage-plan">{selectedUsage.plan}</p>}
      {selectedUsage?.windows.map(window => <WindowUsage key={window.id} window={window} name={providerName(selected!)} now={now} detailed />)}
      {selectedUsage?.message && <p className="usage-explanation">{selectedUsage.message}</p>}
      {!selectedUsage?.windows.length && !selectedUsage?.message && <p className="usage-explanation">Account usage has not been reported yet. Refresh to check the connected account.</p>}
      <div className="usage-detail-footer"><p className="usage-timestamp">Updated {fullTime(selectedUsage?.updatedAt)}</p><button className="button secondary" disabled={refreshing} onClick={refresh}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />Refresh usage</button></div>
    </Modal>
  </section>;
}
