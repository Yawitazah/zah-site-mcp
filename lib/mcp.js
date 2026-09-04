/* =========================================================
   ZAH SITE MCP, the MCP server

   Streamable HTTP, stateless: every request gets a fresh McpServer over the
   same SiteOps, so there is no session table to leak or expire. The tools
   ARE the contract a client's AI gets. Read tools first, then words, then
   structure, then pages, style, assets, settings, safety.

   The promise to Zah, encoded here: the client can build whatever a normal
   website has (pages, sections, layout, style, pictures, video, embeds,
   forms). Data collection goes to THEIR OWN outside service, never to this
   server, which has no database for them; storage stops at the quota. And
   the build Zah shipped is always one reset away.
   ========================================================= */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });
const out = (r) => (r && r.error ? fail(r.error) : text(r));

function buildServer(site) {
  const ops = site.ops;
  const server = new McpServer({ name: `zah-site:${site.id}`, version: '0.3.0' });
  const pageArg = z.string().describe('Page path, e.g. "/" or "/about". See list_pages.');
  const keyArg = z.string().describe('Element key from list_content or get_outline, e.g. "h1:0", "section:2", "n:3f9a1c".');
  const posArg = z.enum(['append', 'prepend', 'before', 'after']).describe('Where, relative to target: inside at the end (append), inside at the start (prepend), or as a sibling (before/after).');
  const pageOr = (p) => { const pg = ops.page(p); return pg || null; };
  const noPage = (p) => fail(`No page "${p}". Pages: ${ops.listPages().map((x) => x.path).join(', ')}`);

  /* ---------- read ---------- */
  server.registerTool('get_site', {
    title: 'About this site', description: 'What this site is, its pages, its settings, and how editing works. Call this first.', inputSchema: {},
  }, async () => text({
    site: site.id, name: site.name, publicUrl: site.publicUrl || null, version: ops.store.read().version,
    pages: ops.listPages(), settings: ops.settingsSchema, usage: ops.assets.usage(), forms: ops.formsInfo(),
    how: [
      'The site as Zah built it is the permanent default. Everything you do is an overlay; reset_page or reset_site puts the build back.',
      'Read before writing: get_outline(page) shows the sections with keys; list_content(page) shows the words, links and images with keys; get_styles shows the CSS so new markup uses the site\'s own classes.',
      'Small changes: set_text, set_link, set_image, set_hidden, set_many. Structure: insert_html, set_html, move, duplicate, remove. New pages: create_page (starts as a copy of an existing page, so it matches). Look: set_css / append_css. Pictures and video: add_asset then set_image or insert_html with the returned url.',
      'Site-wide values like the booking link: get_settings / set_setting. Everything is versioned: history and revert undo anything.',
      'FORMS: the default destination on a ZAH site is ZAH CRM (leads, follow-up, invoicing in one place). Before adding any form, call forms_info and ask the client: would you like this form connected to ZAH CRM? If ZAH CRM is not connected yet, send them to Zah to switch it on; do not try to build anything on the site for it. Their other option is their own outside service via an https action. This server keeps no form data and a form aimed at it is made inert. Storage stops at the quota (get_usage).',
    ],
  }));

  server.registerTool('list_pages', { title: 'List pages', description: 'Every page on the site, built or client-created, and whether it has been changed.', inputSchema: {} },
    async () => text(ops.listPages()));

  server.registerTool('get_outline', {
    title: 'Page outline', description: 'The page\'s structure: header, nav, main, sections, footer and other blocks, each with a key, its class/id, depth and a text preview. Use these keys as targets for insert_html, move, remove, duplicate, set_html.',
    inputSchema: { page: pageArg },
  }, async ({ page }) => { const p = pageOr(page); return p ? text(ops.outline(p)) : noPage(page); });

  server.registerTool('list_content', {
    title: 'List a page\'s content', description: 'Every editable element on a page (headings, paragraphs, list items, links, buttons, images, video): key, tag, text, attributes, and the section it sits in.',
    inputSchema: { page: pageArg },
  }, async ({ page }) => { const p = pageOr(page); return p ? text(ops.list(p).map((e) => ({ key: e.key, tag: e.tag, text: e.text, ...(Object.keys(e.attrs).length ? { attrs: e.attrs } : {}), ...(e.hidden ? { hidden: true } : {}), section: e.section }))) : noPage(page); });

  server.registerTool('get_content', { title: 'Read one element', description: 'One element in full.', inputSchema: { page: pageArg, key: keyArg } },
    async ({ page, key }) => { const p = pageOr(page); if (!p) return noPage(page); const el = ops.find(p, key); return el ? text(el) : fail(`No element "${key}" on ${page}.`); });

  server.registerTool('get_html', {
    title: 'Read HTML', description: 'The HTML of one element (by key) or the whole page body (key "body"). Read a section\'s HTML before rewriting it with set_html, or to copy its pattern for a new section.',
    inputSchema: { page: pageArg, key: z.string().default('body').describe('Element key, or "body" for the whole page body.') },
  }, async ({ page, key }) => { const p = pageOr(page); return p ? out(ops.getHtml(p, key)) : noPage(page); });

  server.registerTool('get_styles', {
    title: 'The site\'s CSS', description: 'The site\'s own stylesheet (classes, variables, colours, fonts) plus the custom CSS added so far. Read this before writing new sections so they use the site\'s classes and look native.', inputSchema: {},
  }, async () => text(ops.getStyles()));

  server.registerTool('forms_info', {
    title: 'Where forms can send', description: 'Call before adding any form. Tells you whether ZAH CRM (the default) is connected on this site, the exact action and field names to use if it is, and what to say to the client if it is not.', inputSchema: {},
  }, async () => text(ops.formsInfo()));

  /* ---------- words, links, images ---------- */
  server.registerTool('set_text', { title: 'Change text', description: 'Replace the words of an element. Icons and child elements inside it are kept. Live immediately.', inputSchema: { page: pageArg, key: keyArg, text: z.string().max(5000).describe('Plain text, no HTML.') } },
    async ({ page, key, text: t }) => { const p = pageOr(page); return p ? out(ops.edit(p, key, { text: t }, 'mcp')) : noPage(page); });

  server.registerTool('set_link', { title: 'Change a link', description: 'Point a link or button somewhere else: https URL, mailto:, tel:, /page or #anchor.', inputSchema: { page: pageArg, key: keyArg, href: z.string().max(2000), target: z.enum(['_self', '_blank']).optional() } },
    async ({ page, key, href, target }) => { const p = pageOr(page); if (!p) return noPage(page); if (!/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(href)) return fail('href must start with https://, http://, mailto:, tel:, # or /'); const attrs = { href }; if (target) attrs.target = target; return out(ops.edit(p, key, { attrs }, 'mcp')); });

  server.registerTool('set_image', { title: 'Change an image or video source', description: 'Swap an image or video for another by URL (an https URL, or an asset url from add_asset / list_assets), and set its alt text.', inputSchema: { page: pageArg, key: keyArg, src: z.string().max(2000), alt: z.string().max(300).optional() } },
    async ({ page, key, src, alt }) => { const p = pageOr(page); if (!p) return noPage(page); if (!/^(https?:\/\/|\/)/i.test(src)) return fail('src must be an https URL or a path starting with /'); const attrs = { src }; if (alt !== undefined) attrs.alt = alt; return out(ops.edit(p, key, { attrs }, 'mcp')); });

  server.registerTool('set_hidden', { title: 'Hide or show', description: 'Hide an element from visitors, or show it again. Nothing is deleted.', inputSchema: { page: pageArg, key: keyArg, hidden: z.boolean() } },
    async ({ page, key, hidden }) => { const p = pageOr(page); return p ? out(ops.edit(p, key, { hidden }, 'mcp')) : noPage(page); });

  server.registerTool('set_many', {
    title: 'Several small edits at once', description: 'A batch of text/link/image/hidden edits on one page in one version.',
    inputSchema: { page: pageArg, edits: z.array(z.object({ key: keyArg, text: z.string().max(5000).optional(), href: z.string().max(2000).optional(), src: z.string().max(2000).optional(), alt: z.string().max(300).optional(), hidden: z.boolean().optional() })).min(1).max(50) },
  }, async ({ page, edits }) => { const p = pageOr(page); return p ? out(ops.editMany(p, edits, 'mcp')) : noPage(page); });

  /* ---------- structure ---------- */
  server.registerTool('insert_html', {
    title: 'Add a section or element', description: 'Insert new HTML into the page: a new section, card, paragraph, image, video embed. Write markup using the site\'s own classes (see get_styles) so it matches. Forms must post to an https service of the client\'s own; embed scripts are allowed. Returns the keys of what was inserted.',
    inputSchema: { page: pageArg, html: z.string().max(400000), position: posArg, target: z.string().default('body').describe('Target key from get_outline, or "body" (append/prepend only).') },
  }, async ({ page, html, position, target }) => { const p = pageOr(page); return p ? out(ops.insertHtml(p, html, position, target, 'mcp')) : noPage(page); });

  server.registerTool('set_html', {
    title: 'Rewrite an element', description: 'Replace an element (a section, a card, a block) with new HTML, or with key "body" replace the whole page body. Read it first with get_html. Forms must post to an https service of the client\'s own.',
    inputSchema: { page: pageArg, key: keyArg, html: z.string().max(400000) },
  }, async ({ page, key, html }) => { const p = pageOr(page); return p ? out(ops.setHtml(p, key, html, 'mcp')) : noPage(page); });

  server.registerTool('move', { title: 'Move an element', description: 'Move a section or element somewhere else on the page.', inputSchema: { page: pageArg, key: keyArg, position: posArg, target: z.string().describe('Target key.') } },
    async ({ page, key, position, target }) => { const p = pageOr(page); return p ? out(ops.move(p, key, position, target, 'mcp')) : noPage(page); });

  server.registerTool('duplicate', { title: 'Duplicate an element', description: 'Copy a section, card or element right after itself. Returns the new key, then edit the copy.', inputSchema: { page: pageArg, key: keyArg } },
    async ({ page, key }) => { const p = pageOr(page); return p ? out(ops.duplicate(p, key, 'mcp')) : noPage(page); });

  server.registerTool('remove', { title: 'Remove an element', description: 'Delete a section, card or element from the page. Reversible with revert. The page\'s <main>, <header> and <footer> themselves cannot be removed; hide or rewrite them instead.', inputSchema: { page: pageArg, key: keyArg } },
    async ({ page, key }) => { const p = pageOr(page); return p ? out(ops.remove(p, key, 'mcp')) : noPage(page); });

  /* ---------- pages ---------- */
  server.registerTool('create_page', {
    title: 'Create a page', description: 'Create a new page at a path like /about or /services/massage. It starts as a copy of an existing page (default: the home page) so the header, footer and look match; pass html to replace the main content. Link to it from the nav with set_link or insert_html.',
    inputSchema: { path: z.string().max(200), title: z.string().max(200), description: z.string().max(300).optional(), from: z.string().optional().describe('Page to copy as the starting point. Default "/".'), html: z.string().max(400000).optional().describe('HTML for the main content area. Omit to keep the copied content and edit it after.') },
  }, async ({ path, title, description, from, html }) => out(ops.createPage(path, { title, description }, from || '/', html, 'mcp')));

  server.registerTool('set_page_meta', { title: 'Page title and description', description: 'Set a page\'s browser title and search description.', inputSchema: { page: pageArg, title: z.string().max(200).optional(), description: z.string().max(300).optional() } },
    async ({ page, title, description }) => { const p = pageOr(page); return p ? out(ops.setPageMeta(p, { title, description }, 'mcp')) : noPage(page); });

  server.registerTool('delete_page', { title: 'Delete a page', description: 'Delete a page the client created. Pages Zah built cannot be deleted, only reset.', inputSchema: { path: z.string() } },
    async ({ path }) => { const p = pageOr(path); return p ? out(ops.deletePage(p, 'mcp')) : noPage(path); });

  /* ---------- style ---------- */
  server.registerTool('set_css', { title: 'Replace custom CSS', description: 'Replace the site-wide custom stylesheet (applied to every page after the site\'s own CSS). Use append_css to add without replacing.', inputSchema: { css: z.string().max(200000) } },
    async ({ css }) => out(ops.setCss(css, 'mcp')));
  server.registerTool('append_css', { title: 'Add custom CSS', description: 'Append rules to the site-wide custom stylesheet.', inputSchema: { css: z.string().max(200000) } },
    async ({ css }) => out(ops.appendCss(css, 'mcp')));

  /* ---------- assets ---------- */
  server.registerTool('list_assets', { title: 'List uploaded files', description: 'Images, video, audio and PDFs uploaded to this site, with their urls, plus storage used and remaining.', inputSchema: {} },
    async () => text({ assets: ops.assets.list(), usage: ops.assets.usage() }));
  server.registerTool('add_asset', {
    title: 'Upload a file', description: 'Add an image, video, audio file or PDF from a URL (best for anything large) or as base64 data (small images). Returns the url to use in set_image or insert_html. Limits: per-file size and a site quota; see get_usage.',
    inputSchema: { name: z.string().max(120).describe('A name for the file, e.g. "team-photo.jpg"'), url: z.string().max(2000).optional().describe('Fetch the file from this https URL'), dataBase64: z.string().optional().describe('Or the file content as base64'), mime: z.string().max(60).optional().describe('e.g. image/jpeg; guessed from the name if omitted') },
  }, async ({ name, url, dataBase64, mime }) => {
    try {
      if (url) return text(await ops.assets.saveFromUrl(url, name));
      if (dataBase64) return text(ops.assets.saveBase64(name, dataBase64, mime));
      return fail('Give either url or dataBase64.');
    } catch (e) { return fail(e.message); }
  });
  server.registerTool('delete_asset', { title: 'Delete a file', description: 'Delete an uploaded file by name (from list_assets). Pages still pointing at it will show a broken image.', inputSchema: { name: z.string().max(200) } },
    async ({ name }) => { try { return text(ops.assets.delete(name)); } catch (e) { return fail(e.message); } });
  server.registerTool('get_usage', { title: 'Storage used', description: 'How much of the site\'s storage quota is used.', inputSchema: {} },
    async () => text(ops.assets.usage()));

  /* ---------- settings ---------- */
  server.registerTool('get_settings', { title: 'Site settings', description: 'Site-wide values the site was built to read (booking link, phone...). Change them with set_setting and every button that uses them follows.', inputSchema: {} },
    async () => { const values = ops.settings(); return text(Object.entries(ops.settingsSchema).map(([key, def]) => ({ key, label: def.label, kind: def.kind, value: values[key], default: def.default }))); });
  server.registerTool('set_setting', { title: 'Change a site setting', description: 'Set one value from get_settings. Empty value resets to the default.', inputSchema: { key: z.string(), value: z.string().max(2000) } },
    async ({ key, value }) => { const r = ops.setSetting(key, value, 'mcp'); return r.error ? fail(r.error) : text({ ok: true, key, value: r.value, ...(r.reset ? { reset: true } : {}), version: ops.store.read().version }); });

  /* ---------- safety ---------- */
  server.registerTool('history', { title: 'Past versions', description: 'Every saved version, newest first. revert restores one.', inputSchema: {} },
    async () => { const cur = ops.store.read(); return text({ current: { version: cur.version, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }, previous: ops.store.history() }); });
  server.registerTool('revert', { title: 'Restore a version', description: 'Put the whole site back to a previous version number from history.', inputSchema: { version: z.number().int().min(1) } },
    async ({ version }) => { try { const s = ops.store.revert(version, 'revert'); return text({ ok: true, nowVersion: s.version, restored: version }); } catch (e) { return fail(e.message); } });
  server.registerTool('reset_page', { title: 'Reset a page to the build', description: 'Drop every change on one page so it serves exactly as Zah built it (a client-created page is deleted). Reversible with revert.', inputSchema: { page: pageArg } },
    async ({ page }) => { const p = pageOr(page); return p ? out(ops.resetPage(p, 'mcp')) : noPage(page); });
  server.registerTool('reset_site', { title: 'Reset the whole site to the build', description: 'Every page back to the build, custom CSS and client pages gone. Assets and settings are kept. Reversible with revert.', inputSchema: { confirm: z.literal(true).describe('Must be true.') } },
    async () => out(ops.resetSite('mcp')));

  return server;
}

async function handleMcp(site, req, res) {
  const server = buildServer(site);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[zah-site] mcp error:', e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

module.exports = { buildServer, handleMcp };
