const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { mount } = require('..');
const R = require('../lib/render');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zah-editor-persist-'));
  const file = path.join(dir, 'index.html');
  const original = '<html><head></head><body><header><span data-zs="header.hours">Open daily</span></header><main><h1 data-zs="hero">Delivery</h1><form action="/api/lead"><input name="name"></form></main><footer><p data-zs="hours">Standard hours</p></footer><script>window.app=true;</script></body></html>';
  fs.writeFileSync(file, original);
  function start() {
    const app = express();
    const site = mount(app, { siteId: 'editor-test', token: 'test', dataDir: dir, pages: [{ path: '/', file, root: 'body' }], crm: { leadPath: '/api/lead', enabled: () => true } });
    return { site, server: app.listen(0) };
  }
  let { site, server } = start();
  let base = `http://127.0.0.1:${server.address().port}`;
  const post = async body => {
    const r = await fetch(base + '/zah-site/snapshot', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  try {
    const rendered = R.load(await (await fetch(base)).text());
    const revision = Number(rendered('meta[name="zah-site-version"]').attr('content'));
    const sourceHash = rendered('meta[name="zah-site-source"]').attr('content');
    const baseHtml = R.bodyForSnapshot(rendered, {});
    const html = baseHtml.replace('Standard hours', '8am to 5pm').replace('Open daily', 'Dispatch hours');
    let r = await post({ root: 'body', html, baseHtml, baseVersion: revision, sourceHash });
    assert.equal(r.status, 200);
    assert.equal(r.data.mode, 'patch');
    assert.equal(site.store.read().snapshots['/'], undefined);
    assert.equal(site.ops.render(site.ops.page('/')).$('footer').text(), '8am to 5pm');
    assert.equal(site.ops.render(site.ops.page('/')).$('form').attr('action'), '/api/lead');
    assert.equal((await post({ root: 'body', html: baseHtml, baseHtml, baseVersion: revision })).status, 409);
    console.log('ok  header/footer save is a patch; stale save refused; live form preserved');
    fs.writeFileSync(file, original.replace('<main>', '<main><h2 data-zs="new">New source feature</h2>'));
    assert.equal((await post({ root: 'body', html, baseHtml, baseVersion: r.data.version, sourceHash })).status, 409);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    ({ site, server } = start()); base = `http://127.0.0.1:${server.address().port}`;
    const fresh = await (await fetch(base)).text();
    assert(fresh.includes('8am to 5pm') && fresh.includes('New source feature') && fresh.includes('Dispatch hours'));
    console.log('ok  saved text and new source both survive a process restart');
    const rr = R.load(fresh); const baseline = R.bodyForSnapshot(rr, {});
    r = await post({ root: 'body', baseHtml: baseline, html: baseline.replace('</main>', '<section><p>Added section</p></section></main>'), baseVersion: site.store.read().version });
    assert.equal(r.status, 200);
    const structural = site.ops.render(site.ops.page('/'));
    assert(structural.html.includes('Added section'));
    assert.equal(structural.$('form').attr('action'), '/api/lead');
    assert.equal(structural.$('form').attr('data-zs-inert'), undefined);
    assert.equal(structural.$('script').length, 1);
    const first = site.ops.list(site.ops.page('/')).map(e => e.key);
    assert.deepEqual(site.ops.list(site.ops.page('/')).map(e => e.key), first);
    console.log('ok  structural publish keeps CRM form, scripts and stable keys');
    const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/zah-site/export')).status, 401);
    const backup = await (await fetch(base + '/zah-site/export', { headers })).json();
    const hash = require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const migrate = body => fetch(base + '/zah-site/rebase', { method: 'POST', headers, body: JSON.stringify(body) });
    const reviewed = { baseVersion: backup.version, sourceHash: hash, confirm: 'replace-snapshot-with-reviewed-edits', edits: { hours: { text: '8am to 5pm' } } };
    assert.equal((await migrate({ ...reviewed, baseVersion: -1 })).status, 409);
    assert.equal((await migrate(reviewed)).status, 200);
    assert.equal(site.store.read().snapshots['/'], undefined);
    assert(site.ops.render(site.ops.page('/')).html.includes('8am to 5pm'));
    const historical = await (await fetch(base + '/zah-site/export?version=' + backup.version, { headers })).json();
    assert.deepEqual(historical, backup);
    console.log('ok  reviewed migration is atomic, refuses stale data and preserves the complete prior version');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
