import path from 'node:path';

const label = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300) : '';
const identifier = value => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) ? value : '';

// Only explicit display fields cross IPC. Never return headers, environment,
// credentials, raw arguments, or provider errors (which can contain tokens).
export function connectionDetails(config = {}) {
  const details = {};
  if (typeof config.url === 'string') {
    try {
      const url = new URL(config.url);
      if (['http:', 'https:'].includes(url.protocol)) {
        details.endpoint = url.origin + (url.pathname === '/mcp' || url.pathname === '/sse' ? url.pathname : url.pathname === '/' ? '' : '/…');
        const project = identifier(url.searchParams.get('project_ref'));
        if (project) details.project = project;
        if (['true', 'false'].includes(url.searchParams.get('read_only'))) details.access = url.searchParams.get('read_only') === 'true' ? 'Read only (configured)' : 'Read/write (configured)';
        if (!details.project && /^[\w-]+\.supabase\.co$/.test(url.hostname)) details.project = url.hostname.split('.')[0];
      }
    } catch { /* Do not display an unparseable URL. */ }
  }
  if (typeof config.command === 'string') details.command = path.basename(config.command).slice(0, 100);
  const args = Array.isArray(config.args) ? config.args : [];
  for (let index = 0; index < args.length; index++) {
    if (typeof args[index] !== 'string') continue;
    const [flag, inline] = args[index].split('=');
    if (['--project-ref', '--project-id', '--database', '--host', '--port'].includes(flag)) {
      const value = identifier(inline || args[index + 1]);
      if (value) details[({ '--project-ref': 'project', '--project-id': 'project', '--database': 'database', '--host': 'host', '--port': 'port' })[flag]] = value;
    }
    if (flag === '--read-only' && inline !== 'false') details.access = 'Read only (configured)';
  }
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_URL']) {
    const value = config.env?.[key];
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (['postgres:', 'postgresql:'].includes(url.protocol)) {
        details.host = url.hostname;
        if (url.port) details.port = url.port;
        const database = identifier(decodeURIComponent(url.pathname.slice(1))); if (database) details.database = database;
      } else if (key === 'SUPABASE_URL' && /^[\w-]+\.supabase\.co$/.test(url.hostname)) details.project ||= url.hostname.split('.')[0];
    } catch { /* No raw environment values cross the boundary. */ }
  }
  for (const [key, field] of [['PGHOST', 'host'], ['PGPORT', 'port'], ['PGDATABASE', 'database']]) {
    const value = identifier(config.env?.[key]); if (value) details[field] = value;
  }
  return details;
}

export function normalizeConnection(server, config = {}, runtime = true) {
  const native = server.runtimeStatus ?? server.status;
  const status = !runtime ? (config.enabled === false ? 'disabled' : 'configured') : ({ connected: 'connected', failed: 'failed', 'needs-auth': 'needs-auth', authenticationRequired: 'needs-auth', pending: 'connecting', starting: 'connecting', disabled: 'disabled', cancelled: 'disconnected', notStarted: 'disconnected' })[native] || 'unknown';
  const tools = (Array.isArray(server.tools) ? server.tools : Object.values(server.tools || {})).filter(Boolean).map(tool => ({ name: label(tool.name), readOnly: tool.annotations?.readOnly === true || tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructive === true || tool.annotations?.destructiveHint === true })).filter(tool => tool.name).sort((a, b) => a.name.localeCompare(b.name));
  return { name: label(server.name), status, auth: label(server.authStatus), scope: label(server.scope || server.source || (server.pluginId ? 'plugin' : '')), tools,
    details: connectionDetails(server.config || config), serverName: label(server.serverInfo?.name), serverVersion: label(server.serverInfo?.version),
    issue: status === 'failed' ? 'Connection failed. Check this server in the provider’s MCP settings.' : status === 'needs-auth' ? 'Sign in again using the provider’s MCP settings.' : server.toolsError ? 'Tool discovery failed. Refresh to try again.' : '',
  };
}
