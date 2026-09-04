# ZAH Site MCP

Lets a client's own AI read and change their ZAH-built website through MCP,
and gives Zah Editor a real **Publish** so edits reach every visitor.

**Do not rebuild this per site. Install it and mount it.** If the contract
below does not fit a site, extend it here so every site gets the change.

## Install

```bash
npm i github:Yawitazah/zah-site-mcp
```

## Mount (the whole integration)

```js
const path = require('path');
const zahSite = require('zah-site-mcp');

zahSite.mount(app, {
  siteId: 'new-vision',                              // matches SITE_ID / ZAH Gate
  name: 'New Vision Therapy & Wellness',
  dataDir: process.env.DATA_DIR || '/data',          // a Railway volume
  token: process.env.SITE_MCP_TOKEN,                 // the client's AI presents this
  adminHash: process.env.EDITOR_ADMIN_HASH,          // Zah Editor's sha256(email:password)
  publicUrl: process.env.PUBLIC_URL,
  pages: [
    { path: '/', file: path.join(__dirname, 'index.html'), root: 'main' },
  ],
});
// ...then express.static and the 404 handler, AFTER this.
```

Rules:

- Mount **before** `express.static`. It serves the listed pages itself.
- `root` is the selector Zah Editor edits (usually `main`). Only content inside
  it is reachable.
- Each page needs a `file` on disk. The file stays the design source of truth;
  edits are an overlay on top of it, so a redeploy never loses a client's edits
  and a client's edits never block a redeploy.

On the page, after `zah-editor.js`:

```html
<script src="/zah-site/publish.js"></script>
```

That is what makes the editor's **Save** publish to the server. Without it the
editor still works, but only in the one browser.

## What it owns

| Thing | Where |
|---|---|
| Routes | `/zah-site/*` (MCP at `/zah-site/mcp`, REST beside it) |
| Data | `<dataDir>/zah-site/overlay.json` + `history/` (every previous version) |
| Assets | `/zah-site/publish.js` |
| Styling | none. It renders no UI. |

## Environment

| Variable | Required | What |
|---|---|---|
| `SITE_MCP_TOKEN` | for MCP + publish | The site's own token. Generate: `python -c "import secrets;print('zs_'+secrets.token_hex(24))"`. Revoke by changing it. Never Zah's CRM key, never a Stripe key. |
| `DATA_DIR` | yes on Railway | Mount a volume at `/data` and set this to `/data`, or edits vanish on redeploy |
| `EDITOR_ADMIN_HASH` | for publish | `sha256(email.lower():password)`, the same hash the page's `ZAH_EDITOR_CFG` carries |

Without a token: pages serve, everything under `/zah-site/*` refuses (503).
Without a volume: edits survive until the next deploy. Say so in the handoff.

## Connect a client's AI

Give the client this, nothing else:

**Claude Desktop / Claude Code** (`claude mcp add`):

```bash
claude mcp add --transport http new-vision-site https://YOUR-SITE/zah-site/mcp --header "Authorization: Bearer zs_..."
```

**claude.ai custom connector** (cannot set headers), use the keyed URL:

```
https://YOUR-SITE/zah-site/mcp/k/zs_...
```

Then: *"List the content on my homepage and change the hero headline to ..."*

## The tools

| Tool | Does |
|---|---|
| `get_site` | id, pages, how editing works. Call first. |
| `list_content(page)` | every editable element with a stable key, its text, links, images |
| `get_content(page, key)` | one element |
| `set_text(page, key, text)` | change words. Icons and child elements inside are kept |
| `set_link(page, key, href, target?)` | change where a button or link goes |
| `set_image(page, key, src, alt?)` | swap an image by URL |
| `set_hidden(page, key, hidden)` | hide or show, nothing deleted |
| `set_many(page, edits[])` | a batch, one version |
| `history()` / `revert(version)` | every version is kept; any can be restored |
| `reset_page(page)` | drop every edit, serve the file as built |

Deliberately **not** provided: adding or removing elements, changing styles,
uploading files. Positional keys stay stable because structure never changes
through the MCP, and the layout the client paid for cannot be wrecked by a
prompt. Structure changes are a Zah Editor publish or a source change.

## Keys

Elements matching `h1 h2 h3 h4 p li blockquote figcaption a.btn a.button img`
inside the root get keys in document order: `h1:0`, `p:12`, `img:0`. An element
that already has `data-zs="hero.title"` keeps that name, so name the things
that matter in the source. Override the list per page with `editable: [...]`.

## Order of application

1. Zah Editor snapshot for the page (whole root), if one was published
2. Keys assigned
3. MCP edits on top

A new snapshot clears that page's MCP edits: the editor's author has just seen
the page as they want it. Every state before every write is in history.

## Failure modes already met

- **Editor Save said "Saved here only".** The bridge has no token: the page's
  admin hash does not match `EDITOR_ADMIN_HASH`, or `SITE_MCP_TOKEN` is unset.
- **A client's edit disappeared after a deploy.** No volume. Set `DATA_DIR` to
  a mounted path.
- **Keys shifted.** Someone changed the page structure in source. Old edits
  still apply to whatever now holds the old key; `reset_page` and redo, or
  name the elements with `data-zs` so keys stop being positional.
- **claude.ai says it cannot connect.** It cannot send headers; use the
  `/mcp/k/<token>` URL.

## Test

```bash
npm test
```

Mounts a fixture, drives it with a real MCP client, checks the visitor sees
each change, and that a wrong token cannot connect.
