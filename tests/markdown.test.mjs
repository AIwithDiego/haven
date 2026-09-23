import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_MARKDOWN_BYTES, MAX_MARKDOWN_IMAGE_BYTES, readMarkdown, markdownLinkBase, readMarkdownImage } from '../electron/markdown.mjs';
import { resolveLink } from '../electron/links.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haven-markdown-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = path.join(root, 'docs'); await fs.mkdir(docs);
  const file = path.join(docs, 'A reading note.MD');
  await fs.writeFile(file, '# Café\n\nHello **Haven**.\n');
  return { root, docs, file };
}

test('Markdown snapshots keep source, UTF-8, filename, metadata and document-relative base', async t => {
  const { docs, file } = await fixture(t);
  const doc = await readMarkdown(file, 'café');
  assert.equal(doc.kind, 'markdown'); assert.equal(doc.name, 'A reading note.MD');
  assert.equal(doc.content, '# Café\n\nHello **Haven**.\n'); assert.equal(doc.fragment, 'café');
  assert.equal(doc.size, Buffer.byteLength(doc.content)); assert.ok(doc.modifiedAt > 0);
  assert.equal(await markdownLinkBase(file), await fs.realpath(docs));
  await fs.writeFile(file, '# Updated'); assert.equal((await readMarkdown(file)).content, '# Updated');
});

test('Markdown reads refuse large, binary, invalid UTF-8, non-document and directory targets', async t => {
  const { docs, file } = await fixture(t);
  await fs.writeFile(file, Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 65)); await assert.rejects(readMarkdown(file), /too large/);
  await fs.writeFile(file, Buffer.from([0xc3, 0x28])); await assert.rejects(readMarkdown(file), /UTF-8/);
  await fs.writeFile(file, 'hello\0world'); await assert.rejects(readMarkdown(file), /binary/);
  await assert.rejects(readMarkdown('./relative.md'), /local Markdown/);
  await assert.rejects(readMarkdown(path.join(docs, 'missing.md')), /missing/);
  const other = path.join(docs, 'secret.txt'); await fs.writeFile(other, 'plain text');
  await assert.rejects(readMarkdown(other), /\.md/);
  const alias = path.join(docs, 'pretends.md'); await fs.symlink(other, alias);
  await assert.rejects(readMarkdown(alias), /\.md/);
  const directory = path.join(docs, 'directory.md'); await fs.mkdir(directory);
  await assert.rejects(readMarkdown(directory), /regular file/);
  await assert.rejects(markdownLinkBase(directory), /no longer available/);
});

test('Markdown fragments resolve from task and document folders without breaking literal filenames', async t => {
  const { docs, file } = await fixture(t);
  for (const href of [`${file}#hello-world`, './A%20reading%20note.MD#hello-world', `${pathToFileURL(file).href}#hello-world`]) {
    const link = await resolveLink(href, docs); assert.equal(link.path, await fs.realpath(file)); assert.equal(link.fragment, 'hello-world');
  }
  assert.equal((await resolveLink(`${file}#L12`, docs)).fragment, 'L12');
  const literal = `${file}#literal`; await fs.writeFile(literal, 'literal filename');
  assert.equal((await resolveLink(literal, docs)).path, await fs.realpath(literal));
  assert.equal((await resolveLink(literal, docs)).fragment, undefined);
  const linked = path.join(docs, 'child.markdown'); await fs.writeFile(linked, '# Child');
  assert.equal((await resolveLink('./child.markdown#child', await markdownLinkBase(file))).path, await fs.realpath(linked));
});

test('Embedded images are local bounded rasters within the document folder, including symlink checks', async t => {
  const { root, docs, file } = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=', 'base64');
  const local = path.join(docs, 'photo one.png'); await fs.writeFile(local, png);
  for (const source of ['./photo%20one.png', local, pathToFileURL(local).href]) assert.equal(await readMarkdownImage(file, source), `data:image/png;base64,${png.toString('base64')}`);
  const outside = path.join(root, 'outside.png'); await fs.writeFile(outside, png);
  const alias = path.join(docs, 'alias.png'); await fs.symlink(outside, alias);
  for (const source of ['../outside.png', './alias.png', 'https://example.com/tracker.png', '//example.com/tracker.png', 'data:image/png;base64,AA', 'javascript:alert(1)', 'file://server/a.png', './missing.png']) assert.equal(await readMarkdownImage(file, source), null);
  const svg = path.join(docs, 'unsafe.svg'); await fs.writeFile(svg, '<svg onload="alert(1)"/>'); assert.equal(await readMarkdownImage(file, svg), null);
  await fs.writeFile(local, '<html>not an image</html>'); assert.equal(await readMarkdownImage(file, local), null);
  const giant = Buffer.from(png); giant.writeUInt32BE(100000, 16); giant.writeUInt32BE(100000, 20);
  await fs.writeFile(local, giant); assert.equal(await readMarkdownImage(file, local), null);
  await fs.writeFile(local, Buffer.alloc(MAX_MARKDOWN_IMAGE_BYTES + 1)); await assert.rejects(readMarkdownImage(file, local), /too large/);
});
