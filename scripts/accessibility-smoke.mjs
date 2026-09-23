import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-accessibility-ui-'));
const store = new Store(root), task = store.create({ name: 'Needs attention', engine: 'claude', cwd: root });
task.backgroundWork = [{ id: 'child', description: 'Review accessibility', status: 'running', summary: 'Checking focus rings' }];
task.status = 'error'; task.error = 'A test error'; store.add(task.id, 'assistant', 'Readable prose. '.repeat(80)); store.save();
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
const page = await app.firstWindow(), failures = [], passed = [];
const check = async (name, fn) => { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); } };
const luminance = rgb => rgb.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
try {
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await page.evaluate(() => window.haven.invoke('settings', { theme: 'light' }));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await check('background agents remain visible separately from conversation text', async () => {
    await page.locator('.background-work summary').click();
    await page.locator('.background-work').getByText('Review accessibility', { exact: true }).waitFor();
    assert.equal(await page.locator('.conversation-content').getByText('Review accessibility', { exact: true }).count(), 0);
  });
  await check('legible muted text and sidebar failure status', async () => {
    assert.equal(await page.locator('.session-caption').evaluate(el => getComputedStyle(el).color), 'rgb(91, 102, 96)');
    assert.ok(Number.parseFloat(await page.locator('.session-caption').evaluate(el => getComputedStyle(el).fontSize)) >= 11);
    assert.match(await page.locator('.session-caption').innerText(), /Needs attention/);
    assert.equal(await page.locator('.status-slot .status-dot.error').count(), 1);
  });
  await check('search fields have a solid high-contrast focus ring', async () => {
    await page.keyboard.press('Meta+k');
    assert.notEqual(await page.getByRole('textbox', { name: 'Search tasks and conversations' }).evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('Meta+f');
    const ring = await page.getByRole('textbox', { name: 'Find a message' }).evaluate(el => getComputedStyle(el).outlineColor.match(/[\d.]+/g).map(Number));
    assert.ok(contrast(ring, [248, 247, 243]) >= 3);
    await page.getByRole('button', { name: 'Close search', exact: true }).click();
  });
  await check('error toast is an alert above the composer', async () => {
    const field = page.getByRole('textbox', { name: 'Task name', exact: true });
    await field.fill('x'.repeat(301)); await field.blur();
    const toast = page.locator('.toast[role="alert"]'); await toast.waitFor({ timeout: 2000 });
    assert.equal(await toast.locator('svg.lucide-x').count(), 2);
    const a = await toast.boundingBox(), b = await page.locator('.composer').boundingBox(); assert.ok(a.y + a.height < b.y);
  });
  await check('task menu keeps deletion last and separate', async () => {
    await page.getByRole('button', { name: 'Task options', exact: true }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Close task', 'Archive task', 'Show folder in Finder', 'Copy conversation as text', 'Delete task…']);
    assert.equal(await page.getByRole('separator').count(), 1);
    assert.match(await page.getByRole('menuitem', { name: 'Delete task…' }).getAttribute('class'), /danger/);
  });
  await page.keyboard.press('Escape');
  await check('prose and composer share a readable width', async () => {
    const widths = await page.evaluate(() => ({ composer: document.querySelector('.composer').getBoundingClientRect().width, message: document.querySelector('.message').getBoundingClientRect().width, max: getComputedStyle(document.querySelector('.markdown p')).maxWidth }));
    assert.ok(Math.abs(widths.composer - widths.message) <= 2); assert.notEqual(widths.max, 'none');
  });
  await check('composer focus uses one outer ring without interior lines', async () => {
    const field = page.getByRole('textbox', { name: 'Message', exact: true }); await field.focus();
    assert.equal(await field.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    assert.notEqual(await page.locator('.composer').evaluate(el => getComputedStyle(el).boxShadow), 'none');
  });
  await check('light custom colour retains send-button contrast', async () => {
    await page.evaluate(id => window.haven.invoke('patch', { id, patch: { color: '#ffffff' } }), task.id);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft');
    const colors = await page.locator('.send-button').evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor].map(v => v.match(/[\d.]+/g).map(Number)));
    assert.ok(contrast(...colors) >= 4.5);
  });
  await check('settings use conventional theme names, system headings and usable targets', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.deepEqual((await page.locator('.theme-option').allTextContents()).map(t => t.trim()), ['Light', 'Dark', 'System']);
    const style = await page.locator('.modal-heading h2').evaluate(el => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
    assert.deepEqual(style, { size: '17px', weight: '600' });
    const toggle = await page.getByRole('switch', { name: 'Task notifications' }).boundingBox(); assert.ok(toggle.height >= 24);
  });
  if (await page.getByRole('button', { name: 'Close dialog' }).count()) await page.getByRole('button', { name: 'Close dialog' }).click();
  await check('multiline slash suggestions expose valid textbox autocomplete semantics', async () => {
    const field = page.getByRole('textbox', { name: 'Message', exact: true }); await field.fill('/');
    await page.getByRole('listbox', { name: 'Slash commands' }).waitFor();
    assert.equal(await field.getAttribute('aria-autocomplete'), 'list'); assert.equal(await field.getAttribute('aria-expanded'), null);
    assert.equal(await field.getAttribute('aria-controls'), 'slash-suggestions'); await field.press('Escape');
  });
  await check('annotation canvas supports keyboard marks', async () => {
    await page.getByRole('button', { name: 'Capture options', exact: true }).click(); await page.getByRole('menuitem', { name: 'Capture Haven window', exact: true }).click();
    const canvas = page.locator('canvas[aria-label="Draw annotations on the screenshot"]'); await canvas.waitFor();
    assert.equal(await canvas.getAttribute('tabindex'), '0'); await canvas.focus(); await canvas.press('Enter'); await canvas.press('ArrowRight'); await canvas.press('ArrowDown'); await canvas.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  });
  if (await page.getByRole('button', { name: 'Close dialog' }).count()) await page.getByRole('button', { name: 'Close dialog' }).click();
  await check('permission badge can select the next turn while the current one stays visible', async () => {
    await app.evaluate((_, file) => {
      const { Workspace } = process.getBuiltinModule('module').createRequire(file)(new URL(file).pathname), patch = Workspace.prototype.patch;
      Workspace.prototype.patch = function (...args) { globalThis.__testWorkspace = this; Workspace.prototype.patch = patch; return patch.apply(this, args); };
    }, pathToFileURL(path.resolve('electron/workspace.mjs')).href);
    await page.evaluate(id => window.haven.invoke('patch', { id, patch: { profile: 'normal' } }), task.id);
    await app.evaluate((_, id) => { const w = globalThis.__testWorkspace, s = w.store.get(id); s.status = 'working'; s.error = null; s.turnSettings = { profile: 'autonomous' }; w.store.changed(id); }, task.id);
    const badge = page.getByRole('button', { name: /Task permissions · Full autonomy/ }); await badge.waitFor({ timeout: 2000 }); assert.equal(await badge.isEnabled(), true);
    assert.match(await badge.innerText(), /Full autonomy.*Normal next/);
    await badge.click(); await page.getByRole('menuitem', { name: 'Full autonomy', exact: true }).click();
    assert.equal(await page.evaluate(async id => (await window.haven.invoke('state')).sessions.find(s => s.id === id).profile, task.id), 'autonomous');
  });
  await page.screenshot({ path: 'artifacts/accessibility-light.png' });
} finally {
  await app.evaluate((_, id) => { const w = globalThis.__testWorkspace; if (w) { const s = w.store.get(id); s.status = 'idle'; delete s.turnSettings; w.store.changed(id); } }, task.id);
  await app.close();
}
console.log(JSON.stringify({ ok: !failures.length, passed, failures, data: root }, null, 2));
if (failures.length) process.exitCode = 1;
