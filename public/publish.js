/* =========================================================
   ZAH SITE MCP, Zah Editor bridge

   Loaded AFTER zah-editor.js. Turns the editor's Save into a real publish:
   the edited root goes to the server and every visitor sees it. Until this
   existed, Save wrote to localStorage and the client's own browser was the
   only place the change lived.

   How it works, with no changes to the editor engine:
     - the editor logs in with email + password against a hash; this bridge
       sends the same pair to /zah-site/login and keeps the site token in
       sessionStorage for the tab
     - a click on #edSave also posts a cleaned copy of the root's innerHTML
       to /zah-site/snapshot
     - a click on #edReset also clears the server copy, and the page reloads
       to the file as built

   The editor's own login prompts are wrapped, not replaced, so the flow the
   client knows (pencil, email, password) is unchanged.
   ========================================================= */
(function () {
  "use strict";
  var CFG = window.ZAH_EDITOR_CFG || {};
  var rootSel = CFG.root || "main";
  var keyName = (CFG.storageKey || "zah-page") + ":site-token";
  var page = location.pathname.replace(/\/$/, "") || "/";
  var status = document.getElementById("edStatus");

  function tokenGet() { try { return sessionStorage.getItem(keyName) || ""; } catch (e) { return ""; } }
  function tokenSet(t) { try { sessionStorage.setItem(keyName, t); } catch (e) {} }

  // Wrap window.prompt for the editor's login so the same answers reach the
  // server. The editor asks "Admin email" then "Admin password".
  var origPrompt = window.prompt;
  var pending = {};
  window.prompt = function (msg, def) {
    var v = origPrompt.call(window, msg, def);
    if (/admin email/i.test(msg || "")) pending.email = v;
    if (/admin password/i.test(msg || "")) {
      pending.password = v;
      if (pending.email && v) login(pending.email, v);
    }
    return v;
  };

  function login(email, password) {
    fetch("/zah-site/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.token) { tokenSet(d.token); note("Publishing on"); }
    }).catch(function () {});
  }

  function note(t) { if (status) { var was = status.textContent; status.textContent = t; setTimeout(function () { if (status.textContent === t) status.textContent = was; }, 2200); } }

  function cleanRootHtml() {
    var root = document.querySelector(rootSel);
    if (!root) return "";
    var clone = root.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach(function (e) { e.removeAttribute("contenteditable"); });
    clone.querySelectorAll("[data-ed]").forEach(function (e) { e.removeAttribute("data-ed"); });
    clone.querySelectorAll(".ed-sel, .ed-hov").forEach(function (e) { e.classList.remove("ed-sel", "ed-hov"); });
    return clone.innerHTML;
  }

  function publish() {
    var t = tokenGet();
    if (!t) { note("Saved here only"); return; }
    fetch("/zah-site/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
      body: JSON.stringify({ page: page, html: cleanRootHtml() })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          note("Published v" + res.d.version);
          // The server copy is now the truth; the local copy would shadow
          // the next MCP edit on this browser, so drop it.
          try { localStorage.removeItem(CFG.storageKey); } catch (e) {}
        } else note((res.d && res.d.error) || "Publish failed");
      })
      .catch(function () { note("Publish failed"); });
  }

  function reset() {
    var t = tokenGet();
    if (!t) return;
    fetch("/zah-site/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
      body: JSON.stringify({ page: page })
    }).catch(function () {});
  }

  var save = document.getElementById("edSave");
  var rst = document.getElementById("edReset");
  if (save) save.addEventListener("click", function () { setTimeout(publish, 0); });
  // The editor's Reset confirms, then reloads. Capture phase runs before its
  // handler; the request is fire-and-forget and the reload follows.
  if (rst) rst.addEventListener("click", function () { reset(); }, true);
})();
