import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadWorkspace, saveWorkspace } from './persistence.mjs';
import { validateMessages } from './validation.mjs';

export class TranscriptFiles {
  constructor(root) {
    this.root = path.join(root, 'transcripts'); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.cache = new Map(); this.recovered = new Set();
  }
  file(id) { if (typeof id !== 'string' || !id) throw new Error('Invalid transcript task ID.'); return path.join(this.root, createHash('sha256').update(id).digest('hex') + '.json'); }
  hydrate(saved, notices) {
    if (!Array.isArray(saved?.sessions)) return saved;
    return { ...saved, sessions: saved.sessions.map(s => {
      if (!s?.transcript) return s;
      const loaded = loadWorkspace(this.file(s.id), data => {
        if (data?.version !== 1 || !Array.isArray(data.messages) || (data.terminalBuffer !== undefined && typeof data.terminalBuffer !== 'string')) throw new Error('Invalid transcript.');
        return { ...data, messages: validateMessages(data.messages) };
      });
      if (!loaded.saved || loaded.storage.readOnly) throw new Error(`The transcript for ${s.name} could not be recovered.`);
      if (loaded.recovered) { this.recovered.add(s.id); notices.push(`The transcript for “${s.name}” was recovered from its backup. Its damaged file is preserved.`); }
      this.cache.set(s.id, JSON.stringify(loaded.saved));
      return { ...s, messages: loaded.saved.messages, terminalBuffer: loaded.saved.terminalBuffer };
    }) };
  }
  save(sessions) {
    return sessions.map(session => {
      const { messages, terminalBuffer, ...metadata } = session;
      const data = { version: 1, messages, ...(terminalBuffer ? { terminalBuffer } : {}) }, encoded = JSON.stringify(data);
      if (this.cache.get(session.id) !== encoded || this.recovered.has(session.id)) {
        saveWorkspace(this.file(session.id), data, this.recovered.has(session.id));
        this.cache.set(session.id, encoded); this.recovered.delete(session.id);
      }
      return { ...metadata, transcript: true };
    });
  }
  remove(id) { for (const suffix of ['', '.bak']) fs.rmSync(this.file(id) + suffix, { force: true }); this.cache.delete(id); }
}
