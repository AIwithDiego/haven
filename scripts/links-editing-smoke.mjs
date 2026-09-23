import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Store } from '../electron/core.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-links-editing-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const preview = path.join(project, 'A preview.png'); fs.writeFileSync(preview, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSAAAAABJRU5ErkJggg==', 'base64'));
const store = new Store(root), task = store.create({ name: 'Links and spelling', cwd: project, engine: 'codex' });
store.add(task.id, 'assistant', `[Absolute preview](<${preview}>)\n\n[Relative preview](./A%20preview.png)\n\n[File URL](${pathToFileURL(preview).href})\n\n[Source line](<${preview}:12>)\n\n[Missing file](./missing.png)\n\n[Website](https://example.com/)`);
store.save();
const app = await electron.launch({ ...(process.env.HAVEN_APP_PATH ? { executablePath: process.env.HAVEN_APP_PATH, args: [] } : { args: ['.'] }), cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
const page = await app.firstWindow(), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  // Exercise real IPC and routing, intercept only external OS app launch side effects.
  await app.evaluate(({ shell, Menu, BrowserWindow }) => {
    globalThis.__linkCalls = [];
    shell.openPath = async file => { globalThis.__linkCalls.push(['open', file]); return ''; };
    shell.openExternal = async url => { globalThis.__linkCalls.push(['external', url]); };
    shell.showItemInFolder = file => { globalThis.__linkCalls.push(['reveal', file]); };
    Menu.prototype.popup = function () { globalThis.__editingMenu = this; };
    globalThis.__contextSequence = 0;
    BrowserWindow.getAllWindows()[0].webContents.prependListener('context-menu', (_event, params) => { globalThis.__contextSequence++; globalThis.__contextParams = { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions }; });
  });
  for (const label of ['Absolute preview', 'Relative preview', 'File URL', 'Source line']) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.getByRole('dialog').locator('.document-image').waitFor();
    await page.getByRole('button', { name: 'Close file reader', exact: true }).click();
  }
  const calls = await app.evaluate(() => globalThis.__linkCalls);
  assert.equal(calls.length, 0, 'Supported image previews stay inside Haven');
  await page.getByRole('link', { name: 'Website', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.__linkCalls.at(-1)), ['external', 'https://example.com/']);
  await page.getByRole('link', { name: 'Missing file', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'missing or cannot be accessed' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  // Native spelling is asynchronous; exercise keyboard input and await the event
  // from each click rather than accidentally inspecting the previous menu.
  await input.click();
  await input.pressSequentially('mispeling ', { delay: 40 });
  const wordPoint = await input.evaluate(el => { const style = getComputedStyle(el); return { x: parseFloat(style.paddingLeft) + 30, y: parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 }; });
  let context;
  for (let attempt = 0; attempt < 30; attempt++) {
    const sequence = await app.evaluate(() => globalThis.__contextSequence);
    await input.click({ button: 'right', position: wordPoint });
    context = await app.evaluate(({ BrowserWindow }, previous) => {
      if (globalThis.__contextSequence > previous) return globalThis.__contextParams;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(globalThis.__contextParams); };
        const timer = setTimeout(() => { contents.off('context-menu', done); reject(new Error('Native spelling context menu did not open.')); }, 2000);
        contents.once('context-menu', done);
      });
    }, sequence);
    if (context?.misspelledWord && context.suggestions.length) break;
    await page.waitForTimeout(200);
  }
  if (!context?.misspelledWord) console.error({ context, wordPoint, value: await input.inputValue() });
  assert.equal(context?.misspelledWord, 'mispeling'); assert.ok(context.suggestions.length, 'Native macOS spellchecker must supply suggestions');
  const correction = context.suggestions[0];
  await app.evaluate((_electron, word) => {
    const menu = globalThis.__editingMenu;
    const suggestion = menu.items.find(item => item.label === word);
    if (!suggestion) throw new Error('Native menu has no spelling suggestion');
    suggestion.click();
  }, correction);
  await page.waitForFunction(word => document.querySelector('textarea[data-composer]').value.trim() === word, correction);
  await page.waitForFunction(async ({ id, word }) => (await window.haven.invoke('state')).sessions.find(s => s.id === id).draft.trim() === word, { id: task.id, word: correction });
  assert.equal((await page.evaluate(() => window.haven.invoke('state'))).sessions[0].messages.length, 1, 'Correction must never send the draft');
  assert.deepEqual(errors, []);
  fs.mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/links-editing.png' });
  console.log(JSON.stringify({ ok: true, passed: ['absolute/relative/file URLs and source-line paths through IPC', 'external web links preserved', 'friendly missing-file error', 'real macOS spelling suggestions populate native menu', 'native replacement updates and saves React draft without sending'], data: root }, null, 2));
} finally { await app.close(); }
