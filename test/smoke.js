/* End-to-end smoke test: mount into a throwaway Express app with a fixture
   page, then drive it through REST and through a real MCP client. */
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
mount(app, {
  siteId: 'fixture',
  name: 'Fixture Site',
  dataDir: tmp,
  token: TOKEN,
  adminHash: '5c4a4c1d4b3a7d1a6e4b8d0f5b0d7b8e0f9f7a3c5c2f6b3f2f0f5f2e0d3b6a9e', // not a real pair
  pages: [{ path: '/', file: fixture, root: 'main' }],
});
app.use(express.static(__dirname));

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. page serves with keys
  let html = await (await fetch(base + '/')).text();
  assert(html.includes('data-zs="h1:0"'), 'page serves with data-zs keys');
  assert(html.includes('Hello world'), 'original text present');

  // 2. unauthenticated writes refused
  let r = await fetch(base + '/zah-site/content?page=/');
  assert(r.status === 401, 'no token -> 401');

  // 3. MCP client
  const transport = new StreamableHTTPClientTransport(new URL(base + '/zah-site/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.length >= 10, `lists ${tools.tools.length} tools`);

  const list = await client.callTool({ name: 'list_content', arguments: { page: '/' } });
  const elements = JSON.parse(list.content[0].text);
  assert(elements.some((e) => e.key === 'h1:0'), 'list_content returns h1:0');
  assert(elements.some((e) => e.key === 'hero.cta'), 'explicit data-zs key survives');

  const set = await client.callTool({ name: 'set_text', arguments: { page: '/', key: 'h1:0', text: 'Changed by MCP' } });
  assert(!set.isError, 'set_text ok');
  html = await (await fetch(base + '/')).text();
  assert(html.includes('Changed by MCP') && !html.includes('Hello world'), 'visitor sees the new text');

  const li = await client.callTool({ name: 'set_text', arguments: { page: '/', key: 'li:0', text: 'Kept my icon' } });
  html = await (await fetch(base + '/')).text();
  assert(html.includes('<span class="check">✓</span>Kept my icon'), 'child element kept when text changes');

  const link = await client.callTool({ name: 'set_link', arguments: { page: '/', key: 'hero.cta', href: 'https://example.com/book' } });
  html = await (await fetch(base + '/')).text();
  assert(html.includes('href="https://example.com/book"'), 'set_link changes href');

  const bad = await client.callTool({ name: 'set_link', arguments: { page: '/', key: 'h1:0', href: 'https://x' } });
  assert(bad.isError, 'set_link on a heading is refused');

  const hide = await client.callTool({ name: 'set_hidden', arguments: { page: '/', key: 'p:0', hidden: true } });
  html = await (await fetch(base + '/')).text();
  assert(/<p[^>]*data-zs="p:0"[^>]*hidden/.test(html), 'set_hidden hides');

  const hist = JSON.parse((await client.callTool({ name: 'history', arguments: {} })).content[0].text);
  assert(hist.current.version === 4 && hist.previous.length === 3, `history has 3 previous, current v4`);

  const rev = await client.callTool({ name: 'revert', arguments: { version: 1 } });
  html = await (await fetch(base + '/')).text();
  assert(html.includes('Changed by MCP') && html.includes('Hello world') === false && !html.includes('Kept my icon'), 'revert to v1 restores only the first edit');

  // 4. editor snapshot via REST
  r = await fetch(base + '/zah-site/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ page: '/', html: '<h1>Published by editor</h1><p>Body</p>' }) });
  assert(r.ok, 'snapshot accepted');
  html = await (await fetch(base + '/')).text();
  assert(html.includes('Published by editor') && html.includes('data-zs="h1:0"'), 'snapshot replaces root and gets keys');

  const after = await client.callTool({ name: 'set_text', arguments: { page: '/', key: 'p:0', text: 'MCP on top of the snapshot' } });
  html = await (await fetch(base + '/')).text();
  assert(html.includes('MCP on top of the snapshot'), 'MCP edit applies on top of a snapshot');

  // 5. bad token
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
