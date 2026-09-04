# ZAH Site MCP

Lets a client's own AI read and **build on** their ZAH-built website through
MCP, and gives Zah Editor a real **Publish** so edits reach every visitor.

**Do not rebuild this per site. Install it and mount it.** If the contract
below does not fit a site, extend it here so every site gets the change.

## The model, in one paragraph

The files Zah shipped are the permanent default. Everything the client's AI
does is an overlay on a Railway volume: new pages, new sections, layout, CSS,
images, video, embeds and forms. `reset_page` and `reset_site` put the build
back at any time; every write is versioned and `revert` restores any version.
**Forms go to ZAH CRM by default.** The host declares its lead seam
(`crm: { leadPath: '/api/lead', enabled }`); when Zah has switched the CRM on,
a form with that action sends every submission to the client's CRM as a lead.
When it is not on, the form is kept but inert and the AI is told to ask the
client "would you like this form connected to ZAH CRM?" and send them to Zah.
The client's other option is their own outside service (Formspree, Google
Forms, Airtable) via an https action. This server keeps no form data and
nothing can be built on it through the MCP. Storage stops at a quota.

## Install

```bash
npm i github:Yawitazah/zah-site-mcp
```

Alpine images need git for that: `RUN apk add --no-cache git` in the Dockerfile.

## Mount (the whole integration)

```js
const path = require('path');
const zahSite = require('zah-site-mcp');

const site = zahSite.mount(app, {
  siteId: 'new-vision',                              // matches SITE_ID / ZAH Gate
  name: 'New Vision Therapy & Wellness',
  dataDir: process.env.DATA_DIR || '/data',          // a Railway volume
  token: process.env.SITE_MCP_TOKEN,                 // the client's AI presents this
  adminHash: process.env.EDITOR_ADMIN_HASH,          // Zah Editor's sha256(email:password)
  publicUrl: process.env.PUBLIC_URL,
  pages: [
    { path: '/', file: path.join(__dirname, 'index.html'), root: 'main' },
  ],
  settings: {                                        // values the client may change
    bookingUrl: { label: 'Where "Book" buttons go', kind: 'url',   default: process.env.BOOKING_URL },
    phone:      { label: 'Contact phone',           kind: 'phone', default: process.env.CONTACT_PHONE },
  },
  quotaMb: 250, maxFileMb: 30,                       // the client's storage
  crm: { leadPath: '/api/lead', enabled: () => crm.leadsEnabled() },   // the ZAH CRM door for forms
});
// ...then ZAH Pay (reads site.settings()), express.static and the 404 handler.
```

Rules:

- Mount **before** `express.static` and before any product that reads
  `site.settings()`. It serves the listed pages and every client-created page.
- The first page in `pages` is the **template**: client-created pages take its
  head, CSS, header, footer and chrome.
- `root` is the selector Zah Editor edits (usually `main`). The MCP edits the
  whole body: header, nav, main, footer.
- Each page needs a `file` on disk. Redeploying new source changes a page that
  has NOT been restructured; a restructured page keeps its snapshot until
  `reset_page`. Say so in the handoff.

On the page, after `zah-editor.js`:

```html
<script src="/zah-site/publish.js"></script>
```

## What it owns

| Thing | Where |
|---|---|
| Routes | `/zah-site/*`: MCP at `/zah-site/mcp`, assets at `/zah-site/assets/<name>`, REST beside them |
| Pages | the configured ones, plus any path the client created |
| Data | `<dataDir>/zah-site/overlay.json`, `history/` (last 200 versions), `assets/` |
| Styling | none of its own. Custom CSS the client adds is injected as `<style id="zs-custom">` |
| Chrome | `<script>`s and product UI from the file (`#edToggle`, `#edBar`, `.zp-modal`, `[data-zs-chrome]`) are never in a snapshot and never lost |

## Environment

| Variable | Required | What |
|---|---|---|
| `SITE_MCP_TOKEN` | for MCP + publish | The site's own token. Generate: `python -c "import secrets;print('zs_'+secrets.token_hex(24))"`. Rotate to revoke. Never Zah's CRM key, never a Stripe key. |
| `DATA_DIR` | yes on Railway | Mount a volume at `/data` and set this to `/data`, or edits and uploads vanish on redeploy |
| `EDITOR_ADMIN_HASH` | for publish | `sha256(email.lower():password)`, the same hash the page's `ZAH_EDITOR_CFG` carries |

Without a token: pages serve, everything under `/zah-site/*` refuses (503).

