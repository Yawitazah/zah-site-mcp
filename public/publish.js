/* ZAH Editor publishing: server-confirmed saves, revision checks and keyed patches. */
(function () {
  "use strict";
  var CFG = window.ZAH_EDITOR_CFG || {};
  var rootSel = CFG.root || "main";
  var keyName = (CFG.storageKey || "zah-page") + ":site-token";
  var page = location.pathname.replace(/\/$/, "") || "/";
  var status = document.getElementById("edStatus");
  var save = document.getElementById("edSave");
  var versionMeta = document.querySelector('meta[name="zah-site-version"]');
  var sourceMeta = document.querySelector('meta[name="zah-site-source"]');
  var version = versionMeta ? Number(versionMeta.content) : undefined;
  var sourceHash = sourceMeta ? sourceMeta.content : undefined;
  var busy = false, baseHtml = null;
  window.ZAH_SITE_PUBLISH = true;
  function tokenGet() { try { return sessionStorage.getItem(keyName) || ""; } catch (e) { return ""; } }
  function tokenSet(t) { try { sessionStorage.setItem(keyName, t); } catch (e) {} }
  function note(t) { if (status) { status.textContent = t; status.setAttribute("role", "status"); } }
  function cleanRootHtml() {
    var root = document.querySelector(rootSel);
    if (!root) return "";
    var clone = root.cloneNode(true);
    clone.querySelectorAll('script:not([data-zs-keep]), noscript:not([data-zs-keep]), #edToggle, #edBar, #edBubble, #edEl, [data-zs-chrome]').forEach(function (e) { e.remove(); });
    clone.querySelectorAll("[contenteditable], [data-ed]").forEach(function (e) { e.removeAttribute("contenteditable"); e.removeAttribute("data-ed"); });
    clone.querySelectorAll(".ed-sel, .ed-hov").forEach(function (e) { e.classList.remove("ed-sel", "ed-hov"); });
    // Hosts may declare animation/scroll state that is not editable content.
    clone.querySelectorAll("[class], [style]").forEach(function (e) {
      (CFG.transientClasses || []).forEach(function (name) { e.classList.remove(name); });
      (CFG.transientStyles || []).forEach(function (name) { e.style.removeProperty(name); });
      if (e.hasAttribute("style") && !e.getAttribute("style").trim()) e.removeAttribute("style");
    });
    return clone.innerHTML;
  }
  document.addEventListener("zah-editor:before-edit", function () { if (baseHtml === null) baseHtml = cleanRootHtml(); });
  document.addEventListener("zah-editor:login", function (e) {
    var d = e.detail || {};
    if (d.data && d.data.token) { tokenSet(d.data.token); note("Publishing on"); }
    else note("Not connected — changes cannot publish");
  });
  async function post(path, body) {
    var t = tokenGet();
    if (!t) throw new Error("Not published. Sign in again to connect publishing.");
    var r = await fetch("/zah-site/" + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify(body) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || "Publish failed. Try again.");
    return d;
  }
  async function publish() {
    if (busy) return;
    busy = true; if (save) save.disabled = true;
    var html = cleanRootHtml();
    note("Publishing…");
    try {
      var d = await post("snapshot", { page: page, root: rootSel, html: html, baseHtml: baseHtml === null ? undefined : baseHtml, baseVersion: version, sourceHash: sourceHash });
      version = d.version; baseHtml = html;
      try { localStorage.removeItem(CFG.storageKey); } catch (e) {}
      document.dispatchEvent(new CustomEvent("zah-editor:published"));
      note("Published v" + d.version);
    } catch (e) { note(e.message || "Not published. Check your connection and try again."); }
    finally { busy = false; if (save) save.disabled = false; }
  }
  async function reset() {
    if (busy) return;
    busy = true;
    try {
      await post("reset", { page: page, baseVersion: version });
      try { localStorage.removeItem(CFG.storageKey); } catch (e) {}
      location.reload();
    } catch (e) { note(e.message || "Reset failed. The page has not been reloaded."); }
    finally { busy = false; }
  }
  document.addEventListener("zah-editor:save", publish);
  document.addEventListener("zah-editor:reset", reset);
  // Older installed editors lack lifecycle events. Intercept before their
  // local-only save / reload handlers, so failure is never reported as success.
  if (!window.ZAH_EDITOR_EVENTS) {
    if (save) save.addEventListener("click", function(e) { e.stopImmediatePropagation(); publish(); }, true);
    var rst = document.getElementById("edReset");
    if (rst) rst.addEventListener("click", function(e) { e.stopImmediatePropagation(); if (confirm("Reset the page to the original and discard all saved edits?")) reset(); }, true);
  }
})();
