import { useCallback, useEffect, useRef, useState } from 'react';
import { Plug, RefreshCw, Search } from 'lucide-react';
import { Modal } from './components';
import { api, type Session } from './types';

type Connection = { name: string; status: string; auth?: string; scope?: string; details: Record<string, string>; serverName?: string; serverVersion?: string; issue?: string; tools: { name: string; readOnly: boolean; destructive: boolean }[] };
type Inventory = { source: string; updatedAt: number; servers: Connection[]; builtInTools: string[] };
const statusLabels: Record<string, string> = { connected: 'Connected', failed: 'Failed', 'needs-auth': 'Sign-in needed', connecting: 'Connecting', disabled: 'Disabled', disconnected: 'Disconnected', configured: 'Configured · not checked', unknown: 'Status unavailable' };
export function ConnectionsPanel({ session, close }: { session: Session; close: () => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [query, setQuery] = useState('');
  const mounted = useRef(true), pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    try { const value = await api<Inventory>('connections', { id: session.id }); if (mounted.current) { setInventory(value); setError(''); } }
    catch (error: any) { if (mounted.current) setError(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { pending.current = false; if (mounted.current) setLoading(false); }
  }, [session.id]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);
  const needle = query.toLowerCase();
  const servers = inventory?.servers.filter(server => [server.name, ...Object.values(server.details), ...server.tools.map(tool => tool.name)].some(value => value.toLowerCase().includes(needle))) || [];
  return <Modal open onOpenChange={open => !open && close()} title="Connections & tools" description={`${session.engine === 'claude' ? 'Claude' : 'Codex'} · ${session.name}`} wide>
    <div className="connections-toolbar"><label><Search size={15} /><input aria-label="Search connections and tools" placeholder="Find a server, project or tool…" value={query} onChange={e => setQuery(e.target.value)} /></label><button className="button secondary" disabled={loading} onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh</button></div>
    <div className="connections-context"><span>{session.cwd}</span><span>{inventory?.source || (loading ? 'Reading this task’s connections…' : 'No live connection details available')}</span></div>
    {error && <p className="inline-error" role="alert">{error}{inventory && ' Showing the last successful check.'}</p>}
    <div className="connections-list" aria-busy={loading}>
      {servers.map(server => <details className="connection-card" key={server.name}>
        <summary><Plug size={17} /><span><strong>{server.name}</strong><small>{server.details.project ? `Project: ${server.details.project}` : server.details.endpoint || server.details.command || server.scope || 'MCP server'}</small></span><span className={`connection-status ${error ? 'stale' : server.status}`}>{error ? 'Last: ' : ''}{statusLabels[server.status] || 'Status unavailable'}</span><span className="connection-tool-count">{server.tools.length} tools</span></summary>
        <div className="connection-details">
          {!!Object.keys(server.details).length && <dl>{Object.entries(server.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
          {server.scope && <p>Source: {server.scope}</p>}{server.auth && <p>Authentication: {server.auth}</p>}{server.serverName && <p>{server.serverName}{server.serverVersion && ` · ${server.serverVersion}`}</p>}
          {server.details.project && <p>Project reference from configuration. Database contents and the project’s display name have not been queried.</p>}
          {server.issue && <p className="inline-error">{server.issue}</p>}
          <ul className="connection-tools">{server.tools.filter(tool => !needle || tool.name.toLowerCase().includes(needle) || server.name.toLowerCase().includes(needle) || Object.values(server.details).some(value => value.toLowerCase().includes(needle))).map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.readOnly ? <small>Read only</small> : tool.destructive ? <small>Can change data</small> : null}</li>)}</ul>
          {!server.tools.length && <p>No tool inventory reported for this connection.</p>}
        </div>
      </details>)}
      {!servers.length && !loading && <p className="connections-empty">{query ? 'No connections match your search.' : inventory ? 'No MCP connections reported for this task.' : 'Refresh to check connections.'}</p>}
      {!!inventory?.builtInTools.length && <details className="connection-builtins"><summary>Provider tools · {inventory.builtInTools.length}</summary><div>{inventory.builtInTools.filter(name => name.toLowerCase().includes(needle)).join(' · ')}</div></details>}
    </div>
    <div className="connections-footer"><span>{inventory ? `Checked ${new Date(inventory.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'No successful check yet'} · Refreshes every 30s while open</span><p>Credentials stay hidden. Tool availability is reported by the provider; each task’s permissions still apply.</p></div>
  </Modal>;
}
