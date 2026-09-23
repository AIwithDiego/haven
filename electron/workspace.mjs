import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import { Store, Attachments, canonicalFolder, busy, sharedNotice, projectsFromLauncher, recordEvent, startClock, stopClock } from './core.mjs';
import { gatedServers } from './permissions.mjs';
import { resolvePython } from './validation.mjs';
import { stopProcess, bounded } from './processes.mjs';
import { StatePublisher } from './patches.mjs';
import { commands, parseCommand, mergeCommands } from './commands.mjs';
import { CodexAdapter, ClaudeAdapter, agentEnv, executable } from './agents.mjs';
import { codexProviderUsage, normalizeStoredContext, unavailableUsage } from './usage.mjs';

export class Workspace extends EventEmitter {
  constructor(root, helpers) {
    super(); this.store = new Store(root); this.helpers = helpers;
    this.attachments = new Attachments(path.join(root, 'temporary-attachments'));
    if (!this.store.storage.readOnly && !this.store.state.recoveryPending) this.attachments.sweep(this.store.state.sessions.flatMap(s => [...(s.attachments || []), ...(s.pendingMessages || []).flatMap(q => q.attachments)]));
    for (const s of this.store.state.sessions) {
      for (const m of s.messages) if (!(s.pendingMessages || []).some(q => q.id === m.id)) for (const a of m.attachments || []) a.expired = true;
      s.inFlightAttachments = []; delete s.stopRequested;
      for (const entry of s.pendingMessages || []) { entry.paused = true; const message = s.messages.find(m => m.id === entry.id); if (message) message.delivery = 'paused'; }

      for (const work of s.backgroundWork || []) if (['running', 'starting'].includes(work.status)) work.status = 'unknown';
    }
    this.watchers = new Map(); this.changes = new Map(); this.approvals = new Map(); this.terminals = new Map(); this.updates = {};
    this.followupLoads = new Map(); this.deferredFinishes = new Map(); this.connectionLoads = new Map();
    this.commandCache = new Map(); this.commandLoads = new Map(); this.sending = new Set();
    this.agentRefreshLoads = new Map(); this.allowTestModels = false;
    this.providerUsage = { claude: unavailableUsage(), codex: unavailableUsage() }; this.usageLoads = new Map();
    this.usageVersions = {}; this.usageReadAt = {}; this.usageEventTimers = new Map(); this.allowTestUsage = false;
    this.publisher = new StatePublisher(); this.dirtyTasks = new Set(); this.allDirty = false;
    this.projects = projectsFromLauncher(); this.gatedConnections = Object.keys(gatedServers());
    this.heartbeat = setInterval(() => { if (this.store.state.sessions.some(s => s.runningSince != null)) this.store.save(); }, 5000);
    this.heartbeat.unref();
    this.modelLists = { claude: [{ value: '', label: 'Claude default', efforts: [] }, { value: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }], codex: [{ value: '', label: 'Codex default', efforts: [] }] };
    this.voice = { status: 'off' }; this.voiceProcess = null; this.diagnostics = {};
    const host = {
      session: id => this.store.get(id), persist: () => this.store.changed(), log: message => this.emit('log', message),
      context: (id, value) => {
        const s = this.store.state.sessions.find(s => s.id === id), usage = normalizeStoredContext(value);
        if (!s || s.engine === 'terminal' || !usage || this.shuttingDown) return;
        const model = usage.model || s.turnSettings?.model || s.model || s.nativeModel;
        s.contextUsage = { ...usage, ...(model ? { model } : {}) }; this.store.changed(id);
      },
      usage: (engine, value, sparse = false) => {
        if (this.shuttingDown) return;
        this.usageVersions[engine] = (this.usageVersions[engine] || 0) + 1;
        this.providerUsage[engine] = sparse ? codexProviderUsage(value, Date.now(), this.providerUsage[engine]) : value;
        this.publish();
      },
      refreshUsage: engine => this.scheduleUsageRefresh(engine),
      delta: (id, item, text) => this.store.append(id, item, text),
      completeText: (id, item, text) => { const m = this.store.get(id).messages.find(m => m.itemId === item); if (m) { m.text = text || m.text; m.complete = true; this.store.changed(); } else if (text) this.store.add(id, 'assistant', text, { itemId: item, complete: true }); },
      activity: (id, item, title, text, done = false) => { const s = this.store.get(id); let m = s.messages.find(m => m.itemId === item); if (!m) m = this.store.add(id, 'activity', '', { itemId: item }); Object.assign(m, { title, text, complete: done }); this.store.changed(); },
      activityDelta: (id, item, text) => { const m = this.store.get(id).messages.find(m => m.itemId === item); if (m) { m.text = (m.text + text).slice(-18000); this.store.changed(); } },
      activityResult: (id, item, text) => { const m = this.store.get(id).messages.find(m => m.itemId === item); if (m) { m.text += '\n\n' + text; m.complete = true; this.store.changed(); } },
      background: (id, update) => {
        const s = this.store.get(id); s.backgroundWork ||= [];
        let work = s.backgroundWork.find(work => work.id === update.id);
        if (!work) { work = { id: update.id, description: 'Background agent' }; s.backgroundWork.push(work); }
        Object.assign(work, Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, key === 'summary' ? 4000 : 2000) : value])), { updatedAt: Date.now() });
        const active = s.backgroundWork.filter(work => ['running', 'starting'].includes(work.status));
        s.backgroundWork = [...active, ...s.backgroundWork.filter(work => !active.includes(work)).slice(-30)];
        this.store.changed(id);
      },
      ask: (...args) => this.ask(...args), trusted: cwd => this.trusted(cwd), finish: (...args) => this.finish(...args), disconnected: (id, error) => { try { const s = this.store.get(id); for (const work of s.backgroundWork || []) if (['running', 'starting'].includes(work.status)) work.status = 'unknown'; this.store.changed(id); if (busy(s)) this.finish(id, error); } catch {} },
    };
    this.codex = new CodexAdapter(host); this.claude = new ClaudeAdapter(host);
    this.store.on('change', id => this.publish(id));
    this.syncWatchers();
  }
  snapshot() {
    return { ...this.store.state, revision: this.publisher.revision, storage: this.store.storage, home: os.homedir(), gatedConnections: this.gatedConnections, projects: this.projects, models: this.modelLists,
      changes: Object.fromEntries(this.changes), diagnostics: this.diagnostics, voice: this.voice, updates: this.updates, providerUsage: this.providerUsage,
      sessions: this.store.state.sessions.map(s => { const { terminalBuffer, inFlightAttachments, ...task } = s; return { ...task, attachments: s.attachments.map(a => { const { preview, ...attachment } = a; return attachment; }) }; }) };
  }
  publish(id) {
    if (typeof id === 'string') this.dirtyTasks.add(id); else this.allDirty = true;
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      const update = this.publisher.next(this.snapshot(), this.allDirty ? null : this.dirtyTasks);
      this.dirtyTasks = new Set(); this.allDirty = false;
      if (update?.full) this.emit('state', update.full); else if (update?.patch) this.emit('patch', update.patch);
    }, 45);
  }
  async refresh() {
    this.projects = projectsFromLauncher(); this.gatedConnections = Object.keys(gatedServers());
    await Promise.allSettled(['claude', 'codex'].map(engine => this.refreshAgent(engine)));
    this.publish();
    await this.refreshUsage();
    if (!this.usageTimer && !this.shuttingDown) {
      this.usageTimer = setInterval(() => { if (!this.suspended?.size) { void this.refreshUsage(); void this.checkAgentUpdates(); } }, 5 * 60 * 1000);
      this.usageTimer.unref();
    }
  }
  async refreshAgent(engine, { onlyChanged = false, afterUpdate = false } = {}) {
    if (!['claude', 'codex'].includes(engine)) throw new Error('Unknown agent.');
    if (this.shuttingDown || (this.updates[engine]?.running && !afterUpdate)) return;
    if (process.env.HAVEN_TEST_MODE === '1' && !this.allowTestModels) return;
    if (this.agentRefreshLoads.has(engine)) return this.agentRefreshLoads.get(engine);
    const load = (async () => {
      const previous = this.diagnostics[engine];
      let binary, version;
      try { binary = executable(engine); version = await this.runCapture(binary, ['--version']); }
      catch (err) { if (!this.shuttingDown) { this.diagnostics[engine] = { installed: false, error: err.message }; this.publish(); } return; }
      if (this.shuttingDown) return;
      const changed = previous?.binary !== binary || previous?.version !== version;
      if (onlyChanged && !changed && previous?.connected) return;
      if (changed && previous?.installed) this[engine].markUpdated?.();
      this.diagnostics[engine] = { installed: true, binary, version }; this.publish();
      try {
        const models = await this[engine].models({ fresh: true });
        if (this.shuttingDown) return;
        if (JSON.stringify(models) !== JSON.stringify(this.modelLists[engine])) this[engine].markUpdated?.();
        this.modelLists[engine] = models; this.diagnostics[engine].connected = true;
        if (changed || afterUpdate) for (const session of this.store.state.sessions) if (session.engine === engine) {
          for (const key of this.commandCache.keys()) if (key.startsWith(`${session.id}:`)) this.commandCache.delete(key);
        }
      } catch (err) { if (!this.shuttingDown) this.diagnostics[engine].error = `Could not refresh models: ${err.message}`; }
      if (!this.shuttingDown) this.publish();
    })();
    this.agentRefreshLoads.set(engine, load);
    try { await load; } finally { this.agentRefreshLoads.delete(engine); }
  }
  async checkAgentUpdates() {
    await Promise.allSettled(['claude', 'codex'].map(engine => this.refreshAgent(engine, { onlyChanged: true })));
  }
  async refreshUsage(engine) {
    if (engine !== undefined && !['claude', 'codex'].includes(engine)) throw new Error('Unknown agent.');
    if (this.shuttingDown) return this.providerUsage;
    // Isolated UI previews must not start provider processes, even through a refresh button.
    if (process.env.HAVEN_TEST_MODE === '1' && !this.allowTestUsage) return this.providerUsage;
    await Promise.allSettled((engine ? [engine] : ['claude', 'codex']).map(async name => {
      if (this.usageLoads.has(name)) return this.usageLoads.get(name);
      if (this.updates[name]?.running) return;
      clearTimeout(this.usageEventTimers.get(name)); this.usageEventTimers.delete(name);
      if (this.diagnostics[name]?.installed === false) {
        this.providerUsage[name] = unavailableUsage(`${name === 'codex' ? 'Codex' : 'Claude'} is not installed.`); this.publish(); return;
      }
      const previous = this.providerUsage[name];
      const version = this.usageVersions[name] || 0; this.usageReadAt[name] = Date.now();
      this.providerUsage[name] = { ...previous, status: 'loading', message: undefined }; this.publish();
      const load = (async () => {
        try {
          const value = await this[name].usage();
          if (!this.shuttingDown && version === (this.usageVersions[name] || 0)) this.providerUsage[name] = value;
        } catch {
          // Do not surface raw provider/auth errors in the sidebar. Retain dated last data.
          if (!this.shuttingDown && version === (this.usageVersions[name] || 0)) this.providerUsage[name] = { ...this.providerUsage[name], status: 'error', message: 'Could not refresh usage. Check the agent connection and try again.' };
        } finally { this.usageLoads.delete(name); if (!this.shuttingDown) this.publish(); }
      })();
      this.usageLoads.set(name, load); return load;
    }));
    return this.providerUsage;
  }
  scheduleUsageRefresh(engine) {
    if (this.shuttingDown || this.usageEventTimers.has(engine)) return;
    // A burst of stream/header events needs one account read, not a request per event.
    const delay = Math.max(0, 15000 - (Date.now() - (this.usageReadAt[engine] || 0)));
    if (!delay) { void this.refreshUsage(engine); return; }
    const timer = setTimeout(() => { this.usageEventTimers.delete(engine); void this.refreshUsage(engine); }, delay);
    timer.unref(); this.usageEventTimers.set(engine, timer);
  }
  runCapture(binary, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(binary, args, { env: agentEnv() }); let out = '', err = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('Command timed out.')); }, 20000);
      p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
      p.on('error', e => { clearTimeout(timer); reject(e); }); p.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-1000) || 'Command failed.')); });
    });
  }
  create(input) { const s = this.store.create(input); if (input.trustFolder === true && s.engine === 'claude') this.trustFolder(s.id, true); this.syncWatchers(); if (s.engine === 'terminal') this.startTerminal(s.id); return s.id; }
  patch(id, patch) {
    const s = this.store.get(id);
    if ('model' in patch && patch.model && !this.modelLists[s.engine]?.some(m => m.value === patch.model)) throw new Error('Choose an available model, or refresh the model list in Settings.');
    return this.store.patch(id, patch);
  }
  suspend(at = Date.now()) {
    this.suspended = new Set(this.store.state.sessions.filter(s => s.runningSince != null).map(s => s.id));
    for (const s of this.store.state.sessions) stopClock(s, at);
    this.store.changed(); this.store.save();
  }
  resume(at = Date.now()) {
    for (const s of this.store.state.sessions) if (this.suspended?.has(s.id) && ['working', 'starting', 'running'].includes(s.status)) startClock(s, at);
    this.suspended?.clear(); this.store.changed();
    if (this.usageTimer) { void this.refreshUsage(); void this.checkAgentUpdates(); }
  }
  syncWatchers() {
    const groups = new Map();
    for (const s of this.store.state.sessions.filter(s => !s.archived && !s.closed && s.engine !== 'terminal')) groups.set(s.cwd, (groups.get(s.cwd) || 0) + 1);
    for (const [cwd, watcher] of this.watchers) if ((groups.get(cwd) || 0) < 2) { watcher.close(); this.watchers.delete(cwd); }
    for (const [cwd, count] of groups) if (count > 1 && !this.watchers.has(cwd)) {
      if (cwd === os.homedir() || cwd === '/') continue;
      const watcher = chokidar.watch(cwd, { ignoreInitial: true, depth: 12,
        ignored: file => file.split(path.sep).some(part => ['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '.DS_Store'].includes(part)) || /(^|\/)\.env([./]|$)/.test(file),
      });
      watcher.on('all', (kind, file) => {
        const list = this.changes.get(cwd) || []; const relative = path.relative(cwd, file);
        if (!relative || relative.startsWith('..')) return;
        const duplicate = list.findIndex(e => e.file === relative); if (duplicate >= 0) list.splice(duplicate, 1);
        list.push({ file: relative, kind, at: Date.now() }); this.changes.set(cwd, list.slice(-60)); this.publish();
      });
      watcher.on('error', error => {
        const message = `File tracking needs attention for ${cwd}: ${error instanceof Error ? error.message : String(error)}`;
        this.emit('log', message);
        this.store.storage.notices = [...new Set([...this.store.storage.notices, message])].slice(-10); this.publish();
      }); this.watchers.set(cwd, watcher);
    }
  }
  async send(id, text, attachmentIds = [], mode = 'auto', queued = null) {
    const s = this.store.get(id); if (s.engine === 'terminal') throw new Error('Use the terminal input.');
    if (typeof text !== 'string' || text.length > 200000) throw new Error('Message is too long.');
    const parsed = parseCommand(text);
    if (parsed && commands.some(c => c.name === parsed.name)) { const result = await this.runCommand(s, parsed); s.draft = ''; this.store.changed(); return { ...result, draftHandled: true, draftRevision: s.draftRestoredRevision || 0 }; }
    if (s.closed || s.archived || s.closeRequested) throw new Error('Reopen this task before sending.');
    if (!['auto', 'queue'].includes(mode)) throw new Error('Choose a valid delivery mode.');
    if (s.stopRequested) throw new Error('Wait for this task to stop before sending.');
    if (this.sending.has(id)) throw new Error('A message is already being prepared.');
    if (this.updates[s.engine]?.running) throw new Error('Wait for the update to finish.');
    this.sending.add(id);
    try {
    let command;
    if (parsed) {
      const catalog = await this.listCommands(id);
      command = catalog.commands.find(c => c.name === parsed.name && c.kind !== 'haven');
      if (!command) throw new Error(catalog.error || `/${parsed.name} is not available here. Use /help to browse, or // to send a literal slash.`);
      if (!this.store.state.sessions.includes(s) || s.closed || s.archived || s.closeRequested) throw new Error('This task was closed while preparing the command.');
    }
    const attachments = queued?.attachments || attachmentIds.map(aid => { const a = s.attachments.find(a => a.id === aid && !a.expired); if (!a) throw new Error('An attachment is missing.'); return a; });
    if (!text.trim() && !attachments.length) return;
    if (busy(s) && !queued) {
      s.pendingMessages ||= [];
      if (s.pendingMessages.length >= 100) throw new Error('There are 100 queued messages. Let these finish first.');
      const message = this.store.add(id, 'user', text.replace(/^(\s*)\/\//, '$1/'), { delivery: 'queued', attachments: attachments.map(a => ({ id: a.id, name: a.name, mime: a.mime, comment: a.comment })) });
      const entry = { id: message.id, text, attachments, at: Date.now(), mode, command: !!command, paused: false };
      s.pendingMessages.push(entry); s.attachments = s.attachments.filter(a => !attachmentIds.includes(a.id)); s.draft = '';
      this.store.changed(id); this.store.save();
      void this.deliverFollowups(id);
      return { draftHandled: true, draftRevision: s.draftRestoredRevision || 0 };
    }
    const notice = sharedNotice(this.store.state.sessions, s, this.changes.get(s.cwd) || []);
    const userMessage = queued ? s.messages.find(m => m.id === queued.id) : this.store.add(id, 'user', command ? text : text.replace(/^(\s*)\/\//, '$1/'), { attachments: attachments.map(a => ({ id: a.id, name: a.name, mime: a.mime, comment: a.comment })) });
    if (queued) { s.pendingMessages = s.pendingMessages.filter(q => q !== queued); if (userMessage) userMessage.delivery = 'sent'; }
    s.inFlightDraft = text; const draftRevision = s.draftRestoredRevision || 0;
    s.inFlightAttachments = attachments; s.attachments = s.attachments.filter(a => !attachmentIds.includes(a.id));
    s.turnSettings = { profile: s.profile, gatedServer: s.gatedServer, model: s.model, effort: s.effort };
    s.status = 'working'; s.error = null; s.stopRequested = false; if (!queued) s.draft = ''; s.lastTurnAt = Date.now();
    startClock(s); recordEvent(s, 'Running'); this.store.changed();
    if (notice) this.store.add(id, 'system', notice);
    const comments = attachments.filter(a => a.comment).map(a => `Comment on attachment ${JSON.stringify(a.name)}: ${a.comment}`).join('\n\n');
    const commandText = command ? (s.engine === 'claude' ? `/${command.invocation || command.name}${parsed.args ? ' ' + parsed.args : ''}` : `Use the ${command.invocation || command.name} skill.${parsed.args ? '\n\n' + parsed.args : ''}`) : text.replace(/^(\s*)\/\//, '$1/');
    const prompt = (command ? [commandText, notice, comments] : [notice, commandText, comments]).filter(Boolean).join('\n\n');
    this[s.engine].send(s, prompt, attachments, command, userMessage?.id).then(() => this.deliverFollowups(id)).catch(err => this.finish(id, s.stopRequested ? null : err.message, s.stopRequested));
    return { draftHandled: true, draftRevision };
    } finally { this.sending.delete(id); }
  }
  async connections(id) {
    const s = this.store.get(id);
    if (s.engine === 'terminal') throw new Error('Connections are available in Claude and Codex tasks.');
    if (this.updates[s.engine]?.running) throw new Error('Wait for the agent update to finish.');
    if (this.connectionLoads.has(id)) return this.connectionLoads.get(id);
    const load = (async () => {
      try { return { ...(await this[s.engine].connections(s)), updatedAt: Date.now() }; }
      catch { throw new Error('Could not read this task’s connections. Check the provider connection and refresh.'); }
      finally { this.connectionLoads.delete(id); }
    })();
    this.connectionLoads.set(id, load); return load;
  }
  async deliverFollowups(id) {
    if (this.followupLoads.has(id) || this.shuttingDown) return;
    const s = this.store.get(id), entry = s.pendingMessages?.[0];
    if (!entry || entry.paused || s.closed || s.archived || s.closeRequested || s.stopRequested || s.status === 'waiting') return;
    if (!busy(s)) {
      if (s.status !== 'idle') return;
      try { await this.send(id, entry.text, [], 'auto', entry); }
      catch { entry.paused = true; const message = s.messages.find(m => m.id === entry.id); if (message) message.delivery = 'paused'; this.store.changed(id); }
      return;
    }
    if (entry.mode === 'queue' || entry.command || !this[s.engine].steer) return;
    const load = (async () => {
      // Yield once so the map is installed even if an adapter returns synchronously.
      await Promise.resolve();
      try {
        if (entry.paused || s.stopRequested || s.closeRequested || s.closed || s.archived || this.shuttingDown) return;
        const notice = sharedNotice(this.store.state.sessions, s, this.changes.get(s.cwd) || []);
        const comments = entry.attachments.filter(a => a.comment).map(a => `Comment on attachment ${JSON.stringify(a.name)}: ${a.comment}`).join('\n\n');
        const prompt = [notice, entry.text.replace(/^(\s*)\/\//, '$1/'), comments].filter(Boolean).join('\n\n');
        if (await this[s.engine].steer(s, prompt, entry.attachments, entry.id)) {
          s.pendingMessages = s.pendingMessages.filter(q => q !== entry);
          s.inFlightAttachments = [...(s.inFlightAttachments || []), ...entry.attachments];
          const message = s.messages.find(m => m.id === entry.id); if (message) message.delivery = 'sent-during-run';
        }
      } catch {
        entry.paused = true;
        const message = s.messages.find(m => m.id === entry.id); if (message) message.delivery = 'unconfirmed';
      } finally {
        this.followupLoads.delete(id); this.store.changed(id);
        const finish = this.deferredFinishes.get(id);
        if (finish) { this.deferredFinishes.delete(id); this.finish(id, finish.error, finish.interrupted); }
      }
      if (s.pendingMessages?.[0] && s.pendingMessages[0] !== entry) void this.deliverFollowups(id);
    })();
    this.followupLoads.set(id, load); return load;
  }
  async queuedMessage(id, messageId, action) {
    const s = this.store.get(id);
    if (this.followupLoads.has(id)) throw new Error('This message is being delivered. Try again shortly.');
    const entry = s.pendingMessages?.find(q => q.id === messageId);
    if (!entry) throw new Error('This message is no longer queued.');
    const message = s.messages.find(m => m.id === messageId);
    if (action === 'withdraw') {
      s.pendingMessages = s.pendingMessages.filter(q => q !== entry);
      s.attachments.push(...entry.attachments);
      s.draft = [s.draft, entry.text].filter(Boolean).join('\n\n'); s.draftRestoredRevision = (s.draftRestoredRevision || 0) + 1;
      if (message) message.delivery = 'withdrawn';
    } else if (action === 'resume') {
      if (s.closed || s.archived || s.closeRequested || s.stopRequested) throw new Error('Reopen the task before sending queued messages.');
      entry.paused = false; if (message) message.delivery = 'queued';
      if (!busy(s)) s.status = 'idle';
    } else throw new Error('Choose resume or withdraw.');
    this.store.changed(id); await this.deliverFollowups(id); return { draft: s.draft };
  }
  async listCommands(id, reload = false, localOnly = false) {
    const s = this.store.get(id);
    if (s.engine === 'terminal') return { commands: [] };
    if (localOnly) return { commands };
    if (this.updates[s.engine]?.running) return { commands, error: 'Wait for the agent update to finish.' };
    const key = `${id}:${s.profile}`;
    const cached = this.commandCache.get(key);
    if (!reload && cached && Date.now() - cached.at < 60000) return cached.value;
    if (s.closed || s.archived) return { commands };
    if (this.commandLoads.has(key)) return this.commandLoads.get(key);
    const load = (async () => {
      try {
        const provider = await this[s.engine].commands(s);
        const value = { commands: mergeCommands(provider) };
        if (this.store.state.sessions.includes(s)) this.commandCache.set(key, { at: Date.now(), value });
        return value;
      } catch (err) { return { commands, error: `Could not load ${s.engine} skills: ${err.message}` }; }
      finally { this.commandLoads.delete(key); }
    })();
    this.commandLoads.set(key, load); return load;
  }
  async runCommand(s, { name, args }) {
    const id = s.id;
    if (!['model', 'effort', 'rename'].includes(name) && args) throw new Error(`/${name} does not take arguments.`);
    if (name === 'help' || name === 'skills') return { effect: 'commands', skillsOnly: name === 'skills' };
    if (name === 'mcp' || name === 'connections') return { effect: 'connections' };
    if (name === 'status') return { effect: 'details' };
    if (name === 'delete') return { effect: 'delete' };
    if (name === 'stop') { await this.stop(id); return { message: 'Stop requested' }; }
    if (name === 'exit') { await this.closeSession(id); return { message: s.closed ? 'Task closed; conversation saved' : 'Closing task; conversation saved' }; }
    if (name === 'archive') { this.archive(id); return { message: 'Task archived' }; }
    if (name === 'pin' || name === 'unpin') { this.store.patch(id, { pinned: name === 'pin' }); return { message: name === 'pin' ? 'Task pinned' : 'Task unpinned' }; }
    if (name === 'rename') { if (!args) throw new Error('Use /rename <task name>.'); this.store.patch(id, { name: args }); return { message: 'Task renamed' }; }
    if (busy(s) || this.sending.has(id)) throw new Error('Finish or stop this turn first.');
    if (name === 'clear') {
      if (s.archived || s.closed) throw new Error('Reopen this task before starting fresh.');
      const next = this.create({ name: s.name, engine: s.engine, cwd: s.cwd, profile: 'normal', model: s.model, color: s.color, font: s.font, fontSize: s.fontSize, effort: s.effort, pinned: s.pinned || false });
      this.archive(id); return { message: 'Fresh conversation opened; previous task archived', id: next };
    }
    if (name === 'model') {
      if (!args) return { effect: 'model' };
      const match = this.modelLists[s.engine].find(m => m.value.toLowerCase() === args.toLowerCase() || m.label.toLowerCase() === args.toLowerCase());
      if (args !== 'default' && (!match || /[\r\n]/.test(args))) throw new Error('Choose an available model, or refresh the model list in Settings.');
      this.store.patch(id, { model: args === 'default' ? '' : match.value, effort: '' });
      return { message: `Model: ${s.model || 'provider default'} · applies to your next message` };
    }
    if (name === 'effort') {
      if (!args) return { effect: 'details' };
      const model = this.modelLists[s.engine].find(m => m.value === (s.model || s.nativeModel));
      if (args !== 'default' && !model?.efforts.includes(args)) throw new Error(`Choose a model, then use /effort ${model?.efforts.join(', ') || '<supported level>'}, or /effort default.`);
      this.store.patch(id, { effort: args === 'default' ? '' : args }); return { message: `Reasoning effort: ${args}` };
    }
  }
  finish(id, error, interrupted = false) {
    const s = this.store.state.sessions.find(s => s.id === id); if (!s || s.closed) return;
    if (this.followupLoads.has(id)) { this.deferredFinishes.set(id, { error, interrupted }); return; }
    const wasBusy = busy(s); interrupted ||= s.stopRequested; s.status = error ? 'error' : interrupted ? 'interrupted' : 'idle'; s.error = error || null; delete s.stopRequested;
    if (error || interrupted) for (const entry of s.pendingMessages || []) { entry.paused = true; const message = s.messages.find(m => m.id === entry.id); if (message && message.delivery !== 'unconfirmed') message.delivery = 'paused'; }
    stopClock(s); s.lastFinishedAt = Date.now();
    if (wasBusy) recordEvent(s, error ? 'Failed' : interrupted ? 'Stopped' : 'Finished');
    if (error && !interrupted && !s.draft && s.inFlightDraft) { s.draft = s.inFlightDraft; s.draftRestoredRevision = (s.draftRestoredRevision || 0) + 1; }
    delete s.inFlightDraft;
    for (const a of s.inFlightAttachments || []) {
      if (error && !a.expired) s.attachments.push(a);
      else {
        try { this.attachments.remove(a); } catch (error) { this.emit('log', `Attachment cleanup skipped: ${error.message}`); }
        for (const m of s.messages) for (const ma of m.attachments || []) if (ma.id === a.id) ma.expired = true;
      }
    }
    s.inFlightAttachments = []; delete s.turnId; delete s.turnSettings;
    this.clearApprovals(id);
    if (s.closeRequested) this.markClosed(s);
    if (error) this.store.add(id, 'system', error);
    if (!error && !interrupted && s.pendingMessages?.some(q => !q.paused) && !this.shuttingDown) queueMicrotask(() => { void this.deliverFollowups(id); });
    this.store.changed(); if (wasBusy && !s.pendingMessages?.some(q => !q.paused)) this.emit('attention', { id, title: s.name, body: error ? 'Needs attention: ' + error.slice(0, 120) : interrupted ? 'Task stopped.' : 'Ready for you.' });
  }
  // Folder trust for Claude project settings, hooks and project MCP servers, keyed by real path.
  trusted(cwd) { try { return (this.store.state.settings.trustedFolders || []).includes(canonicalFolder(cwd)); } catch { return false; } }
  trustFolder(id, trusted) {
    const folder = canonicalFolder(this.store.get(id).cwd), list = (this.store.state.settings.trustedFolders || []).filter(f => f !== folder);
    this.store.state.settings = { ...this.store.state.settings, trustedFolders: trusted === true ? [...list, folder].slice(-500) : list };
    this.store.changed();
  }
  ask(id, request, signal) {
    const s = this.store.get(id);
    return new Promise(resolve => {
      if (signal?.aborted || s.stopRequested) return resolve({ allow: false });
      const finish = answer => { signal?.removeEventListener('abort', abort); resolve(answer); };
      // The complete input stays in the main process; the card gets the inline view.
      const { full, ...shown } = request;
      const entry = { request: { ...shown, id: randomUUID() }, full, resolve: finish };
      const abort = () => {
        const queue = this.approvals.get(id) || [], index = queue.indexOf(entry);
        if (index >= 0) { queue.splice(index, 1); this.showApproval(id); }
        finish({ allow: false });
      };
      const queue = this.approvals.get(id) || [];
      queue.push(entry); this.approvals.set(id, queue);
      signal?.addEventListener('abort', abort, { once: true });
      if (queue.length === 1) this.showApproval(id);
    });
  }
  showApproval(id) {
    const s = this.store.get(id), queue = this.approvals.get(id);
    if (queue?.length) {
      stopClock(s);
      s.approval = queue[0].request; s.status = 'waiting';
      this.emit('attention', { id, title: s.name, body: s.approval.title });
    } else { this.approvals.delete(id); delete s.approval; if (s.status === 'waiting') { s.status = 'working'; startClock(s); } }
    this.store.changed();
  }
  clearApprovals(id) {
    const queue = this.approvals.get(id) || []; this.approvals.delete(id); delete this.store.get(id).approval;
    for (const pending of queue) pending.resolve({ allow: false });
  }
  // Returns the untruncated input for the waiting request and records that it was opened.
  reviewFull(id, requestId) {
    const s = this.store.get(id), p = this.approvals.get(id)?.[0];
    if (!p || requestId !== s.approval?.id) throw new Error('This request is no longer waiting.');
    if (!p.request.reviewable) throw new Error('This input is too large to review in Haven. Decline it.');
    p.request.reviewed = true; this.store.changed(id);
    return { fields: p.full || [] };
  }
  answer(id, answer) {
    const s = this.store.get(id), queue = this.approvals.get(id), p = queue?.[0];
    if (!p || answer.requestId !== s.approval?.id) throw new Error('This request is no longer waiting.');
    // Deny by default: a truncated input cannot be allowed until the full input was opened.
    if (answer.allow === true && p.request.hiddenChars > 0 && !p.request.reviewed) throw new Error('Open the full input before allowing this action.');
    queue.shift(); p.resolve(answer); this.showApproval(id); void this.deliverFollowups(id);
  }
  async stop(id) {
    const s = this.store.get(id);
    if (s.engine === 'terminal') { this.terminals.get(id)?.stdin.end(JSON.stringify({ type: 'stop' }) + '\n'); return; }
    for (const entry of s.pendingMessages || []) { entry.paused = true; const message = s.messages.find(m => m.id === entry.id); if (message) message.delivery = 'paused'; }
    if (!busy(s)) { this.store.changed(id); return; }
    s.stopRequested = true; this.clearApprovals(id); this.store.changed();
    await this[s.engine].stop(s);
  }
  markClosed(s) {
    stopClock(s); s.closed = true; s.closedAt = Date.now(); s.status = 'closed'; delete s.closeRequested;
    recordEvent(s, 'Closed'); this[s.engine]?.closeSession?.(s.id); this.syncWatchers(); this.store.changed();
  }
  async closeSession(id) {
    const s = this.store.get(id); if (s.closed) return;
    if (this.sending.has(id)) throw new Error('Wait for the message to finish preparing.');
    if (busy(s) || this.terminals.has(id)) {
      s.closeRequested = true; this.store.changed();
      try { await this.stop(id); } catch (err) { delete s.closeRequested; this.store.changed(); throw err; }
    } else this.markClosed(s);
  }
  archive(id) {
    const s = this.store.get(id);
    if (busy(s) || this.terminals.has(id) || this.sending.has(id)) throw new Error('Stop this task before archiving it.');
    if (!s.closed) this.markClosed(s);
    s.archived = true; s.archivedAt = Date.now(); recordEvent(s, 'Archived');
    this.syncWatchers(); this.store.changed();
  }
  restore(id) {
    const s = this.store.get(id); if (!s.closed && !s.archived) return;
    s.archived = false; s.closed = false; s.status = s.engine === 'terminal' ? 'stopped' : 'idle'; s.error = null;
    s.lastOpenedAt = Date.now(); recordEvent(s, 'Reopened'); this.store.state.activeId = id;
    this.syncWatchers(); this.store.changed();
  }
  remove(id) {
    const s = this.store.get(id);
    if (busy(s) || this.terminals.has(id) || this.sending.has(id)) throw new Error('Stop this task before deleting it.');
    this[s.engine]?.closeSession?.(id); this.clearApprovals(id);
    const previous = { sessions: this.store.state.sessions, activeId: this.store.state.activeId };
    this.store.state.sessions = this.store.state.sessions.filter(s => s.id !== id);
    if (this.store.state.activeId === id) this.store.state.activeId = this.store.state.sessions.find(s => !s.archived)?.id || null;
    if (!this.store.save()) {
      Object.assign(this.store.state, previous); this.publish();
      throw new Error(this.store.storage.saveError || 'The deletion could not be saved. Your task and attachments have been retained.');
    }
    // Rotate the backup past the deletion before removing files it may reference.
    if (this.store.save()) {
      for (const a of [...s.attachments, ...(s.inFlightAttachments || []), ...(s.pendingMessages || []).flatMap(q => q.attachments)]) { try { this.attachments.remove(a); } catch (error) { this.emit('log', `Attachment cleanup skipped: ${error.message}`); } }
      try { this.store.transcripts.remove(id); } catch (error) { this.emit('log', `Transcript cleanup: ${error.message}`); }
    }
    for (const key of this.commandCache.keys()) if (key.startsWith(id + ':')) this.commandCache.delete(key);
    this.syncWatchers(); this.store.changed();
  }
  startTerminal(id) {
    const s = this.store.get(id); if (s.engine !== 'terminal') throw new Error('Not a terminal task.'); if (this.terminals.has(id)) return;
    if (s.closed || s.archived) throw new Error('Reopen this task before starting the terminal.');
    const proc = spawn(resolvePython(this.store.state.settings.python), [path.join(this.helpers, 'terminal.py')], { cwd: s.cwd, env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.terminals.set(id, proc); s.status = 'running'; s.terminalBuffer ||= ''; s.error = null;
    startClock(s); recordEvent(s, 'Running');
    createInterface({ input: proc.stdout }).on('line', line => { try { const e = JSON.parse(line); if (e.type === 'data') { s.terminalBuffer = (s.terminalBuffer + e.data).slice(-400000); s.terminalSequence = (s.terminalSequence || 0) + 1; this.emit('terminal', { id, data: e.data, sequence: s.terminalSequence }); } } catch {} });
    proc.stderr.on('data', data => { s.error = data.toString().slice(-1500); this.store.changed(); });
    proc.on('error', err => { s.error = err.message; s.status = 'error'; stopClock(s); recordEvent(s, 'Failed'); this.terminals.delete(id); if (s.closeRequested) this.markClosed(s); this.store.changed(); });
    proc.on('exit', () => { if (this.terminals.get(id) === proc) { this.terminals.delete(id); stopClock(s); s.lastFinishedAt = Date.now(); recordEvent(s, 'Stopped'); s.status = 'stopped'; if (s.closeRequested) this.markClosed(s); this.store.changed(); } });
    this.store.changed();
  }
  terminal(id, command) { const p = this.terminals.get(id); if (!p?.stdin.writable) throw new Error('The terminal is stopped. Reopen it first.'); if (command.type === 'input' && (typeof command.data !== 'string' || command.data.length > 1000000)) throw new Error('Input too large.'); p.stdin.write(JSON.stringify(command) + '\n'); }
  async update(engine) {
    if (!['claude', 'codex'].includes(engine)) throw new Error('Unknown agent.');
    if (this.store.state.sessions.some(s => s.engine === engine && (busy(s) || this.sending.has(s.id)))) throw new Error(`Finish or stop ${engine} tasks before updating.`);
    if (this.updates[engine]?.running) return;
    const binary = executable(engine);
    const progress = this.updates[engine] = { running: true, output: 'Starting update…\n', success: false }; this.publish();
    const add = d => { progress.output = (progress.output + d).slice(-10000); this.publish(); };
    let proc;
    try {
      // Block new turns before awaiting cleanup; no old discovery may win a race
      // against the post-update catalog, and old transports must finish closing.
      await this.agentRefreshLoads.get(engine); await this[engine].close();
      if (this.shuttingDown) { progress.running = false; return; }
      proc = spawn(binary, ['update'], { env: agentEnv() });
    } catch (err) { progress.running = false; add(err.message); throw err; }
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', err => add(err.message + '\n'));
    // `close` also handles failed spawns and waits for the final updater output.
    proc.once('close', async code => {
      try {
        if (!this.shuttingDown) {
          add('\nRefreshing connections and models…\n');
          await this.refreshAgent(engine, { afterUpdate: true });
          add(this.diagnostics[engine]?.connected ? 'Model list refreshed.\n' : 'Model refresh needs attention. Retry in Settings.\n');
        }
      } finally {
        progress.running = false; progress.success = code === 0; this.publish();
        if (!this.shuttingDown) void this.refreshUsage(engine);
      }
    });
  }
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.shuttingDown = true; clearInterval(this.usageTimer);
      for (const timer of this.usageEventTimers.values()) clearTimeout(timer); this.usageEventTimers.clear();
      clearInterval(this.heartbeat);
      for (const s of this.store.state.sessions) stopClock(s);
      this.store.save();
      for (const id of this.approvals.keys()) this.clearApprovals(id);
      const operations = [() => this.claude.close(), () => this.codex.close(), () => stopProcess(this.voiceProcess),
        ...[...this.terminals.values()].map(p => () => stopProcess(p, JSON.stringify({ type: 'stop' }) + '\n')),
        ...[...this.watchers.values()].map(w => () => w.close())];
      const results = await Promise.allSettled(operations.map(operation => bounded(operation)));
      for (const result of results) if (result.status === 'rejected') this.emit('log', `Shutdown cleanup: ${result.reason.message}`);
      this.store.save(); clearTimeout(this.store.timer); clearTimeout(this.publishTimer);
    })();
    return this.shutdownPromise;
  }
}
