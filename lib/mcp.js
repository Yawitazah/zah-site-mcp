/* =========================================================
   ZAH SITE MCP, the MCP server

   Streamable HTTP, stateless: every request gets a fresh McpServer bound to
   the same store, so there is no session table to leak or expire. The tools
   are the whole contract a client's AI gets:

     get_site       what this site is and which pages it has
     list_content   every editable element on a page, with its key and text
     get_content    one element in full
     set_text       change an element's words (child elements are kept)
     set_link       change where a button or link goes
     set_image      change an image's src and alt
     set_hidden     hide or show an element
     set_many       several edits in one call
     get_settings   site-wide values the host declared (booking link, phone...)
     set_setting    change one; every button and product reading it follows
     history        past versions
     revert         restore a past version
     reset_page     drop every edit on a page and serve the file as built

   Nothing here adds or removes elements. That is deliberate: positional
   keys stay stable, the layout the client paid for cannot be wrecked by a
   prompt, and "make the hero say X" is 95% of what a client wants anyway.
   ========================================================= */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

/** @param {import('../index').Site} site */
function buildServer(site) {
  const server = new McpServer({ name: `zah-site:${site.id}`, version: '0.1.0' });
  const pageArg = z.string().describe('Page path, e.g. "/". See get_site for the list.');
  const keyArg = z.string().describe('Element key from list_content, e.g. "h1:0" or "p:4".');

  server.registerTool('get_site', {
    title: 'About this site',
    description: 'The site id, its pages, and how editing works. Call this first.',
    inputSchema: {},
  }, async () => text({
    site: site.id,
    name: site.name,
    pages: site.pages.map((p) => ({ path: p.path, root: p.root })),
    publicUrl: site.publicUrl || null,
    version: site.store.read().version,
    settings: site.settingsSchema,
    how: 'Call list_content(page) to see every editable element with a key. Change words with set_text, buttons and links with set_link, pictures with set_image. Site-wide values like the booking link live in get_settings/set_setting: change one there and every button that uses it follows. Edits go live for every visitor immediately. history and revert undo anything.',
  }));

  server.registerTool('get_settings', {
    title: 'Site settings',
    description: 'Site-wide values the site was built to read: for example where "Book" buttons go, or the contact phone. Change them with set_setting.',
    inputSchema: {},
  }, async () => {
    const values = site.settings();
    return text(Object.entries(site.settingsSchema).map(([key, def]) => ({ key, label: def.label, kind: def.kind, value: values[key], default: def.default })));
  });

  server.registerTool('set_setting', {
    title: 'Change a site setting',
    description: 'Set one site-wide value from get_settings, e.g. set_setting("bookingUrl", "https://..."). Every button, note and page that reads it changes at once. Send an empty value to go back to the default.',
    inputSchema: { key: z.string().describe('A key from get_settings'), value: z.string().max(2000).describe('The new value, or "" to reset') },
  }, async ({ key, value }) => {
    const r = site.setSetting(key, value, 'mcp');
    if (r.error) return fail(r.error);
    return text({ ok: true, key, value: r.value, ...(r.reset ? { reset: true } : {}), version: site.store.read().version });
  });

  server.registerTool('list_content', {
    title: 'List a page\'s content',
    description: 'Every editable element on a page: key, tag, current text, and link/image attributes. Keys are stable.',
    inputSchema: { page: pageArg },
  }, async ({ page }) => {
    const p = site.page(page);
    if (!p) return fail(`No page "${page}". Pages: ${site.pages.map((x) => x.path).join(', ')}`);
    return text(site.list(p).map((e) => ({ key: e.key, tag: e.tag, text: e.text, ...(Object.keys(e.attrs).length ? { attrs: e.attrs } : {}), ...(e.hidden ? { hidden: true } : {}) })));
  });

  server.registerTool('get_content', {
    title: 'Read one element',
    description: 'One element in full: its text, attributes and hidden state.',
    inputSchema: { page: pageArg, key: keyArg },
  }, async ({ page, key }) => {
    const p = site.page(page);
    if (!p) return fail(`No page "${page}".`);
    const el = site.list(p).find((e) => e.key === key);
    return el ? text(el) : fail(`No element "${key}" on ${page}. Use list_content.`);
  });

  server.registerTool('set_text', {
    title: 'Change text',
    description: 'Replace the words of an element. Icons and child elements inside it are kept. Live immediately.',
    inputSchema: { page: pageArg, key: keyArg, text: z.string().max(5000).describe('The new text, plain (no HTML).') },
  }, async ({ page, key, text: t }) => applyOne(site, page, key, { text: t }));

  server.registerTool('set_link', {
    title: 'Change a link',
    description: 'Point a button or link somewhere else. Accepts https URLs, mailto:, tel:, or #anchors.',
    inputSchema: { page: pageArg, key: keyArg, href: z.string().max(2000), target: z.enum(['_self', '_blank']).optional() },
  }, async ({ page, key, href, target }) => {
    if (!/^(https?:\/\/|mailto:|tel:|#|\/)/i.test(href)) return fail('href must start with https://, http://, mailto:, tel:, # or /');
    const attrs = { href };
    if (target) attrs.target = target;
    return applyOne(site, page, key, { attrs });
  });

  server.registerTool('set_image', {
    title: 'Change an image',
    description: 'Swap an image for another by URL, and set its alt text.',
    inputSchema: { page: pageArg, key: keyArg, src: z.string().max(2000).describe('Image URL (https) or a path on this site like /assets/img/new.jpg'), alt: z.string().max(300).optional() },
  }, async ({ page, key, src, alt }) => {
    if (!/^(https?:\/\/|\/)/i.test(src)) return fail('src must be an https URL or a path starting with /');
    const attrs = { src };
    if (alt !== undefined) attrs.alt = alt;
    return applyOne(site, page, key, { attrs });
  });

  server.registerTool('set_hidden', {
    title: 'Hide or show an element',
    description: 'Hide an element from visitors, or show it again. Nothing is deleted.',
    inputSchema: { page: pageArg, key: keyArg, hidden: z.boolean() },
  }, async ({ page, key, hidden }) => applyOne(site, page, key, { hidden }));

  server.registerTool('set_many', {
    title: 'Several edits at once',
    description: 'Apply a batch of edits to one page in one version.',
    inputSchema: {
      page: pageArg,
      edits: z.array(z.object({
        key: keyArg,
        text: z.string().max(5000).optional(),
        href: z.string().max(2000).optional(),
        src: z.string().max(2000).optional(),
        alt: z.string().max(300).optional(),
        hidden: z.boolean().optional(),
      })).min(1).max(50),
    },
  }, async ({ page, edits }) => {
    const p = site.page(page);
    if (!p) return fail(`No page "${page}".`);
    const known = new Set(site.list(p).map((e) => e.key));
    const batch = {};
    for (const e of edits) {
      if (!known.has(e.key)) return fail(`No element "${e.key}" on ${page}. Nothing was changed.`);
      const edit = {};
      if (e.text !== undefined) edit.text = e.text;
      const attrs = {};
      if (e.href !== undefined) attrs.href = e.href;
      if (e.src !== undefined) attrs.src = e.src;
      if (e.alt !== undefined) attrs.alt = e.alt;
      if (Object.keys(attrs).length) edit.attrs = attrs;
      if (e.hidden !== undefined) edit.hidden = e.hidden;
      batch[e.key] = edit;
    }
    const state = site.store.applyEdits(p.path, batch, 'mcp');
    return text({ ok: true, version: state.version, changed: Object.keys(batch) });
  });

  server.registerTool('history', {
    title: 'Past versions',
    description: 'Every saved version of the site content, newest first. Use revert to go back.',
    inputSchema: {},
  }, async () => {
    const cur = site.store.read();
    return text({ current: { version: cur.version, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy }, previous: site.store.history() });
  });

  server.registerTool('revert', {
    title: 'Restore a version',
    description: 'Put the whole site back to a previous version number from history. The current state is kept in history too.',
    inputSchema: { version: z.number().int().min(1) },
  }, async ({ version }) => {
    try {
      const state = site.store.revert(version, 'revert');
      return text({ ok: true, nowVersion: state.version, restored: version });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool('reset_page', {
    title: 'Reset a page',
    description: 'Remove every edit on a page so it serves exactly as built. Reversible with revert.',
    inputSchema: { page: pageArg },
  }, async ({ page }) => {
    const p = site.page(page);
    if (!p) return fail(`No page "${page}".`);
    const state = site.store.clearPage(p.path, 'mcp');
    return text({ ok: true, version: state.version });
  });

  return server;
}

function applyOne(site, page, key, edit) {
  const p = site.page(page);
  if (!p) return fail(`No page "${page}". Pages: ${site.pages.map((x) => x.path).join(', ')}`);
  const el = site.list(p).find((e) => e.key === key);
  if (!el) return fail(`No element "${key}" on ${page}. Use list_content to see the keys.`);
  if (edit.attrs && edit.attrs.href !== undefined && el.tag !== 'a') return fail(`"${key}" is a <${el.tag}>, not a link.`);
  if (edit.attrs && edit.attrs.src !== undefined && el.tag !== 'img') return fail(`"${key}" is a <${el.tag}>, not an image.`);
  const state = site.store.applyEdits(p.path, { [key]: edit }, 'mcp');
  const after = site.list(p).find((e) => e.key === key);
  return text({ ok: true, version: state.version, element: after });
}

/** Express handler for the MCP endpoint. Auth has already happened. */
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