## Connect a client's AI

```bash
claude mcp add --transport http my-site https://YOUR-SITE/zah-site/mcp --header "Authorization: Bearer zs_..."
```

claude.ai custom connectors cannot set headers; use the keyed URL:
`https://YOUR-SITE/zah-site/mcp/k/zs_...`

## The tools

| Read | |
|---|---|
| `get_site` | id, pages, settings, usage, and how editing works. Call first. |
| `list_pages` | every page, built or client-created |
| `get_outline(page)` | header, nav, main, sections, footer, blocks: keys, classes, depth |
| `list_content(page)` | every heading, paragraph, item, link, button, image, video with a key |
| `get_content(page, key)` / `get_html(page, key)` | one element; its HTML, or the whole body |
| `get_styles` | the site's CSS plus custom CSS, so new markup looks native |
| `forms_info` | is ZAH CRM connected, the action and fields to use, what to tell the client if not |

| Words, links, images | |
|---|---|
| `set_text` `set_link` `set_image` `set_hidden` `set_many` | small edits; child elements (icons) kept |

| Structure | |
|---|---|
| `insert_html(page, html, position, target)` | a new section, card, image, embed, form |
| `set_html(page, key, html)` | rewrite an element, or the whole body |
| `move` `duplicate` `remove` | `<main>`, `<header>`, `<footer>` cannot be removed |

| Pages, style, files | |
|---|---|
| `create_page(path, title, description?, from?, html?)` | starts as a copy of `from` (default `/`) so it matches |
| `set_page_meta` `delete_page` | delete only client-created pages |
| `set_css` `append_css` | the site-wide custom stylesheet |
| `add_asset(name, url \| dataBase64)` `list_assets` `delete_asset` `get_usage` | images, video, audio, PDF; per-file cap and site quota |

| Settings and safety | |
|---|---|
| `get_settings` `set_setting` | values the host declared (booking link, phone). Empty resets to default |
| `history` `revert(version)` | every version kept |
| `reset_page(page)` `reset_site(confirm)` | back to the build; assets and settings survive `reset_site` |

## Keys

Every editable element (`h1 h2 h3 h4 h5 p li blockquote figcaption a button
img video label`) and structural block (`header nav main section article
aside footer figure ul ol table`, and `div` with an id or class) inside
`<body>` gets a `data-zs` key. Untouched pages use positional keys (`h2:3`,
`section:1`). Once a page has been restructured ("materialised"), keys are
baked into its markup and new nodes get random keys (`n:3f9a1c`), so later
insertions never shift anything. An element that already carries
`data-zs="hero.title"` keeps that name.

## Order of application

1. snapshot (the page as the client restructured it) or the file's body
2. chrome from the file re-attached
3. keys
4. small keyed edits
5. custom CSS

A Zah Editor publish replaces only the editor's root (`main`) inside that
model, so header and footer edits made by the AI survive an editor save.

## What the sanitiser does

Allowed: any HTML, inline styles, `<style>`, external and inline `<script>`
(embeds, widgets), `<iframe>` from https, `<form>` posting to the ZAH CRM lead
path (when connected) or to an https address that is not this site. Refused:
`javascript:` URLs, `on*` handler attributes, `srcdoc`,
`object/embed/applet/base/meta`. Any other `<form>` is kept visible but made
inert with a note in `data-zs-inert` saying why. Every structural result lists
the forms it contained with a `status` (`zah-crm`, `zah-crm-off`, `external`,
`inert`) and a `note` for the client.

## Failure modes already met

- **"Saved here only" in the editor.** No token reached the bridge: the page's
  admin hash does not match `EDITOR_ADMIN_HASH`, or `SITE_MCP_TOKEN` is unset.
- **Edits vanished after a deploy.** No volume. Set `DATA_DIR` to a mounted path.
- **Zah's source change is not showing on a page.** That page is materialised;
  the client restructured it. `reset_page` shows the new build (their changes
  go to history and can be reverted, or redone).
- **claude.ai cannot connect.** It cannot send headers; use `/mcp/k/<token>`.
- **Video upload fails.** Base64 through MCP is limited to a few MB; give
  `add_asset` a URL instead (Google Drive direct link, Dropbox `?dl=1`), or
  embed from YouTube/Vimeo.

## Test

```bash
npm test
```

Fifty checks: keys, keyed edits, structure, pages, CSS, assets and quota,
forms policy, settings, editor snapshot, chrome survival, history, resets,
auth.
