import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-conversation-ui-'));
const store = new Store(root);
const task = store.create({ name: 'Read and capture', engine: 'claude', cwd: root });
const table = '| Item | Count | Aligned |\n| --- | --- | :---: |\n| Apples | 1,250 | 12 |\n| Pears | 24 | 99 |';
store.add(task.id, 'assistant', table);
for (let i = 0; i < 20; i++) store.add(task.id, 'assistant', `Paragraph ${i + 1}. ` + 'A longer conversation makes the scroll position and draft boundary visible. '.repeat(7));
store.save(); fs.mkdirSync('artifacts', { recursive: true });
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
const page = await app.firstWindow(); const failures = [], passed = [];
await app.evaluate(async ({ clipboard, ClipboardItem }) => {
  globalThis.__havenClipboard = [];
  for (const item of await clipboard.read()) {
    const values = {}; for (const type of item.types) values[type] = await item.getType(type);
    if (Object.keys(values).length) globalThis.__havenClipboard.push(new ClipboardItem(values));
  }
});
const check = async (name, fn) => { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); } };
try {
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await check('latest pill never overlaps a multiline draft', async () => {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A multiline draft\n'.repeat(12));
    await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    const pill = page.getByRole('button', { name: 'Back to latest' }); await pill.waitFor();
    const a = await pill.boundingBox(), b = await page.locator('.composer').boundingBox();
    assert.ok(a.y + a.height <= b.y, `Pill bottom ${a.y + a.height} overlaps composer top ${b.y}`);
  });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
  await check('tables align and copy in both themes and text sizes', async () => {
    assert.equal(await page.locator('.table-wrap').count(), 1, 'Expected a scrollable table wrapper');
    await page.locator('.table-wrap').scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark']) for (const size of [16, 24]) {
      await page.evaluate(async ({ id, theme, size }) => { await window.haven.invoke('settings', { theme }); await window.haven.invoke('patch', { id, patch: { fontSize: size } }); }, { id: task.id, theme, size });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await page.waitForFunction(size => getComputedStyle(document.querySelector('.markdown')).fontSize === `${size}px`, size);
      const styles = await page.locator('.table-wrap table').evaluate(el => ({ display: getComputedStyle(el).display, number: getComputedStyle(el.tBodies[0].rows[0].cells[1]).textAlign, explicit: getComputedStyle(el.tBodies[0].rows[0].cells[2]).textAlign }));
      assert.equal(styles.display, 'table'); assert.equal(styles.number, 'right'); assert.equal(styles.explicit, 'center');
      await page.screenshot({ path: `artifacts/table-${theme}-${size}.png`, animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'Table copy options' }).click(); await page.getByRole('menuitem', { name: 'Copy table as Markdown' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('Table copied'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), table);
    await page.getByRole('button', { name: 'Table copy options' }).click(); await page.getByRole('menuitem', { name: 'Copy table as TSV' }).click();
    await page.waitForTimeout(100);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'Item\tCount\tAligned\nApples\t1,250\t12\nPears\t24\t99');
    await page.getByRole('button', { name: 'Table copy options' }).click(); await page.getByRole('menuitem', { name: 'Copy table with formatting' }).click();
    await page.waitForTimeout(100);
    const html = await app.evaluate(async ({ clipboard }) => { for (const item of await clipboard.read()) if (item.types.includes('text/html')) return (await item.getType('text/html')).text(); return ''; });
    assert.match(html, /<table/); assert.match(html, /1,250/);
  });
  await check('Haven window capture opens annotation and remembers its mode', async () => {
    assert.equal(await page.getByRole('button', { name: 'Capture options', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Capture options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Capture Haven window', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
    assert.equal(await page.evaluate(async id => (await window.haven.invoke('state')).sessions.find(s => s.id === id).captureMode, task.id), 'haven-window');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  });
} finally {
  await app.evaluate(async ({ clipboard }) => { if (globalThis.__havenClipboard.length) await clipboard.write(globalThis.__havenClipboard); else clipboard.clear(); }).catch(() => {});
  await app.close();
}
console.log(JSON.stringify({ ok: failures.length === 0, passed, failures, data: root }, null, 2));
if (failures.length) process.exitCode = 1;
