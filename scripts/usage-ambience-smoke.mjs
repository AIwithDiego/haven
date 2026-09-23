import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

// All writes and Electron profiles are isolated. Provider values below are fixtures,
// so this suite neither opens an agent session nor reads account credentials.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-usage-ambience-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const store = new Store(root);
const first = store.create({ name: 'A quiet place to focus', engine: 'codex', cwd: project });
const second = store.create({ name: 'A different mood', engine: 'claude', cwd: project });
store.add(first.id, 'user', 'Keep the conversation easy to read.');
store.add(first.id, 'assistant', 'The background stays behind your conversation.\n\nYour task, messages, and draft remain independent.');
store.state.activeId = first.id;
store.state.settings.theme = 'light';
store.save();
fs.mkdirSync('artifacts', { recursive: true });
const launch = () => electron.launch({ ...(process.env.HAVEN_APP_PATH ? { executablePath: process.env.HAVEN_APP_PATH, args: [] } : { args: ['.'] }), cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
const errors = [];
let app = await launch();
let page = await app.firstWindow();
const observe = () => { page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); };
observe();
const state = () => page.evaluate(() => window.haven.invoke('state'));
const activate = async id => {
  await page.evaluate(id => window.haven.invoke('activate', { id }), id);
  await page.waitForFunction(id => document.querySelector('textarea[data-composer]')?.getAttribute('data-composer') === id, id);
};
const taskSaved = async (id, background, paused) => page.waitForFunction(async ({ id, background, paused }) => {
  const task = (await window.haven.invoke('state')).sessions.find(s => s.id === id);
  return task.background === background && (paused === undefined || task.backgroundPaused === paused);
}, { id, background, paused });
const appearance = () => page.getByRole('button', { name: 'Task appearance', exact: true }).click();
const closeDialog = () => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
const layerPaused = async paused => page.waitForFunction(paused => {
  const layer = document.querySelector('.task-ambience');
  const fields = [...document.querySelectorAll('.task-ambience-scene .ambience-field')];
  return layer?.getAttribute('data-paused') === String(paused) && fields.length > 0 && fields.every(field => {
    const style = getComputedStyle(field);
    return paused ? style.animationName === 'none' || style.animationPlayState === 'paused' : style.animationName !== 'none' && style.animationPlayState === 'running';
  });
}, paused, { polling: 100, timeout: 10000 });
const chooseBackground = async (label, value) => {
  await appearance();
  await page.getByRole('radio', { name: label, exact: true }).click();
  await taskSaved(first.id, value);
  await closeDialog();
  if (value === 'off') await page.locator('.task-ambience').waitFor({ state: 'hidden' });
  else await page.locator(`.task-ambience[data-background="${value}"]`).waitFor();
};
const screenshot = name => page.screenshot({ path: `artifacts/${name}.png`, animations: 'disabled' });
let fixtureRevision = 1000000;
const renderFixture = async fixture => {
  fixture.revision = ++fixtureRevision;
  await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('haven:state', state), fixture);
};
const inViewport = async locator => {
  const box = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Control must fit inside the window');
};

