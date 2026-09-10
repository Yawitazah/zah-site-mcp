/* =========================================================
   ZAH ACCOUNT, asked from a client site

   The client already has one login: the email and password they made at
   zahbrandsolutions.com/account, the one that opens their billing, their
   desk and their Dispatch board. Zah, 2026-09-10: "If they are paying for
   it they should have access without having to create multiple logins."

   So the site asks ZAH Account whether a login is real AND belongs to this
   site, server to server:

     POST <accountUrl>/api/account/site-login  { siteId, email, password }
     -> 200 { ok: true, name, business, plan }
     -> 401 anything else

   Nothing is cached and no password is ever written down here: this file
   asks a question and returns yes or no. If ZAH Account cannot be reached
   the answer is no, and the site's own adminHash still works, so a network
   problem at head office never locks a client out of their own editor.
   ========================================================= */

const DEFAULT_URL = 'https://www.zahbrandsolutions.com';

const base = (url) => String(url || process.env.ACCOUNT_URL || DEFAULT_URL).replace(/\/+$/, '');

/**
 * @returns {Promise<null | { email: string, name: string, business: string, plan: string }>}
 */
async function verifyAccount({ accountUrl, siteId, email, password, timeoutMs = 12000 } = {}) {
  if (!siteId || !email || !password) return null;
  try {
    const r = await fetch(`${base(accountUrl)}/api/account/site-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, email: String(email).trim().toLowerCase(), password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || d.ok !== true) return null;
    return { email: String(d.email || email), name: String(d.name || ''), business: String(d.business || ''), plan: String(d.plan || '') };
  } catch (e) {
    console.warn('[zah-site] ZAH Account could not be reached:', e.message);
    return null;
  }
}

/** Where the client's account, CRM and Dispatch board live. */
const accountLinks = (accountUrl) => {
  const a = base(accountUrl);
  return {
    account: `${a}/account`,
    crm: `${a}/api/account/crm?next=%2F`,
    dispatch: `${a}/api/account/crm?next=%2Fdispatch`,
  };
};

module.exports = { verifyAccount, accountLinks, DEFAULT_URL };
