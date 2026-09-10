/* =========================================================
   ZAH SITE MCP

   Lets a client's own AI (Claude, or anything that speaks MCP) read and
   build on their ZAH-built site, and gives Zah Editor a real Publish so
   edits reach every visitor instead of one browser's localStorage.

   ONE ENTRY POINT:

     const zahSite = require('zah-site-mcp');
     const site = zahSite.mount(app, {
       siteId: 'new-vision',
       name: 'New Vision Therapy & Wellness',
       dataDir: process.env.DATA_DIR || '/data',      // a Railway volume
       token: process.env.SITE_MCP_TOKEN,             // the client's AI presents this
       adminHash: '<sha256 of email:password>',       // Zah Editor login, for Publish
       pages: [{ path: '/', file: path.join(__dirname, 'index.html'), root: 'main' }],
       publicUrl: process.env.PUBLIC_URL,
       settings: { bookingUrl: { label, kind: 'url', default }, phone: { ... } },
       quotaMb: 250, maxFileMb: 30,                  // the client's storage
       crm: { leadPath: '/api/lead', enabled: () => crm.leadsEnabled() },  // the ZAH CRM door for forms
       credit: true,                                  // the house link on every page; only Zah sets false
     });

   Mount it BEFORE express.static and before any product that reads
   site.settings(). It serves the listed pages and every client-created
   page itself (file + overlay). Everything it owns lives under /zah-site/*
   and <dataDir>/zah-site/. It reads no site styling and renders no UI.

   THE MODEL: the files are the permanent default. The client's AI can add
   pages, sections, layout, style, images, video, embeds and forms on top;
   reset_page and reset_site return to the build. Forms go to ZAH CRM by
   default (the host's lead seam, when Zah has switched it on) or to the
   client's OWN outside service; this server has no database for them.
   Storage stops at the quota. Connecting the CRM, or anything else into
   Zah's platform, is Zah's work, by design.
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { Assets } = require('./lib/assets');
const { SiteOps, KINDS, normalise } = require('./lib/ops');
const { DEFAULT_EDITABLE, DEFAULT_CHROME, sanitize } = require('./lib/render');
const { handleMcp } = require('./lib/mcp');
const { verifyAccount, accountLinks, DEFAULT_URL } = require('./lib/account');

const PREFIX = '/zah-site';

function mount(app, cfg) {
  if (!app || typeof app.use !== 'function') throw new Error('zah-site-mcp: mount(app, cfg) needs an Express app');
  if (!cfg || !cfg.siteId) throw new Error('zah-site-mcp: cfg.siteId is required');
  if (!Array.isArray(cfg.pages) || !cfg.pages.length) throw new Error('zah-site-mcp: cfg.pages must list at least one page');

  const dataDir = cfg.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const store = new Store(dataDir);
  const assets = new Assets(store, { maxFileMb: cfg.maxFileMb, quotaMb: cfg.quotaMb });
  const token = String(cfg.token || '');
  const adminHash = String(cfg.adminHash || '');
  // THE ONE LOGIN. The client's ZAH Account (zahbrandsolutions.com/account)
  // signs in to their own editor and Publish here, so the site never asks
  // them to remember a second password. adminHash stays as the offline way
  // in: Zah's, and the one that still works if head office is unreachable.
  const accountUrl = String(cfg.accountUrl || process.env.ACCOUNT_URL || DEFAULT_URL).replace(/\/+$/, '');
  const accountLogin = cfg.accountLogin !== false;
  const express = cfg.express || require('express');

  const builtPages = cfg.pages.map((p) => ({ path: normalise(p.path), file: p.file, root: p.root || 'main' }));
  // credit: the house link on every page, on unless Zah turns it off for a site.
  const opts = { editable: cfg.editable || DEFAULT_EDITABLE, chrome: (cfg.chrome || []).concat(DEFAULT_CHROME), credit: cfg.credit !== false };

  const settingsSchema = {};
  for (const [k, def] of Object.entries(cfg.settings || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k)) throw new Error(`zah-site-mcp: bad setting name "${k}"`);
    const kind = def.kind || 'text';
    if (!KINDS[kind]) throw new Error(`zah-site-mcp: setting "${k}" has unknown kind "${kind}"`);
    settingsSchema[k] = { label: def.label || k, kind, default: def.default === undefined ? '' : String(def.default) };
  }

  const ops = new SiteOps({ store, assets, builtPages, opts, settingsSchema });
  try { ops.host = cfg.publicUrl ? new URL(cfg.publicUrl).hostname : ''; } catch (e) { ops.host = ''; }
  // The ZAH CRM door for forms. The host says where its lead seam is and
  // whether it is switched on; the sanitiser and the AI's notes follow.
  ops.crm = Object.assign({ leadPath: '/api/lead', enabled: () => false, contactUrl: 'https://zahbrandsolutions.com/contact', trialUrl: 'https://zahcrm.com' }, cfg.crm || {});

  const site = {
    id: cfg.siteId,
    name: cfg.name || cfg.siteId,
    publicUrl: cfg.publicUrl,
    store, assets, ops,
    pages: builtPages,
    settingsSchema,
    settings: () => ops.settings(),
    setSetting: (k, v, by) => ops.setSetting(k, v, by),
  };

  // ---------- auth ----------
  const okToken = (presented) => {
    if (!token || !presented) return false;
    const a = Buffer.from(String(presented)); const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const bearer = (req) => {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : (req.params && req.params.token) || '';
  };
  const requireToken = (req, res, next) => {
    if (!token) return res.status(503).json({ error: 'ZAH Site MCP is not switched on for this site (no SITE_MCP_TOKEN).' });
    if (!okToken(bearer(req))) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  const json = express.json({ limit: '3mb' });

  // ---------- pages: built ones and client-created ones ----------
  const cache = new Map();
  const serve = (p, req, res, next) => {
    try {
      const stat = fs.statSync(p.file);
      const state = store.read();
      const cacheKey = `${p.path}|${stat.mtimeMs}:${state.version}`;
      let html = cache.get(cacheKey);
      if (!html) {
        html = ops.render(p).html;
        if (cache.size > 50) cache.clear();
        cache.set(cacheKey, html);
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Zah-Site-Version', String(state.version));
      res.type('html').send(html);
    } catch (e) {
      console.error('[zah-site] render failed, serving file as is:', e.message);
      next();
    }
  };
  for (const p of builtPages) app.get(p.path, (req, res, next) => serve(p, req, res, next));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const np = normalise(req.path);
    if (np.startsWith(PREFIX) || ops.isBuilt(np)) return next();
    const p = ops.page(np);
    if (!p || !p.custom) return next();
    serve(p, req, res, next);
  });

  // ---------- assets ----------
  app.get(`${PREFIX}/assets/:name`, (req, res) => {
    const file = assets.resolve(req.params.name);
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  });

  // ---------- MCP ----------
  const mcp = async (req, res) => handleMcp(site, req, res);
  app.post(`${PREFIX}/mcp`, requireToken, json, mcp);
  app.post(`${PREFIX}/mcp/k/:token`, requireToken, json, mcp);
  app.get([`${PREFIX}/mcp`, `${PREFIX}/mcp/k/:token`], requireToken, (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC here.' }, id: null }));
  app.delete([`${PREFIX}/mcp`, `${PREFIX}/mcp/k/:token`], requireToken, (_req, res) => res.status(204).end());

  // ---------- REST ----------
  app.get(`${PREFIX}/status`, (_req, res) => {
    const s = store.read();
    // Who has ever changed this site: the client's AI ('mcp'), the on-page
    // editor ('publish'), or the account page ('rest'). ZAH Account reads
    // this to tick "connected your AI" the moment it is true. History files
    // are small JSON snapshots; the newest fifty are enough to answer.
    const by = new Set();
    if (s.updatedBy) by.add(s.updatedBy);
    try {
      for (const h of store.history().slice(0, 50)) {
        try { const j = JSON.parse(fs.readFileSync(path.join(store.historyDir, h.file), 'utf8')); if (j && j.updatedBy) by.add(j.updatedBy); } catch (e) { /* skip */ }
      }
    } catch (e) { /* no history yet */ }
    res.json({ site: site.id, mcp: !!token, publish: !!((adminHash || accountLogin) && token), account: accountLogin ? accountUrl : null, version: s.version, updatedAt: s.updatedAt, updatedBy: s.updatedBy || null, editedBy: [...by], pages: ops.listPages().map((p) => p.path), settings: Object.keys(settingsSchema), usage: assets.usage(), crmConnected: !!(ops.crm.enabled && ops.crm.enabled()) });
  });

  // Zah Editor's pencil and Publish. Two ways in, one of them the client's:
  //   1. their ZAH Account, which is the login they already have; ZAH Account
  //      also confirms the account pays for THIS site
  //   2. this site's own adminHash, Zah's spare key, which needs no network
  // Slow the guessing down either way: five wrong answers a minute per address.
  const attempts = new Map();
  const WRONG_LIMIT = Number(cfg.loginTries || 5);
  const locked = (ip) => { const a = attempts.get(ip); return !!a && Date.now() < a.until && a.n >= WRONG_LIMIT; };
  const wrong = (ip) => {
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || now > a.until) { attempts.set(ip, { n: 1, until: now + 60000 }); if (attempts.size > 2000) for (const [k, v] of attempts) if (now > v.until) attempts.delete(k); return; }
    a.n += 1;
  };

  app.post(`${PREFIX}/login`, json, async (req, res) => {
    if (!token || (!adminHash && !accountLogin)) return res.status(503).json({ error: 'Publishing is not switched on for this site.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const ip = req.ip || 'unknown';
    if (!email || !password) return res.status(401).json({ error: 'Login failed.' });
    if (locked(ip)) return res.status(429).json({ error: 'Too many tries. Wait a minute, then try again.' });

    if (adminHash && crypto.createHash('sha256').update(`${email}:${password}`).digest('hex') === adminHash) {
      return res.json({ token, who: email, via: 'site' });
    }
    if (accountLogin) {
      const who = await verifyAccount({ accountUrl, siteId: site.id, email, password });
      if (who) return res.json({ token, who: who.name || who.email, via: 'account' });
    }
    wrong(ip);   // only a wrong answer counts, so working here is never punished
    res.status(401).json({ error: accountLogin ? 'That email and password do not match your ZAH Account for this site.' : 'Login failed.' });
  });

  const withPage = (req, res, fn) => {
    const p = ops.page(String((req.query && req.query.page) || (req.body && req.body.page) || '/'));
    if (!p) return res.status(404).json({ error: 'no such page' });
    return fn(p);
  };

  app.get(`${PREFIX}/pages`, requireToken, (_req, res) => res.json(ops.listPages()));
  app.get(`${PREFIX}/content`, requireToken, (req, res) => withPage(req, res, (p) => res.json({ page: p.path, version: store.read().version, elements: ops.list(p), outline: ops.outline(p) })));
  app.get(`${PREFIX}/html`, requireToken, (req, res) => withPage(req, res, (p) => { const r = ops.getHtml(p, String(req.query.key || 'body')); res.status(r.error ? 404 : 200).json(r); }));
  app.post(`${PREFIX}/edits`, requireToken, json, (req, res) => withPage(req, res, (p) => {
    const edits = req.body && req.body.edits;
    if (!edits || typeof edits !== 'object') return res.status(400).json({ error: 'edits object required' });
    res.json({ ok: true, version: store.applyEdits(p.path, edits, 'rest').version });
  }));

  // Zah Editor publish: the editor's root (usually <main>) after a Save.
  app.post(`${PREFIX}/snapshot`, requireToken, json, (req, res) => withPage(req, res, (p) => {
    const html = String((req.body && req.body.html) || '');
    if (!html.trim()) return res.status(400).json({ error: 'html required' });
    if (html.length > 1.5 * 1024 * 1024) return res.status(413).json({ error: 'snapshot too large; embedded images should be uploaded, not pasted' });
    const rootSel = String((req.body && req.body.root) || p.root);
    const result = ops.withDom(p, ($) => {
      const $root = $('body').find(rootSel).first();
      if (!$root.length) return { error: `no ${rootSel} on ${p.path}` };
      $root.html(sanitize(html, { host: ops.host }));
      return { published: rootSel };
    }, 'editor');
    res.status(result.error ? 400 : 200).json(result);
  }));

  // Page SEO over REST, for the account page's SEO widget (the MCP tools
  // set_page_meta / get_page_meta are the same operation for the client's AI).
  app.get(`${PREFIX}/page-meta`, requireToken, (req, res) => withPage(req, res, (p) => {
    const m = (store.read().pages || {})[p.path] || {};
    res.json({ page: p.path, title: m.title || '', description: m.description || '', image: m.image || '' });
  }));
  app.post(`${PREFIX}/page-meta`, requireToken, json, (req, res) => withPage(req, res, (p) => {
    const b = req.body || {};
    const image = b.image === undefined ? undefined : String(b.image).slice(0, 500);
    if (image && !/^(https:\/\/|\/)/.test(image)) return res.status(400).json({ error: 'image must be an https URL or a path starting with /' });
    const r = ops.setPageMeta(p, {
      title: b.title === undefined ? undefined : String(b.title).slice(0, 200),
      description: b.description === undefined ? undefined : String(b.description).slice(0, 300),
      image,
    }, 'rest');
    res.json(r);
  }));
  app.get(`${PREFIX}/settings`, requireToken, (_req, res) => res.json({ schema: settingsSchema, values: ops.settings() }));
  app.post(`${PREFIX}/settings`, requireToken, json, (req, res) => {
    const body = (req.body && req.body.values) || req.body || {};
    const results = {};
    for (const [k, v] of Object.entries(body)) results[k] = ops.setSetting(k, v, 'rest');
    const failed = Object.values(results).find((r) => r.error);
    res.status(failed ? 400 : 200).json({ results, values: ops.settings(), version: store.read().version });
  });

  app.get(`${PREFIX}/history`, requireToken, (_req, res) => { const cur = store.read(); res.json({ current: { version: cur.version, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }, previous: store.history() }); });
  app.post(`${PREFIX}/revert`, requireToken, json, (req, res) => { try { res.json({ ok: true, version: store.revert(Number(req.body && req.body.version), 'revert').version }); } catch (e) { res.status(400).json({ error: e.message }); } });
  app.post(`${PREFIX}/reset`, requireToken, json, (req, res) => withPage(req, res, (p) => res.json(ops.resetPage(p, 'rest'))));
  app.post(`${PREFIX}/reset-site`, requireToken, json, (_req, res) => res.json(ops.resetSite('rest')));
  app.get(`${PREFIX}/usage`, requireToken, (_req, res) => res.json(assets.usage()));

  // ---------- the back office, on the client's own domain ----------
  // A client looks for their own things on their own site, not on ours. These
  // five short paths are the doors, and every one of them lands on the ONE
  // login: /edit opens the pencil here, the rest hand off to ZAH Account,
  // which mints the ZAH CRM session without a second password.
  const doors = cfg.backOffice === false ? null : Object.assign(
    { account: '/account', login: '/login', edit: '/edit', crm: '/crm', dispatch: '/dispatch' },
    typeof cfg.backOffice === 'object' ? cfg.backOffice : {}
  );
  if (doors) {
    const links = accountLinks(accountUrl);
    const door = (where, to) => {
      const at = normalise(where);
      // Never shadow a real page of the site, built or client-created.
      if (ops.isBuilt(at) || (ops.page(at) && ops.page(at).custom)) return null;
      app.get(at, (_req, res) => {
        res.setHeader('X-Robots-Tag', 'noindex');
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, typeof to === 'function' ? to() : to);
      });
      return at;
    };
    const opened = [
      doors.account && door(doors.account, links.account),
      doors.login && door(doors.login, links.account),
      // The editor is on the page itself; ?edit=1 opens its login on arrival.
      // The site's own home, not builtPages[0]: a site that picks between
      // designs rewrites / to the chosen one, and that is the one to edit.
      doors.edit && door(doors.edit, '/?edit=1'),
      doors.crm && door(doors.crm, links.crm),
      doors.dispatch && door(doors.dispatch, links.dispatch),
    ].filter(Boolean);
    if (opened.length) console.log(`[zah-site] back office: ${opened.join(' ')} -> ZAH Account`);
  }

  app.get(`${PREFIX}/publish.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'publish.js'));
  });

  console.log(`[zah-site] ${site.id}: mcp ${token ? 'ON' : 'off (no token)'}, publish ${(adminHash || accountLogin) && token ? `ON (${[accountLogin && 'ZAH Account', adminHash && 'site password'].filter(Boolean).join(' + ')})` : 'off'}, data ${store.dir}, quota ${assets.quota / 1048576}MB, pages ${builtPages.map((p) => p.path).join(' ')}`);
  return site;
}

module.exports = { mount, PREFIX };
