/* =========================================================
   ZAH SITE MCP, assets

   The client's images, video, PDFs. Files on the volume under
   <dataDir>/zah-site/assets/, served at /zah-site/assets/<name>, cached
   hard because a replaced file gets a new name.

   Limits are the product's promise to Zah: a per-file cap, a per-site
   quota, and only media types. Nothing executable, nothing that is a
   "system". Both caps are configurable per site.
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
};
const EXT_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));
EXT_TO_TYPE.jpeg = 'image/jpeg';

const MB = 1024 * 1024;

class Assets {
  constructor(store, { maxFileMb = 30, quotaMb = 250 } = {}) {
    this.store = store;
    this.dir = store.assetsDir;
    this.maxFile = maxFileMb * MB;
    this.quota = quotaMb * MB;
  }

  ensure() { fs.mkdirSync(this.dir, { recursive: true }); }

  list() {
    this.ensure();
    return fs.readdirSync(this.dir).filter((f) => !f.startsWith('.')).map((f) => {
      const st = fs.statSync(path.join(this.dir, f));
      return { name: f, url: `/zah-site/assets/${f}`, bytes: st.size, type: EXT_TO_TYPE[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream', modified: st.mtime.toISOString() };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  usage() {
    const used = this.store.usageBytes();
    return { usedBytes: used, usedMb: Math.round(used / MB * 10) / 10, quotaMb: this.quota / MB, maxFileMb: this.maxFile / MB, remainingMb: Math.max(0, Math.round((this.quota - used) / MB * 10) / 10) };
  }

  safeName(name, ext) {
    const base = String(name || 'file').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
    const stamp = crypto.randomBytes(3).toString('hex');
    return `${base}-${stamp}.${ext}`;
  }

  /** Save bytes. Returns the listing entry. Throws with a plain-English reason. */
  save(name, buffer, mime) {
    this.ensure();
    const ext = TYPES[mime];
    if (!ext) throw new Error(`Type ${mime || 'unknown'} is not allowed. Images, video, audio and PDF only.`);
    if (buffer.length > this.maxFile) throw new Error(`That file is ${Math.round(buffer.length / MB)}MB; the limit per file is ${this.maxFile / MB}MB.`);
    const used = this.store.usageBytes();
    if (used + buffer.length > this.quota) throw new Error(`Not enough space: ${Math.round((this.quota - used) / MB)}MB left of ${this.quota / MB}MB. Delete something first (list_assets, delete_asset).`);
    const file = this.safeName(name, ext);
    fs.writeFileSync(path.join(this.dir, file), buffer);
    const st = fs.statSync(path.join(this.dir, file));
    return { name: file, url: `/zah-site/assets/${file}`, bytes: st.size, type: mime };
  }

  async saveFromUrl(url, name) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('That is not a valid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched.');
    const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'zah-site-mcp' } });
    if (!res.ok) throw new Error(`Could not fetch that URL (HTTP ${res.status}).`);
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > this.maxFile) throw new Error(`That file is ${Math.round(len / MB)}MB; the limit per file is ${this.maxFile / MB}MB.`);
    const buf = Buffer.from(await res.arrayBuffer());
    return this.save(name || path.basename(u.pathname), buf, mime || guessMime(u.pathname));
  }

  saveBase64(name, dataBase64, mime) {
    const clean = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length) throw new Error('No file data received.');
    return this.save(name, buf, mime || guessMime(name));
  }

  delete(name) {
    const file = path.basename(String(name || ''));
    const p = path.join(this.dir, file);
    if (!file || !fs.existsSync(p)) throw new Error(`No asset named "${file}". Use list_assets.`);
    fs.unlinkSync(p);
    return { ok: true, deleted: file };
  }

  resolve(name) {
    const file = path.basename(String(name || ''));
    const p = path.join(this.dir, file);
    return fs.existsSync(p) ? p : null;
  }
}

function guessMime(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return EXT_TO_TYPE[ext] || '';
}

module.exports = { Assets, TYPES };
