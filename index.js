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
  const express = cfg.express || require('express');

  const builtPages = cfg.pages.map((p) => ({ path: normalise(p.path), file: p.file, root: p.root || 'main' }));
  const opts = { editable: cfg.editable || DEFAULT_EDITABLE, chrome: (cfg.chrome || []).concat(DEFAULT_CHROME) };

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
    res.json({ site: site.id, mcp: !!token, publish: !!(adminHash && token), version: s.version, updatedAt: s.updatedAt, pages: ops.listPages().map((p) => p.path), settings: Object.keys(settingsSchema), usage: assets.usage(), crmConnected: !!(ops.crm.enabled && ops.crm.enabled()) });
  });

  app.post(`${PREFIX}/login`, json, (req, res) => {
    if (!adminHash || !token) return res.status(503).json({ error: 'Publishing is not switched on for this site.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const h = crypto.createHash('sha256').update(`${email}:${password}`).digest('hex');
    if (h !== adminHash) return res.status(401).json({ error: 'Login failed.' });
    res.json({ token });
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

  app.get(`${PREFIX}/publish.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'publish.js'));
  });

  console.log(`[zah-site] ${site.id}: mcp ${token ? 'ON' : 'off (no token)'}, publish ${adminHash && token ? 'ON' : 'off'}, data ${store.dir}, quota ${assets.quota / 1048576}MB, pages ${builtPages.map((p) => p.path).join(' ')}`);
  return site;
}

module.exports = { mount, PREFIX };
