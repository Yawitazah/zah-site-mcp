/* THE ONE LOGIN. The client signs in to their own editor with the ZAH Account
   they pay with; the site's own key still works with no network; and the back
   office doors on their own domain land on that same account. A stand-in for
   ZAH Account answers here, so nothing leaves the machine. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { mount } = require('..');

const TOKEN = 'zs_test_token_123456';
const SITE_PW = 'zah@example.com:letmein';
const ADMIN_HASH = crypto.createHash('sha256').update(SITE_PW).digest('hex');
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };

// ---- the stand-in ZAH Account -------------------------------------------
let asked = [];
const acct = express();
acct.use(express.json());
acct.post('/api/account/site-login', (req, res) => {
  const { siteId, email, password } = req.body || {};
  asked.push({ siteId, email });
  if (email === 'monta@example.com' && password === 'right-one' && siteId === 'fixture')
    return res.json({ ok: true, email, name: 'Monta', business: 'ANewWay Delivery LLC', plan: 'care-crm-dispatch' });
  res.status(401).json({ error: 'That email and password do not match an account for this site.' });
});

(async () => {
  const acctServer = acct.listen(0);
  const accountUrl = `http://127.0.0.1:${acctServer.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zah-login-'));

  const app = express();
  mount(app, {
    siteId: 'fixture', name: 'Fixture', dataDir: tmp, token: TOKEN, adminHash: ADMIN_HASH, accountUrl,
    pages: [{ path: '/', file: path.join(__dirname, 'fixture.html'), root: 'main' }],
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => {
    const r = await fetch(base + '/zah-site/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const door = async (p) => { const r = await fetch(base + p, { redirect: 'manual' }); return { status: r.status, to: r.headers.get('location'), robots: r.headers.get('x-robots-tag') }; };

  // ---- the client's ZAH Account opens their own editor ----
  let r = await login('monta@example.com', 'right-one');
  assert(r.status === 200 && r.body.token === TOKEN && r.body.via === 'account', 'the ZAH Account signs in and gets the site token');
  assert(r.body.who === 'Monta', 'the answer says who signed in');
  assert(asked[0].siteId === 'fixture', 'ZAH Account was asked about THIS site');

  r = await login('monta@example.com', 'wrong-one');
  assert(r.status === 401 && /ZAH Account/.test(r.body.error), 'a wrong password is refused, and the message names the one login');

  // ---- the site's own key still works, and needs no network ----
  r = await login('zah@example.com', 'letmein');
  assert(r.status === 200 && r.body.via === 'site', 'the site key opens it without asking ZAH Account');
  const before = asked.length;
  await login('zah@example.com', 'letmein');
  assert(asked.length === before, 'the site key never leaves the machine');

  // ---- the doors on the client's own domain ----
  const acc = await door('/account');
  assert(acc.status === 302 && acc.to.endsWith('/account') && acc.robots === 'noindex', '/account -> ZAH Account, noindex');
  assert((await door('/login')).to.endsWith('/account'), '/login -> ZAH Account');
  assert(/\/api\/account\/crm\?next=%2Fdispatch$/.test((await door('/dispatch')).to), '/dispatch -> the signed hand-off to the Dispatch board');
  assert(/\/api\/account\/crm\?next=%2F$/.test((await door('/crm')).to), '/crm -> the signed hand-off to ZAH CRM');
  assert((await door('/edit')).to === '/?edit=1', '/edit -> the page with the editor opening');

  // ---- a door never shadows a real page ----
  const app2 = express();
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zah-login2-'));
  mount(app2, {
    siteId: 'fixture', dataDir: tmp2, token: TOKEN, accountUrl,
    pages: [{ path: '/', file: path.join(__dirname, 'fixture.html'), root: 'main' },
            { path: '/account', file: path.join(__dirname, 'fixture.html'), root: 'main' }],
  });
  const s2 = app2.listen(0);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const real = await fetch(b2 + '/account', { redirect: 'manual' });
  assert(real.status === 200 && (await real.text()).includes('Hello world'), 'a site with its own /account page keeps it');
  // ...and with no site key at all, the ZAH Account is the only way in
  r = await (await fetch(b2 + '/zah-site/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'monta@example.com', password: 'right-one' }) })).json();
  assert(r.token === TOKEN, 'no site password set: the ZAH Account is the login');

  // ---- guessing is slowed down, working is not ----
  const app3 = express();
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'zah-login3-'));
  mount(app3, { siteId: 'fixture', dataDir: tmp3, token: TOKEN, adminHash: ADMIN_HASH, accountUrl, pages: [{ path: '/', file: path.join(__dirname, 'fixture.html'), root: 'main' }] });
  const s3 = app3.listen(0);
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const try3 = (pw) => fetch(b3 + '/zah-site/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'monta@example.com', password: pw }) });
  for (let i = 0; i < 5; i++) await try3('nope');
  assert((await try3('nope')).status === 429, 'six wrong answers in a minute -> 429');
  assert((await try3('right-one')).status === 429, 'and the lock holds until the minute is up');

  const st = await (await fetch(base + '/zah-site/status')).json();
  assert(st.publish === true && st.account === accountUrl, 'status reports publishing on and where the one login lives');

  for (const x of [server, acctServer, s2, s3]) x.close();
  for (const d of [tmp, tmp2, tmp3]) fs.rmSync(d, { recursive: true, force: true });
  console.log('\nALL PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