try {
  await page.getByText('The background stays behind your conversation.', { exact: false }).waitFor();
  assert.equal(await page.locator('.task-ambience').count(), 0, 'Existing tasks start with motion off');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await chooseBackground('Aurora background', 'aurora');
  await layerPaused(false);
  assert.equal(await page.locator('.task-ambience').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.task-ambience').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A draft stays editable with motion.');
  await page.waitForFunction(async id => (await window.haven.invoke('state')).sessions.find(s => s.id === id).draft === 'A draft stays editable with motion.', first.id);

  await page.getByRole('button', { name: 'Pause background motion', exact: true }).click();
  await taskSaved(first.id, 'aurora', true);
  await layerPaused(true);
  await activate(second.id);
  assert.equal(await page.locator('.task-ambience').count(), 0, 'Background choice belongs to one task');
  await appearance();
  await page.getByRole('radio', { name: 'Ocean background', exact: true }).click();
  await taskSaved(second.id, 'ocean');
  await closeDialog();
  await activate(first.id);
  await layerPaused(true);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'A draft stays editable with motion.');

  // Restart the isolated app to cover persisted choices and pause state.
  await app.close();
  app = await launch(); page = await app.firstWindow(); observe();
  await page.locator('.task-ambience[data-background="aurora"]').waitFor();
  await layerPaused(true);
  const restored = await state();
  assert.equal(restored.sessions.find(s => s.id === second.id).background, 'ocean');
  assert.equal(restored.sessions.find(s => s.id === first.id).backgroundPaused, true);
  assert.equal(restored.sessions.find(s => s.id === first.id).messages.length, 2);
  assert.equal(restored.sessions.find(s => s.id === first.id).draft, 'A draft stays editable with motion.');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Resume background motion', exact: true }).click();
  await layerPaused(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await layerPaused(true);
  await appearance();
  assert.equal(await page.getByRole('switch', { name: 'Animate task background', exact: true }).isDisabled(), true);
  await closeDialog();
  assert.equal((await state()).sessions.find(s => s.id === first.id).backgroundPaused, false, 'Reduced motion must not overwrite the saved preference');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await layerPaused(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await layerPaused(true);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await layerPaused(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await layerPaused(true);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); });
  await layerPaused(false);

  for (const [label, value] of [['Ocean background', 'ocean'], ['Embers background', 'embers'], ['Stargaze background', 'stars']]) {
    await chooseBackground(label, value);
    await page.locator(`.task-ambience[data-background="${value}"]`).waitFor();
    await layerPaused(false);
  }
  await chooseBackground('No background', 'off');
  assert.equal(await page.locator('.task-ambience').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Pause background motion', exact: true }).count(), 0);
  await chooseBackground('Aurora background', 'aurora');

  // From this point the renderer receives synthetic account reports. No refresh
  // action is invoked, and no model turn is sent to either provider.
  const fixture = await state(), now = Date.now();
  const selected = fixture.sessions.find(s => s.id === first.id);
  selected.contextUsage = { usedTokens: 64000, contextWindow: 256000, usedPercent: 25, updatedAt: now, source: 'Codex thread token usage' };
  fixture.providerUsage = {
    codex: { status: 'available', updatedAt: now, source: 'Codex account limits', windows: [
      { id: 'codex:primary', label: '5-hour', usedPercent: 24, resetsAt: now + 2 * 60 * 60 * 1000 },
      { id: 'codex:secondary', label: '7-day', usedPercent: 11, resetsAt: now + 3 * 24 * 60 * 60 * 1000 },
    ] },
    claude: { status: 'available', updatedAt: now, source: 'Claude account limits', windows: [
      { id: 'five_hour', label: '5-hour', usedPercent: 63, resetsAt: now + 60 * 60 * 1000 },
      { id: 'seven_day', label: '7-day', usedPercent: 38, resetsAt: now + 2 * 24 * 60 * 60 * 1000 },
      { id: 'seven_day_opus', label: 'Opus · 7-day', usedPercent: 44, resetsAt: now + 2 * 24 * 60 * 60 * 1000 },
    ] },
  };
  await renderFixture(fixture);
  const context = page.getByRole('meter', { name: 'Task context window', exact: true });
  await context.waitFor();
  assert.equal(await context.getAttribute('aria-valuenow'), '25');
  assert.match(await page.getByRole('button', { name: 'Codex usage details', exact: true }).innerText(), /24%/);
  assert.match(await page.getByRole('button', { name: 'Claude usage details', exact: true }).innerText(), /63%/);
  await screenshot('usage-ambience-light');
  await page.getByRole('button', { name: 'Claude usage details', exact: true }).click();
  const usageDialog = page.getByRole('dialog');
  await usageDialog.waitFor();
  assert.match(await usageDialog.innerText(), /Opus.*7-day/s);
  await closeDialog();

  fixture.settings.theme = 'dark'; await renderFixture(fixture);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await screenshot('usage-ambience-dark');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 720));
  await inViewport(page.locator('.context-meter'));
  await inViewport(page.locator('.provider-usage'));
  await inViewport(page.getByRole('button', { name: 'Send message', exact: true }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot('usage-ambience-narrow');
  await appearance();
  await inViewport(page.getByRole('dialog'));
  await screenshot('usage-ambience-chooser-narrow');
  await closeDialog();

  delete selected.contextUsage;
  fixture.providerUsage.claude = { status: 'unavailable', windows: [], message: 'Plan usage is unavailable for this account.' };
  await renderFixture(fixture);
  await context.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('meter', { name: /^Claude .* usage$/ }).count(), 0, 'Unavailable usage must not render as zero');
  assert.doesNotMatch(await page.locator('.context-meter').innerText(), /\b0%/);
  await screenshot('usage-ambience-unavailable');

  // Context is current occupancy and can exceed its policy window or fall after
  // compaction; screen-reader and visual meter values stay within ARIA bounds.
  selected.contextUsage = { usedTokens: 220000, contextWindow: 200000, usedPercent: 110, updatedAt: now, source: 'Claude context summary', estimated: true };
  await renderFixture(fixture);
  await context.waitFor();
  assert.equal(await context.getAttribute('aria-valuenow'), '100');
  await page.getByRole('button', { name: 'Context window details', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /220[,.]000 of 200[,.]000/);
  await closeDialog();
  selected.contextUsage = { ...selected.contextUsage, usedTokens: 20000, usedPercent: 10 };
  await renderFixture(fixture);
  await page.waitForFunction(() => document.querySelector('[role="meter"][aria-label="Task context window"]')?.getAttribute('aria-valuenow') === '10');

  fixture.providerUsage.codex.status = 'error';
  fixture.providerUsage.codex.updatedAt = now - 20 * 60000;
  fixture.providerUsage.codex.message = 'The account could not be refreshed. Showing the last report.';
  fixture.providerUsage.codex.windows[0].resetsAt = now - 60000;
  delete fixture.providerUsage.codex.windows[1].usedPercent;
  await renderFixture(fixture);
  assert.match(await page.getByRole('button', { name: 'Codex usage details', exact: true }).getAttribute('title'), /Last reported/);
  await page.getByRole('button', { name: 'Codex usage details', exact: true }).click();
  const codexMeter = page.getByRole('dialog').getByRole('meter', { name: 'Codex 5-hour usage', exact: true });
  await page.waitForFunction(() => document.querySelector('[role="meter"][aria-label="Codex 5-hour usage"]')?.getAttribute('aria-valuetext')?.includes('last reported before reset'));
  assert.equal(await codexMeter.getAttribute('aria-valuenow'), '24', 'Reset time alone must not fabricate zero usage');
  assert.match(await page.getByRole('dialog').innerText(), /Last 24%/);
  assert.equal(await page.getByRole('meter', { name: 'Codex 7-day usage', exact: true }).count(), 0, 'Missing windows remain unknown');
  assert.match(await page.getByRole('dialog').innerText(), /Reset passed.*refresh needed/s);
  assert.match(await page.getByRole('dialog').innerText(), /could not be refreshed/);
  await screenshot('usage-ambience-expired');
  await closeDialog();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, tested: ['per-task ambience and pause persistence', 'background off and all four moods', 'editable drafts with motion', 'reduced motion without losing preference', 'hidden-window pause', 'current context and compaction decrease', 'accessible bounded meters', 'both providers and usage details', 'unavailable values remain unknown', 'expired reports and refresh error retain dated values', 'light/dark and narrow-window layout'], data: root }, null, 2));
} catch (error) {
  await screenshot('usage-ambience-failure').catch(() => {});
  console.error(await page.locator('body').innerText().catch(() => 'Window unavailable'));
  throw error;
} finally { await app.close(); }
