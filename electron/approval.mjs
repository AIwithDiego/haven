// Builds what an approval card shows. The decisive input (shell command, file
// path and operation, MCP server, tool and arguments) is shown inline. Nothing
// is cut without a visible marker: a field longer than INLINE_LIMIT carries
// `hiddenChars`, and Workspace.answer refuses Allow until the full input has
// been opened (deny by default).
export const INLINE_LIMIT = 20000;
export const REVIEW_LIMIT = 2000000;

const asText = value => typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
const rest = (input, keys) => Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));

/** Splits `mcp__<server>__<tool>`; the server is everything before the first `__` after the prefix. */
export function mcpParts(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return match ? { server: match[1], tool: match[2] } : null;
}

const claudeTools = {
  Bash: { title: 'Run a shell command?', keys: [['command', 'Command'], ['description', 'Agent’s description']] },
  Write: { title: 'Create or overwrite a file?', keys: [['file_path', 'File'], ['content', 'New content']] },
  Edit: { title: 'Edit a file?', keys: [['file_path', 'File'], ['old_string', 'Replace'], ['new_string', 'With']] },
  MultiEdit: { title: 'Edit a file?', keys: [['file_path', 'File'], ['edits', 'Edits']] },
  NotebookEdit: { title: 'Edit a notebook?', keys: [['notebook_path', 'Notebook'], ['edit_mode', 'Operation'], ['new_source', 'New content']] },
  Read: { title: 'Read a file?', keys: [['file_path', 'File']] },
  Glob: { title: 'List files?', keys: [['path', 'Folder'], ['pattern', 'Pattern']] },
  Grep: { title: 'Search file contents?', keys: [['path', 'Folder'], ['pattern', 'Pattern'], ['glob', 'Files']] },
  WebFetch: { title: 'Fetch a web page?', keys: [['url', 'URL'], ['prompt', 'Prompt']] },
  WebSearch: { title: 'Search the web?', keys: [['query', 'Query']] },
};

/** @param {string} title @param {{label: string, value: unknown}[]} fields */
export function approvalRequest(title, fields, kind = 'approval') {
  const full = fields.filter(f => f.value !== undefined && f.value !== null && f.value !== '').map(f => ({ label: f.label, value: asText(f.value) }));
  let hiddenChars = 0, totalChars = 0;
  const shown = full.map(f => {
    const hidden = Math.max(0, f.value.length - INLINE_LIMIT);
    hiddenChars += hidden; totalChars += f.value.length;
    return { label: f.label, value: hidden ? f.value.slice(0, INLINE_LIMIT) : f.value, chars: f.value.length, lines: f.value.split('\n').length, hiddenChars: hidden };
  });
  return { title, kind, fields: shown, hiddenChars, reviewable: totalChars <= REVIEW_LIMIT, full };
}

/** A Claude tool call awaiting approval. `extra` adds context fields such as the SDK's decision reason. */
export function describeClaudeTool(name, input, extra = []) {
  const toolInput = input && typeof input === 'object' && !Array.isArray(input) ? input : { input };
  const mcp = mcpParts(name);
  if (mcp) return approvalRequest(`Call ${mcp.tool} on ${mcp.server}?`, [{ label: 'MCP server', value: mcp.server }, { label: 'MCP tool', value: mcp.tool }, { label: 'Arguments', value: toolInput }, ...extra]);
  const known = claudeTools[name];
  const keys = known?.keys || [];
  const fields = keys.map(([key, label]) => ({ label, value: toolInput[key] }));
  const other = rest(toolInput, keys.map(([key]) => key));
  if (Object.keys(other).length) fields.push({ label: known ? 'Other input' : 'Input', value: other });
  return approvalRequest(known?.title || `Use ${name}?`, [{ label: 'Tool', value: name }, ...fields, ...extra]);
}

const controlEscapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\', "'": "\\'" };
/** One argument quoted the way a POSIX shell would read it back, so argument
 * boundaries are visible: plain words stay bare, anything else is single-quoted,
 * and control characters use $'...' escapes instead of breaking the line. */
export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  if (/[\u0000-\u001f\u007f]/.test(text)) return `$'${text.replace(/[\u0000-\u001f\u007f\\']/g, c => controlEscapes[c] || `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
/** An argv array as one unambiguous line; a string command is shown as sent. */
export const commandLine = command => Array.isArray(command) ? command.map(shellQuote).join(' ') : command;

/** A Codex app-server approval request. `fallbackCwd` is the task folder, shown
 * when Codex does not report where the command runs. */
export function describeCodexRequest(method, params = {}, fallbackCwd) {
  if (method === 'item/permissions/requestApproval') return approvalRequest('Allow additional access for this turn?', [{ label: 'Reason', value: params.reason }, { label: 'Permissions', value: params.permissions }]);
  const title = method === 'item/fileChange/requestApproval' ? 'Allow these file changes?' : 'Run a shell command?';
  return approvalRequest(title, [{ label: 'Command', value: commandLine(params.command) }, { label: 'Folder', value: params.cwd || fallbackCwd }, { label: 'Reason', value: params.reason },
    { label: 'Other input', value: Object.keys(rest(params, ['command', 'cwd', 'reason', 'threadId', 'turnId', 'itemId'])).length ? rest(params, ['command', 'cwd', 'reason', 'threadId', 'turnId', 'itemId']) : undefined }]);
}
