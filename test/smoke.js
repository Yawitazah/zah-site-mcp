/* End-to-end smoke test: mount into a throwaway Express app with a fixture
   page, then drive it through REST and through a real MCP client. Covers
   keyed edits, structure, pages, CSS, assets, forms policy, settings,
   snapshots from the editor, chrome survival, history and resets. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { mount } = require('..');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const TOKEN = 'zs_test_token_123456';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zah-site-'));
const fixture = path.join(__dirname, 'fixture.html');

const app = express();
const site = mount(app, {
  siteId: 'fixture',
  name: 'Fixture Site',
  dataDir: tmp,
  token: TOKEN,
  adminHash: '5c4a4c1d4b3a7d1a6e4b8d0f5b0d7b8e0f9f7a3c5c2f6b3f2f0f5f2e0d3b6a9e',
  publicUrl: 'https://fixture.test',
  pages: [{ path: '/', file: fixture, root: 'main' }],
  settings: {
    bookingUrl: { label: 'Booking link', kind: 'url', default: 'https://default.example/book' },
    phone: { label: 'Phone', kind: 'phone', default: '(555) 000-0000' },
  },
  quotaMb: 1, maxFileMb: 1,
});
app.use(express.static(__dirname));

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };
const J = (r) => JSON.parse(r.content[0].text);
const page = async (base, p = '/') => (await fetch(base + p)).text();

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  let html = await page(base);
  assert(html.includes('data-zs="h1:1"') && html.includes('data-zs="section:0"'), 'page serves with element and section keys');
  assert(html.includes('<script>window.__fixtureChrome'), 'file script (chrome) present');
  assert((await fetch(base + '/zah-site/content?page=/')).status === 401, 'no token -> 401');

  const transport = new StreamableHTTPClientTransport(new URL(base + '/zah-site/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert(tools.length >= 30, `lists ${tools.length} tools`);

  // ---- keyed edits ----
  const elements = J(await call('list_content', { page: '/' }));
  assert(elements.some((e) => e.key === 'h1:1') && elements.some((e) => e.key === 'hero.cta'), 'list_content: positional + explicit keys');
  const heroH1 = elements.find((e) => e.text === 'Hello world').key;
  assert(heroH1 === 'h1:1', 'keys are body-wide: the header h1 is h1:0, the hero h1 is h1:1');
  await call('set_text', { page: '/', key: heroH1, text: 'Changed by MCP' });
  html = await page(base);
  assert(html.includes('Changed by MCP') && !html.includes('Hello world'), 'set_text seen by visitor');
  await call('set_text', { page: '/', key: 'li:0', text: 'Kept my icon' });
  html = await page(base);
  assert(html.includes('<span class="check">✓</span>Kept my icon'), 'child element kept');
  await call('set_link', { page: '/', key: 'hero.cta', href: 'https://example.com/book' });
  assert((await page(base)).includes('href="https://example.com/book"'), 'set_link');
  assert((await call('set_link', { page: '/', key: heroH1, href: 'https://x' })).isError, 'set_link on a heading refused');
  await call('set_hidden', { page: '/', key: 'p:0', hidden: true });
  assert(/<p[^>]*data-zs="p:0"[^>]*hidden/.test(await page(base)), 'set_hidden');

  // ---- structure ----
  const outline = J(await call('get_outline', { page: '/' }));
  assert(outline.some((o) => o.key === 'section:0') && outline.some((o) => o.tag === 'main'), 'get_outline lists sections and main');
  const ins = J(await call('insert_html', { page: '/', html: '<section class="new"><h2>New section</h2><p>By the client.</p><form action="https://formspree.io/f/x"><input name="e"></form><form action="/api/lead"><input name="z"></form><script src="https://widget.test/w.js"></script></section>', position: 'after', target: 'section:0' }));
  assert(ins.ok && ins.materialised && ins.inserted.length === 1 && /^n:/.test(ins.inserted[0]), 'insert_html materialises and returns a random key');
  html = await page(base);
  assert(html.includes('New section') && html.indexOf('New section') < html.indexOf('Item two'), 'inserted after section:0, before the list section');
  assert(html.includes('Changed by MCP') && html.includes('Kept my icon'), 'earlier keyed edits folded into the snapshot');
  assert(html.includes('<script>window.__fixtureChrome'), 'file chrome survives materialisation');
  assert(html.includes('action="https://formspree.io/f/x"') && html.includes('data-zs-inert'), 'external form kept, same-origin form made inert');
  assert(html.includes('src="https://widget.test/w.js" data-zs-keep'), 'client embed script kept');
  const newKey = ins.inserted[0];
  const list2 = J(await call('list_content', { page: '/' }));
  const newH2 = list2.find((e) => e.text === 'New section');
  assert(newH2 && newH2.section === newKey, 'new elements are keyed and know their section');
  await call('set_text', { page: '/', key: newH2.key, text: 'Renamed section' });
  assert((await page(base)).includes('Renamed section'), 'keyed edit on a materialised page');
  const dup = J(await call('duplicate', { page: '/', key: newKey }));
  assert(dup.ok && dup.newKey && dup.newKey !== newKey, 'duplicate returns a new key');
  assert(((await page(base)).match(/Renamed section/g) || []).length === 2, 'duplicate visible twice');
  await call('move', { page: '/', key: dup.newKey, position: 'prepend', target: 'main:0' });
  html = await page(base);
  assert(html.indexOf(`data-zs="${dup.newKey}"`) < html.indexOf('data-zs="section:0"'), 'move to top of main');
  await call('remove', { page: '/', key: dup.newKey });
  assert(((await page(base)).match(/Renamed section/g) || []).length === 1, 'remove');
  assert((await call('remove', { page: '/', key: 'main:0' })).isError, 'main cannot be removed');
  await call('set_html', { page: '/', key: newKey, html: '<section class="rewritten"><h2>Rewritten</h2></section>' });
  assert((await page(base)).includes('Rewritten') && !(await page(base)).includes('Renamed section'), 'set_html replaces the section');
  const gh = J(await call('get_html', { page: '/', key: 'body' }));
  assert(gh.html.includes('Rewritten') && !gh.html.includes('__fixtureChrome'), 'get_html body excludes chrome');

  // ---- css ----
  await call('append_css', { css: '.new{color:red}' });
  assert((await page(base)).includes('<style id="zs-custom">') && (await page(base)).includes('.new{color:red}'), 'custom css injected');
  const styles = J(await call('get_styles'));
  assert(styles.siteCss.includes('.check') && styles.customCss.includes('.new'), 'get_styles shows site css and custom css');

  // ---- pages ----
  assert((await call('create_page', { path: '/zah-site/x', title: 'x' })).isError, 'reserved path refused');
  assert((await call('create_page', { path: '/Bad Path', title: 'x' })).isError, 'bad path refused');
  const cp = J(await call('create_page', { path: '/about', title: 'About us', description: 'Who we are', html: '<h1>About page</h1><p>Made by the client.</p>' }));
  assert(cp.ok && cp.path === '/about', 'create_page');
  html = await page(base, '/about');
  assert(html.includes('<title>About us</title>') && html.includes('About page') && html.includes('Not editable, outside main') && html.includes('__fixtureChrome'), 'new page served with template head, header and chrome');
  assert(html.includes('.new{color:red}'), 'custom css on the new page too');
  const pages = J(await call('list_pages'));
  assert(pages.length === 2 && pages.find((p) => p.path === '/about' && !p.built), 'list_pages shows both');
  await call('set_page_meta', { page: '/about', title: 'About New Title' });
  assert((await page(base, '/about')).includes('<title>About New Title</title>'), 'set_page_meta');
  assert((await fetch(base + '/nope')).status === 404, 'unknown path still 404');
  assert((await call('delete_page', { path: '/' })).isError, 'built page cannot be deleted');
  const dp = J(await call('delete_page', { path: '/about' }));
  assert(dp.ok && (await fetch(base + '/about')).status === 404, 'delete_page');

  // ---- assets ----
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const asset = J(await call('add_asset', { name: 'dot.png', dataBase64: png }));
  assert(asset.url && asset.url.startsWith('/zah-site/assets/dot-') && asset.type === 'image/png', 'add_asset base64');
  const got = await fetch(base + asset.url);
  assert(got.ok && got.headers.get('cache-control').includes('immutable'), 'asset served, cached hard');
  assert((await call('add_asset', { name: 'evil.html', dataBase64: Buffer.from('<html>').toString('base64'), mime: 'text/html' })).isError, 'non-media type refused');
  const big = Buffer.alloc(1.2 * 1024 * 1024).toString('base64');
  assert((await call('add_asset', { name: 'big.png', dataBase64: big, mime: 'image/png' })).isError, 'over per-file limit refused');
  const usage = J(await call('get_usage'));
  assert(usage.quotaMb === 1 && usage.usedMb >= 0, 'get_usage reports quota');
  await call('set_image', { page: '/', key: 'img:0', src: asset.url, alt: 'dot' });
  assert((await page(base)).includes(`src="${asset.url}"`), 'set_image to an asset');
  const del = J(await call('delete_asset', { name: asset.name }));
  assert(del.ok && (await fetch(base + asset.url)).status === 404, 'delete_asset');

  // ---- settings ----
  const gs = J(await call('get_settings'));
  assert(gs.find((x) => x.key === 'bookingUrl').value === 'https://default.example/book', 'get_settings default');
  await call('set_setting', { key: 'bookingUrl', value: 'https://new.example/book' });
  assert(site.settings().bookingUrl === 'https://new.example/book', 'set_setting read by host');
  assert((await call('set_setting', { key: 'bookingUrl', value: 'not a url' })).isError, 'bad url refused');
  await call('set_setting', { key: 'bookingUrl', value: '' });
  assert(site.settings().bookingUrl === 'https://default.example/book', 'empty resets');

  // ---- editor snapshot (root = main) ----
  let r = await fetch(base + '/zah-site/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ page: '/', root: 'main', html: '<h1>Published by editor</h1><p>Body</p>' }) });
  assert(r.ok, 'snapshot accepted');
  html = await page(base);
  assert(html.includes('Published by editor') && html.includes('Not editable, outside main') && html.includes('__fixtureChrome'), 'editor publish replaces main only; header and chrome stay');
  const afterSnap = J(await call('list_content', { page: '/' }));
  const pubH1 = afterSnap.find((e) => e.text === 'Published by editor');
  await call('set_text', { page: '/', key: pubH1.key, text: 'MCP after editor' });
  assert((await page(base)).includes('MCP after editor'), 'MCP edit on top of an editor publish');

  // ---- history, reset ----
  const hist = J(await call('history'));
  assert(hist.current.version > 10 && hist.previous.length > 5, 'history accumulates');
  const rp = J(await call('reset_page', { page: '/' }));
  html = await page(base);
  assert(rp.ok && html.includes('Hello world') && !html.includes('Rewritten'), 'reset_page returns the build');
  await call('revert', { version: hist.current.version });
  assert((await page(base)).includes('MCP after editor'), 'revert undoes the reset');
  const rs = J(await call('reset_site', { confirm: true }));
  html = await page(base);
  assert(rs.ok && html.includes('Hello world') && !html.includes('zs-custom'), 'reset_site drops pages, snapshots and css');
  assert(site.settings().bookingUrl === 'https://default.example/book', 'settings survive reset_site');

  // ---- auth ----
  const badT = new StreamableHTTPClientTransport(new URL(base + '/zah-site/mcp'), { requestInit: { headers: { Authorization: 'Bearer nope' } } });
  let refused = false;
  try { await new Client({ name: 'x', version: '0' }).connect(badT); } catch (e) { refused = true; }
  assert(refused, 'wrong token cannot connect');

  await client.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
