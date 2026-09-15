// A normal text/link/style save is a keyed patch, so a source deploy can
// update the rest of the page. Structural changes retain the snapshot model.
const R = require('./render');

function editorPatch(baseHtml, html, ctx) {
  const before = R.load(`<body>${baseHtml}</body>`);
  const after = R.load(`<body>${html}</body>`);
  const edits = {};
  let structural = false;
  const seen = new Set();
  const allowed = new Set([...R.ATTR_WHITELIST, 'style', 'hidden']);
  function walk(a, b, owner) {
    if (!a || !b || a.type !== b.type || a.name !== b.name) { structural = true; return; }
    if (a.type === 'text') {
      if (a.data !== b.data) {
        if (!owner) { structural = true; return; }
        edits[owner] = { ...(edits[owner] || {}), html: R.sanitize(after(`[data-zs="${R.cssEscape(owner)}"]`).first().html(), ctx) };
      }
      return;
    }
    if (!a.attribs) return;
    const key = a.attribs['data-zs'];
    if (key !== b.attribs['data-zs'] || (key && seen.has(key))) { structural = true; return; }
    if (key) seen.add(key);
    for (const attr of new Set([...Object.keys(a.attribs), ...Object.keys(b.attribs)])) {
      if (a.attribs[attr] === b.attribs[attr]) continue;
      if (!key || !allowed.has(attr)) { structural = true; continue; }
      const edit = edits[key] || (edits[key] = {});
      if (attr === 'hidden') edit.hidden = b.attribs.hidden !== undefined;
      else {
        const clean = R.load(R.sanitize(after.html(b), ctx))('[data-zs]').first().attr(attr);
        (edit.attrs || (edit.attrs = {}))[attr] = clean === undefined ? null : clean;
      }
    }
    const ac = a.children || [], bc = b.children || [];
    if (ac.length !== bc.length) {
      // Rich text formatting inside one content element is still a patch.
      if (key && !before(a).find('[data-zs]').length && !after(b).find('[data-zs]').length) {
        edits[key] = { ...(edits[key] || {}), html: R.sanitize(after(b).html(), ctx) };
      } else structural = true;
      return;
    }
    ac.forEach((child, i) => walk(child, bc[i], key || owner));
  }
  walk(before('body')[0], after('body')[0], null);
  // An ancestor's HTML already contains descendant edits.
  for (const key of Object.keys(edits)) {
    if (after(`[data-zs="${R.cssEscape(key)}"]`).parents('[data-zs]').toArray().some(el => edits[el.attribs['data-zs']]?.html !== undefined)) delete edits[key];
  }
  return structural ? null : edits;
}

module.exports = { editorPatch };
