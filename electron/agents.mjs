import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeProfileOptions, gatedServers } from './permissions.mjs';
import { approvalRequest, describeClaudeTool, describeCodexRequest } from './approval.mjs';
import { normalizeConnection } from './connections.mjs';
import { stopProcess, bounded } from './processes.mjs';
import { codexContextUsage, claudeContextUsage, codexProviderUsage, claudeProviderUsage } from './usage.mjs';

export function executable(name) {
  for (const dir of [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(':')]) {
    const candidate = path.join(dir, name); try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`${name} was not found. Install it and sign in from a terminal first.`);
}
export function agentEnv(source = process.env) {
  const keys = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', 'TERM', 'COLORTERM', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HAVEN_TEST_MODE', 'HAVEN_DATA_DIR'];
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => typeof value === 'string' && (keys.includes(key) || /^LC_[A-Z_]+$/.test(key))));
  env.PATH = `${path.join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:${source.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
  return env;
}
// The installed native Claude CLI defaults Artifact off for SDK entrypoints.
// Opt in per child process; retain explicit user/environment opt-outs.
// Only the profile's own allow rules are passed: Normal adds none, so Grep and
// Glob keep Claude Code's usual prompt outside the working folder.
/** @param {Partial<import('@anthropic-ai/claude-agent-sdk').Options>} profile
 * @returns {Partial<import('@anthropic-ai/claude-agent-sdk').Options>} */
export function claudeToolOptions(profile = {}, source = process.env) {
  return { ...profile, tools: { type: 'preset', preset: 'claude_code' },
    ...(profile.allowedTools ? { allowedTools: [...profile.allowedTools] } : {}),
    env: { ...agentEnv(source), CLAUDE_CODE_ARTIFACT: source.CLAUDE_CODE_ARTIFACT ?? '1',
      ...(source.CLAUDE_CODE_DISABLE_ARTIFACT ? { CLAUDE_CODE_DISABLE_ARTIFACT: source.CLAUDE_CODE_DISABLE_ARTIFACT } : {}) },
  };
}
// Activity log only. Approvals never use this: see approval.mjs.
const clip = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).slice(0, 18000);
/** Keep provider IDs intact; resolved IDs make generic CLI labels useful in Haven.
 * @param {import('@anthropic-ai/claude-agent-sdk').ModelInfo[]} models */
export function claudeModels(models) {
  return models.map(model => {
    const match = /^(?:claude-)(opus|fable|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]+\])?$/.exec(model.resolvedModel || model.value);
    let label = model.displayName;
    if (match) {
      const family = match[1][0].toUpperCase() + match[1].slice(1), version = match[2] + (match[3] ? `.${match[3]}` : '');
      label = model.value === 'default' ? `${label} · ${family} ${version}` : label.replace(new RegExp(`^${family}(?=\\s*(?:\\(|$))`, 'i'), `${family} ${version}`);
    }
    return { value: model.value, label, efforts: model.supportedEffortLevels || [] };
  });
}
export class CodexAdapter {
  constructor(host) { this.host = host; this.pending = new Map(); this.threads = new Map(); this.childOwners = new Map(); this.seq = 0; this.discoveries = new Set(); }
  async connect() {
    if (this.ready) return this.ready;
    const attempt = (async () => {
      this.proc = spawn(executable('codex'), ['app-server', '--stdio'], { env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const proc = this.proc;
      this.stderr = '';
      this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
      this.proc.on('error', err => { if (this.proc === proc) this.fail(err); });
      this.proc.on('exit', () => { if (this.proc === proc) this.fail(new Error('Codex connection closed. ' + this.stderr.slice(-600))); });
      createInterface({ input: this.proc.stdout }).on('line', line => {
        try { this.receive(JSON.parse(line)).catch(err => this.host.log('Codex protocol: ' + err.message)); } catch (err) { this.host.log('Codex protocol: ' + err.message); }
      });
      await this.request('initialize', { clientInfo: { name: 'haven_workspace', title: 'Haven', version: '0.2.2' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    })();
    this.ready = attempt;
    try { return await attempt; }
    catch (error) {
      if (this.ready === attempt) { const proc = this.proc; this.proc = null; this.fail(error); await stopProcess(proc); }
      throw error;
    }
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.ready = null;
    for (const id of this.threads.values()) this.host.disconnected(id, error.message);
    this.threads.clear(); this.childOwners.clear();
  }
  write(message) { if (!this.proc?.stdin.writable) throw new Error('Codex is disconnected.'); this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params, timeout = 90000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async models({ fresh = false } = {}) {
    if (fresh) {
      // An updated executable must be queried without interrupting active turns.
      const discovery = new CodexAdapter(this.host); this.discoveries.add(discovery);
      try { this.modelCatalog = await bounded(() => discovery.models(), 20000); return this.modelCatalog; }
      finally { this.discoveries.delete(discovery); await discovery.close(); }
    }
    await this.connect(); const all = []; let cursor;
    do { const result = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }); all.push(...result.data); cursor = result.nextCursor; } while (cursor);
    this.modelCatalog = all.map(m => ({ value: m.model, label: m.displayName, efforts: m.supportedReasoningEfforts?.map(e => e.reasoningEffort) || [], defaultEffort: m.defaultReasoningEffort }));
    return this.modelCatalog;
  }
  async usage() {
    await this.connect();
    return codexProviderUsage(await this.request('account/rateLimits/read', {}, 15000));
  }
  async connections(session) {
    await this.connect();
    const config = await this.request('config/read', { cwd: session.cwd, includeLayers: false }, 15000);
    const configured = config.config?.mcp_servers || {};
    const live = !!session.remoteId && this.threads.has(session.remoteId);
    if (!live) return { source: 'Task configuration · start a conversation for live status', servers: Object.entries(configured).map(([name, value]) => normalizeConnection({ name }, value, false)), builtInTools: [] };
    const servers = []; let cursor;
    do {
      const result = await this.request('mcpServerStatus/list', { threadId: session.remoteId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) }, 15000);
      servers.push(...result.data); cursor = result.nextCursor;
    } while (cursor);
    for (const [name, value] of Object.entries(configured)) if (!servers.some(server => server.name === name)) servers.push({ name, ...{ config: value }, runtimeStatus: value.enabled === false ? 'disabled' : null });
    return { source: 'Live task connection', servers: servers.map(server => normalizeConnection(server, configured[server.name])), builtInTools: [] };
  }
  async steer(session, text, attachments) {
    if (!session.remoteId || !session.turnId || !this.threads.has(session.remoteId)) return false;
    const input = [{ type: 'text', text, text_elements: [] }, ...attachments.map(a => a.mime.startsWith('image/') ? { type: 'localImage', path: a.path } : { type: 'text', text: `Attached file ${JSON.stringify(a.name)} is available at ${JSON.stringify(a.path)}. Read it if relevant.`, text_elements: [] })];
    try { await this.request('turn/steer', { threadId: session.remoteId, expectedTurnId: session.turnId, input }, 15000); return true; }
    catch (error) {
      // Only an explicit rejection is safe to retry as a new turn. A timeout
      // could have reached the provider and must remain visible for review.
      if (/no active turn|not active|turn.*mismatch|expected.*turn|active turn.*not found|method not found/i.test(error.message)) return false;
      throw new Error('Follow-up delivery could not be confirmed. Review it before retrying.');
    }
  }
  async commands(session) {
    await this.connect();
    const result = await this.request('skills/list', { cwds: [session.cwd], forceReload: true });
    const entry = result.data.find(e => e.cwd === session.cwd);
    if (entry?.errors?.length) throw new Error(entry.errors.map(e => e.message).join('; '));
    return (entry?.skills || []).filter(s => s.enabled).map(s => ({ name: s.name, description: s.shortDescription || s.description, path: s.path, kind: 'skill' }));
  }
  async send(session, text, attachments, command, messageId) {
    const settings = { ...(session.turnSettings || session) };
    const autonomy = settings.profile === 'autonomous';
    await this.connect();
    if (!session.remoteId || !this.threads.has(session.remoteId)) {
      const result = await this.request(session.remoteId ? 'thread/resume' : 'thread/start', {
        ...(session.remoteId ? { threadId: session.remoteId } : {}), cwd: session.cwd,
      });
      // Capture the native policy before ever applying an autonomous turn override.
      session.nativePolicy ||= { approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox, approvalsReviewer: result.approvalsReviewer };
      session.nativeModel ||= result.model;
      if (!('nativeEffort' in session)) session.nativeEffort = result.reasoningEffort;
      session.remoteId = result.thread.id; this.threads.set(session.remoteId, session.id); this.host.persist();
      await this.request('thread/name/set', { threadId: session.remoteId, name: session.name }).catch(() => {});
    }
    /** @type {Array<{type: 'text', text: string, text_elements: unknown[]} | {type: 'localImage', path: string} | {type: 'skill', name: string, path: string}>} */
    const input = [{ type: 'text', text, text_elements: [] }];
    if (command) input.push({ type: 'skill', name: command.invocation || command.name, path: command.path });
    for (const a of attachments) {
      if (a.mime.startsWith('image/')) input.push({ type: 'localImage', path: a.path });
      else input.push({ type: 'text', text: `Attached file "${a.name}" is available at ${JSON.stringify(a.path)}. Read it if relevant.`, text_elements: [] });
    }
    if (session.stopRequested) { this.host.finish(session.id, null, true); return; }
    const model = settings.model || session.nativeModel;
    const modelDefault = this.modelCatalog?.find(m => m.value === model)?.defaultEffort;
    const effort = settings.effort || (settings.model ? modelDefault : session.nativeEffort) || modelDefault;
    const result = await this.request('turn/start', { threadId: session.remoteId, input,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(autonomy ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } : session.nativePolicy),
    });
    session.turnId = result.turn.id; this.host.persist();
    if (session.stopRequested) await this.stop(session);
  }
  async receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return;
    }
    const p = msg.params || {};
    // Account notifications have no thread ID and must be handled before routing tasks.
    if (msg.method === 'account/rateLimits/updated') { this.host.usage?.('codex', p, true); return; }
    const threadId = p.threadId || p.thread?.id, parentId = this.childOwners.get(threadId), id = this.threads.get(threadId) || parentId;
    if (!id) { if (msg.id !== undefined) this.write({ id: msg.id, error: { code: -32601, message: 'No matching Haven session' } }); return; }
    if (msg.id !== undefined) {
      try {
        let result;
        if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval') {
          const answer = await this.host.ask(id, describeCodexRequest(msg.method, p, this.host.session?.(id)?.cwd));
          result = { decision: answer.allow ? 'accept' : 'decline' };
        } else if (msg.method === 'item/permissions/requestApproval') {
          const answer = await this.host.ask(id, describeCodexRequest(msg.method, p));
          result = { permissions: answer.allow ? Object.fromEntries(Object.entries(p.permissions || {}).filter(([, v]) => v !== null)) : {}, scope: 'turn' };
        } else if (msg.method === 'item/tool/requestUserInput' || msg.method === 'tool/requestUserInput') {
          const answer = await this.host.ask(id, { title: 'Codex needs your input', kind: 'questions', questions: p.questions });
          result = { answers: Object.fromEntries((p.questions || []).map(q => [q.id, { answers: [answer.answers?.[q.id] || 'No answer provided'] }])) };
        } else if (msg.method === 'mcpServer/elicitation/request') {
          const answer = await this.host.ask(id, approvalRequest(p.message || 'A tool needs your input', [{ label: 'Request', value: p }], 'elicitation'));
          let content = null; if (answer.allow && answer.text) content = JSON.parse(answer.text);
          result = { action: answer.allow ? 'accept' : 'decline', content };
        } else {
          this.host.activity(id, randomUUID(), 'Unsupported request', `Codex requested ${msg.method}. Use a terminal session for this operation.`);
          this.write({ id: msg.id, error: { code: -32601, message: `Haven does not yet support ${msg.method}` } }); return;
        }
        this.write({ id: msg.id, result });
      } catch (error) { this.write({ id: msg.id, error: { code: -32603, message: error.message } }); }
      return;
    }
    if (parentId) {
      if (msg.method === 'turn/started') this.host.background(id, { id: threadId, status: 'running' });
      if (msg.method === 'turn/completed') this.host.background(id, { id: threadId, status: p.turn.status === 'failed' ? 'failed' : p.turn.status === 'interrupted' ? 'stopped' : 'completed', summary: p.turn.error?.message });
      return;
    }
    if (msg.method === 'thread/tokenUsage/updated') {
      const usage = codexContextUsage(p.tokenUsage);
      if (usage) this.host.context?.(id, usage);
      return;
    }
    if (['item/started', 'item/completed'].includes(msg.method) && p.item?.type === 'collabAgentToolCall') {
      const item = p.item;
      for (const child of item.receiverThreadIds || []) {
        this.childOwners.set(child, id);
        const state = item.agentsStates?.[child];
        this.host.background(id, { id: child, description: item.prompt || undefined, status: ({ pendingInit: 'starting', running: 'running', completed: 'completed', errored: 'failed', interrupted: 'stopped', shutdown: 'stopped', notFound: 'unknown' })[state?.status] || 'running', summary: state?.message || undefined });
      }
    }
    if (msg.method === 'item/agentMessage/delta') this.host.delta(id, p.itemId, p.delta);
    if (msg.method === 'turn/started') { this.host.session(id).turnId = p.turn.id; }
    if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const item = p.item;
      if (item.type === 'agentMessage' && msg.method === 'item/completed') this.host.completeText(id, item.id, item.text || '');
      else if (!['agentMessage', 'userMessage', 'reasoning'].includes(item.type)) {
        const title = item.command || item.tool || ({ fileChange: 'File changes', webSearch: 'Web search', mcpToolCall: 'Tool call' }[item.type]) || item.type;
        this.host.activity(id, item.id, title, clip(item.aggregatedOutput || item.changes || item.arguments || item), msg.method === 'item/completed');
      }
    }
    if (msg.method === 'item/commandExecution/outputDelta') this.host.activityDelta(id, p.itemId, p.delta);
    if (msg.method === 'error') this.host.activity(id, randomUUID(), 'Codex notice', p.error?.message || clip(p));
    if (msg.method === 'turn/completed') this.host.finish(id, p.turn.status === 'failed' ? (p.turn.error?.message || 'Codex could not complete this turn.') : null, p.turn.status === 'interrupted');
  }
  async stop(s) { if (s.remoteId && s.turnId) await this.request('turn/interrupt', { threadId: s.remoteId, turnId: s.turnId }); }
  closeSession(id) { for (const [thread, sessionId] of this.threads) if (sessionId === id) this.threads.delete(thread); for (const [thread, sessionId] of this.childOwners) if (sessionId === id) this.childOwners.delete(thread); }
  async close() { const proc = this.proc; this.proc = null; this.fail(new Error('Codex connection closed.')); await Promise.allSettled([stopProcess(proc), ...[...this.discoveries].map(discovery => discovery.close())]); }
}

class InputQueue {
  values = []; waiting = []; closed = false;
  push(value) { if (this.closed) throw new Error('Claude session is closed.'); const next = this.waiting.shift(); next ? next({ value, done: false }) : this.values.push(value); }
  end() { this.closed = true; for (const next of this.waiting.splice(0)) next({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(r => this.waiting.push(r)); }
}
export class ClaudeAdapter {
  constructor(host) { this.host = host; this.clients = new Map(); this.children = new Set(); this.modelDiscoveries = new Set(); }
  spawnProcess = ({ command, args, cwd, env, signal }) => {
    const proc = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(proc); proc.once('exit', () => this.children.delete(proc));
    proc.stderr.on('data', data => this.host.log?.('Claude: ' + String(data).slice(-1000)));
    return proc;
  };
  /** @returns {import('@anthropic-ai/claude-agent-sdk').Options} */
  discoveryOptions() {
    return { cwd: os.homedir(), pathToClaudeCodeExecutable: executable('claude'), env: agentEnv(),
      // Background model and usage discovery has no task: user settings only, so
      // no folder's project hooks or MCP servers start on the 5-minute refresh.
      settingSources: ['user'], spawnClaudeCodeProcess: this.spawnProcess };
  }
  discovery() { return query({ prompt: new InputQueue(), options: this.discoveryOptions() }); }
  async models() {
    // supportedModels() is cached at SDK initialization, so existing task clients
    // cannot discover a newly installed CLI or an updated account model catalog.
    const discovery = this.discovery(); this.modelDiscoveries.add(discovery);
    try {
      return claudeModels(await bounded(() => discovery.supportedModels(), 20000));
    } finally { this.modelDiscoveries.delete(discovery); discovery.close(); }
  }
  async usage() {
    if (this.usageLoad) return this.usageLoad;
    const existing = this.clients.values().next().value;
    const discovery = existing?.query || this.discovery();
    if (!existing) this.usageDiscovery = discovery;
    this.usageLoad = (async () => {
      try {
        // A control request, never a user/model turn. Do not scan unrelated transcripts.
        const result = await bounded(() => discovery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 15000);
        return claudeProviderUsage(result);
      } finally {
        if (!existing) discovery.close();
        if (this.usageDiscovery === discovery) this.usageDiscovery = null;
        this.usageLoad = null;
      }
    })();
    return this.usageLoad;
  }
  async refreshContext(session, client, force = false) {
    if (typeof client.query.getContextUsage !== 'function') return;
    if (client.contextLoad) { if (force) client.contextAgain = true; return client.contextLoad; }
    if (!force && Date.now() - (client.contextReadAt || 0) < 5000) return;
    client.contextLoad = (async () => {
      do {
        client.contextAgain = false; client.contextReadAt = Date.now();
        try {
          // Summary uses the CLI's latest response and local estimates, without token-count API calls.
          const result = await bounded(() => client.query.getContextUsage({ detail: 'summary' }), 15000);
          if (this.clients.get(session.id) !== client) return;
          const usage = claudeContextUsage(result);
          if (usage) this.host.context?.(session.id, usage);
        } catch { /* Keep the dated last observation when this CLI cannot answer. */ }
      } while (client.contextAgain && this.clients.get(session.id) === client);
    })();
    try { await client.contextLoad; } finally { client.contextLoad = null; }
  }
  async open(session, settings = session.turnSettings || session) {
    if (this.clients.has(session.id)) return this.clients.get(session.id);
    const input = new InputQueue();
    const projectTrusted = this.host.trusted?.(session.cwd) === true;
    /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
    const options = { cwd: session.cwd, pathToClaudeCodeExecutable: executable('claude'), env: agentEnv(), spawnClaudeCodeProcess: this.spawnProcess,
      ...claudeToolOptions(claudeProfileOptions({ ...session, ...settings, projectTrusted }, this.host, settings.profile === 'gated' ? gatedServers() : {})), includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(session.remoteId && session.hasConversation ? { resume: session.remoteId } : {}), ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      stderr: data => this.host.log('Claude: ' + data.slice(-1000)),
      canUseTool: async (name, toolInput, context) => {
        const questions = name === 'AskUserQuestion' && Array.isArray(toolInput.questions) ? toolInput.questions.filter(q => q && typeof q.question === 'string').map((q, i) => ({ ...q, id: q.question || String(i) })) : undefined;
        const answer = await this.host.ask(session.id, questions ? { title: 'Claude needs your input', kind: 'questions', questions }
          : describeClaudeTool(name, toolInput, [{ label: 'Why this needs approval', value: context.decisionReason }, { label: 'Outside path', value: context.blockedPath }]), context.signal);
        if (questions) return answer.allow ? { behavior: 'allow', updatedInput: { ...toolInput, answers: answer.answers || {} } } : { behavior: 'deny', message: 'The user skipped this question.' };
        return answer.allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'Declined by the user.' };
      },
    };
    const client = { input, query: query({ prompt: input, options }), profile: settings.profile, projectTrusted, gatedServer: settings.gatedServer, model: settings.model, effort: settings.effort, messageId: '', pendingInputs: new Set(), tools: [] };
    this.clients.set(session.id, client);
    this.consume(session, client).catch(err => {
      if (this.clients.get(session.id) === client) { this.clients.delete(session.id); this.host.disconnected(session.id, err.message); }
    });
    return client;
  }
  // A folder trusted or untrusted since this client connected needs a new transport.
  trustChanged(session, client) { return (client.projectTrusted === true) !== (this.host.trusted?.(session.cwd) === true); }
  async connections(session) {
    const settings = session.turnSettings || session;
    let client = this.clients.get(session.id);
    if (client && !['working', 'starting', 'waiting'].includes(session.status) && (client.outdated || client.profile !== settings.profile || client.gatedServer !== settings.gatedServer || client.effort !== settings.effort || this.trustChanged(session, client))) { this.closeSession(session.id); client = null; }
    client ||= await this.open(session, settings);
    const servers = await bounded(() => client.query.mcpServerStatus(), 20000);
    // Keep this task's transport alive: MCP initialization continues after the
    // first status reply, and the next check must observe the same connection.
    return { source: 'Live task connection', servers: servers.map(server => normalizeConnection(server)), builtInTools: (client.tools || []).filter(name => !name.startsWith('mcp__')) };
  }
  async steer(session, text, attachments, messageId) {
    const client = this.clients.get(session.id);
    if (!client?.input || !client.supportsInputTracking) return false;
    this.pushInput(session, client, text, attachments, undefined, messageId);
    return true;
  }
  pushInput(session, client, text, attachments, command, messageId) {
    /** @type {any[]} */
    const content = [{ type: 'text', text }];
    for (const a of attachments) {
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime)) content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } });
      else content.push({ type: 'text', text: `Attached file ${JSON.stringify(a.name)} is available at ${JSON.stringify(a.path)}. Read it if relevant.` });
    }
    const uuid = messageId || randomUUID();
    client.pendingInputs ||= new Set();
    client.pendingInputs.add(uuid);
    try { client.input.push({ type: 'user', uuid, message: { role: 'user', content: command && !attachments.length ? text : content }, parent_tool_use_id: null, session_id: session.remoteId || '' }); }
    catch (error) { client.pendingInputs.delete(uuid); throw error; }
  }
  async commands(session) {
    const existing = this.clients.has(session.id);
    const client = await this.open(session);
    try {
    const commands = await client.query.supportedCommands();
    // Local terminal controls belong to Haven. Only headless built-ins and user skills are dispatched.
    const headless = ['compact', 'context', 'cost', 'usage', 'stats'];
    const local = ['model', 'effort', 'clear', 'new', 'exit', 'quit', 'close', 'help', 'commands', 'skills', 'status', 'stop', 'rename', 'config', 'theme', 'terminal-setup', 'statusline', 'resume'];
    const supported = commands.filter(c => !local.includes(c.name) && !c.description?.startsWith('(removed)') && (!c.builtin || headless.includes(c.name)));
    return supported.flatMap(c => [c.name, ...(c.aliases || [])].filter(name => !local.includes(name)).map(name => ({ name, description: c.description, argumentHint: c.argumentHint, kind: c.builtin || headless.includes(c.name) ? 'provider' : 'skill' })));
    } finally { if (!existing && !['working', 'starting', 'waiting'].includes(session.status) && this.clients.get(session.id) === client) this.closeSession(session.id); }
  }
  async send(session, text, attachments, command, messageId) {
    const settings = { ...(session.turnSettings || session) };
    let client = this.clients.get(session.id);
    // Restart the transport between turns to apply changed permission/effort settings, resuming the same conversation.
    if (client && (client.outdated || client.profile !== settings.profile || client.effort !== settings.effort || client.gatedServer !== settings.gatedServer || this.trustChanged(session, client))) { this.closeSession(session.id); client = null; }
    client ||= await this.open(session, settings); client.effort = settings.effort;
    if (client.model !== settings.model) { await client.query.setModel(settings.model || undefined); client.model = settings.model; }
    if (session.stopRequested) { this.host.finish(session.id, null, true); return; }
    this.pushInput(session, client, text, attachments, command, messageId);
    // A task's initialization-cached catalog must not overwrite fresh discovery.
  }
  async consume(session, client) {
    for await (const msg of client.query) {
      if (this.clients.get(session.id) !== client) break;
      if (msg.session_id) { session.remoteId = msg.session_id; this.host.persist(); }
      if (msg.type === 'rate_limit_event') this.host.refreshUsage?.('claude');
      if (msg.type === 'assistant' && !msg.parent_tool_use_id && msg.context_usage) {
        const usage = claudeContextUsage(msg.context_usage); if (usage) this.host.context?.(session.id, usage);
      }
      if (msg.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(msg.subtype)) {
        this.host.background(session.id, { id: msg.task_id, description: msg.description, kind: msg.subagent_type || msg.task_type, status: msg.subtype === 'task_notification' ? msg.status : 'running', summary: msg.summary, usage: msg.usage, ambient: msg.ambient });
      }
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        for (const task of msg.tasks) this.host.background(session.id, { id: task.task_id, description: task.description, kind: task.task_type, status: 'running', ambient: task.ambient });
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        client.tools = msg.tools || [];
        // Current CLI results expose consumed UUIDs and pending turn counts.
        client.supportsInputTracking = typeof msg.claude_code_version === 'string' && /^2\.1\./.test(msg.claude_code_version) && Number(msg.claude_code_version.split('.')[2]) >= 278;
        this.host.activity(session.id, 'claude-init', 'Claude connected', `${msg.model || 'Default model'} · ${msg.tools?.length || 0} tools · ${client.profile !== 'normal' ? 'user settings loaded' : client.projectTrusted ? 'user and project settings loaded' : 'user settings loaded. This folder’s project settings, hooks and MCP servers were not loaded because the folder is not trusted'}\n\n${(msg.tools || []).join(', ')}`, true);
        void this.refreshContext(session, client, true);
      }
      if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
        const e = msg.event;
        if (e.type === 'message_start') client.messageId = e.message.id;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.host.delta(session.id, client.messageId, e.delta.text);
      }
      if (msg.type === 'assistant') {
        session.hasConversation = true;
        const content = msg.message.content;
        for (const block of content) {
          if (block.type === 'tool_use') this.host.activity(session.id, block.id, block.name, clip(block.input));
        }
        if (!msg.parent_tool_use_id) {
          void this.refreshContext(session, client);
          const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
          if (text) this.host.completeText(session.id, msg.message.id, text);
        }
      }
      if (msg.type === 'user' && Array.isArray(msg.message.content)) for (const block of msg.message.content) {
        if (block.type === 'tool_result') this.host.activityResult(session.id, block.tool_use_id, clip(block.content));
      }
      if (msg.type === 'system' && msg.subtype === 'api_retry') this.host.activity(session.id, randomUUID(), 'Retrying connection', clip(msg));
      if (msg.type === 'system' && msg.subtype === 'local_command_output') this.host.completeText(session.id, msg.uuid || randomUUID(), msg.content);
      if (msg.type === 'result') {
        client.pendingInputs ||= new Set();
        if (Array.isArray(msg.user_message_uuids)) client.supportsInputTracking = true;
        const consumed = msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : []);
        if (consumed.length) for (const uuid of consumed) client.pendingInputs.delete(uuid);
        else client.pendingInputs.delete(client.pendingInputs.values().next().value);
        if (client.pendingInputs.size && !msg.is_error && !session.stopRequested) continue;
        if (msg.is_error && client.pendingInputs.size) this.closeSession(session.id);
        void this.refreshContext(session, client, true);
        if (!msg.is_error) session.hasConversation = true;
        if (msg.is_error) this.host.finish(session.id, msg.errors?.join('\n') || msg.result || 'Claude could not complete this turn.');
        else this.host.finish(session.id);
      }
    }
    if (this.clients.get(session.id) === client) { this.clients.delete(session.id); this.host.disconnected(session.id, 'Claude connection closed. Reopen or send a message to resume.'); }
  }
  async stop(session) {
    try { await this.clients.get(session.id)?.query.interrupt(); }
    finally { this.closeSession(session.id); this.host.finish(session.id, null, true); }
  }
  // New turns should use the new CLI's alias mapping; current turns keep running.
  markUpdated() { for (const client of this.clients.values()) client.outdated = true; }
  closeSession(id) { const c = this.clients.get(id); this.clients.delete(id); c?.input.end(); c?.query.close(); }
  async close() { this.usageDiscovery?.close(); for (const discovery of this.modelDiscoveries) discovery.close(); for (const id of this.clients.keys()) this.closeSession(id); await Promise.allSettled([...this.children].map(p => stopProcess(p))); }
}
