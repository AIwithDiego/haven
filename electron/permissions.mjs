import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describeClaudeTool } from './approval.mjs';

// The gated profile reads its candidate MCP connections from a JSON file with an
// `mcpServers` object (HAVEN_GATED_MCP_CONFIG, default ~/.config/haven/gated-mcp.json).
// Only project-scoped Supabase HTTP servers are offered.
export function gatedConfigPath() {
  return process.env.HAVEN_GATED_MCP_CONFIG || path.join(os.homedir(), '.config/haven/gated-mcp.json');
}

// Optional Claude channel plugins for the gated profile, for example
// HAVEN_GATED_CHANNELS="plugin:telegram@claude-plugins-official". Unset means none.
// Plugin names are restricted to [a-z0-9-] so the tool-name match below stays exact.
export function gatedChannels(value = process.env.HAVEN_GATED_CHANNELS) {
  return (value || '').split(/[\s,]+/).filter(c => /^plugin:[a-z0-9-]+@[\w.-]+$/.test(c));
}

export function gatedServers() {
  if (process.env.HAVEN_TEST_MODE === '1') return {};
  try {
    const config = JSON.parse(fs.readFileSync(gatedConfigPath(), 'utf8'));
    return Object.fromEntries(Object.entries(config.mcpServers || {}).filter(([name, server]) => {
      if (!/^[\w-]{1,100}$/.test(name) || server.type !== 'http') return false;
      const url = new URL(server.url);
      return url.origin === 'https://mcp.supabase.com' && url.pathname === '/mcp' && /^[a-z0-9-]+$/i.test(url.searchParams.get('project_ref') || '');
    }));
  } catch { return {}; }
}

// Resolves symlinks for the longest existing prefix, so a path that does not
// exist yet still resolves under its real parent.
// A dangling symlink is followed to its target so it cannot pass as inside.
function realish(target, depth = 0) {
  try { return fs.realpathSync(target); } catch {
    if (depth > 40) return target;
    try { if (fs.lstatSync(target).isSymbolicLink()) return realish(path.resolve(path.dirname(target), fs.readlinkSync(target)), depth + 1); } catch {}
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realish(parent, depth + 1), path.basename(target));
  }
}
export function insideFolder(folder, target) {
  if (typeof target !== 'string' || !target) return false;
  const root = realish(path.resolve(folder)), resolved = realish(path.resolve(folder, target.replace(/^~(?=$|\/)/, os.homedir())));
  return resolved === root || resolved.startsWith(root + path.sep);
}
const outsidePattern = pattern => typeof pattern === 'string' && (path.isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..'));
// Read-only tools run without a prompt only inside the task folder. Anything
// else (~/.ssh, ~/.aws, other projects) goes through the approval card.
export function readStaysInFolder(cwd, tool, input = {}) {
  if (tool === 'Read') return insideFolder(cwd, input.file_path);
  if (tool === 'Glob') return insideFolder(cwd, input.path || cwd) && !outsidePattern(input.pattern);
  if (tool === 'Grep') return insideFolder(cwd, input.path || cwd) && !outsidePattern(input.glob);
  return false;
}

// Plugin MCP tools are named mcp__plugin_<plugin>_<server>__<tool>. A tool
// belongs to an opted-in channel only when <plugin> matches exactly.
export const channelTool = (name, channels) => channels.some(c => {
  const plugin = c.match(/^plugin:([a-z0-9-]+)@/)?.[1];
  return !!plugin && typeof name === 'string' && name.startsWith(`mcp__plugin_${plugin}_`) && /^[^_]+__/.test(name.slice(`mcp__plugin_${plugin}_`.length));
});

/** @returns {Partial<import('@anthropic-ai/claude-agent-sdk').Options>} */
export function claudeProfileOptions(session, host, servers = {}, channels = gatedChannels()) {
  // Project settings (.claude/settings.json hooks, allow rules, .mcp.json servers)
  // load only for folders the user trusted in Haven: the SDK has no trust dialog.
  if (session.profile === 'normal') return { settingSources: session.projectTrusted === true ? ['user', 'project', 'local'] : ['user'] };
  if (path.resolve(session.cwd) === path.parse(session.cwd).root) throw new Error('Choose a working folder other than the filesystem root.');
  if (session.profile === 'autonomous') return { settingSources: ['user'], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
  if (session.profile !== 'gated') throw new Error('Unknown permission profile.');
  const selected = session.gatedServer || '';
  if (selected && !Object.hasOwn(servers, selected)) throw new Error('Choose an available project-scoped connection.');
  return {
    settingSources: ['user'], permissionMode: 'default', strictMcpConfig: true,
    mcpServers: selected ? { [selected]: servers[selected] } : {},
    allowedTools: ['Read', 'Glob', 'Grep'],
    // The hook is the human gate: allow rules cannot skip it. Unknown MCP
    // servers are denied even if a provider/plugin loads one unexpectedly.
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [async (input, _toolId, context) => {
      if (!('tool_name' in input) || !('tool_input' in input)) return {};
      if (input.tool_name === 'AskUserQuestion') return {};
      const readOnly = ['Read', 'Glob', 'Grep'].includes(input.tool_name);
      if (readOnly && readStaysInFolder(session.cwd, input.tool_name, input.tool_input || {})) return {};
      // Key trust on the server's provenance where the SDK reports it, not only on
      // the name prefix. Opted-in channel plugins are matched exactly, so a server
      // named e.g. telegram-x or a plugin named telegram_x cannot borrow their path.
      const source = 'mcp_server' in input ? input.mcp_server?.source : undefined;
      const known = selected && input.tool_name.startsWith(`mcp__${selected}__`) && (source === undefined || (input.mcp_server?.name === selected && source !== 'plugin'));
      const channel = channelTool(input.tool_name, channels) && (source === undefined || source === 'plugin');
      let allow = false;
      if (known || channel || !input.tool_name.startsWith('mcp__')) {
        const extra = readOnly ? [{ label: 'Why this needs approval', value: 'This read is outside the task folder.' }] : [];
        const answer = await host.ask(session.id, describeClaudeTool(input.tool_name, input.tool_input, extra), context?.signal);
        allow = answer.allow === true;
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'Approved in Haven for this call.' : 'Not approved in Haven or outside this task’s selected connection.' } };
    }] }] },
    ...(channels.length ? { extraArgs: { channels: channels.join(',') } } : {}),
  };
}
