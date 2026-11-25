/*! Sales at Scale lead form v1. Install: <div data-sas-lead-form="KEY"></div><script async src="https://APP/lp/v1.js"></script>
 * Hand-written ES2019, no dependencies. Backward compatible forever; breaking changes ship as /lp/v2.js.
 * Mounts our form in a Shadow DOM on every placeholder (also ones added later). Sets no cookies and never
 * loads an ad script. It keeps the visit's ad details in sessionStorage only when the page's consent banner
 * says analytics is granted. The pure parts mirror lib/lead-pages/snippet-core.ts (keep in sync). */
(function () {
  "use strict";
  var w = window, d = document;
  if (w.SasLeadForm && w.SasLeadForm.v === 1) return;

  // ---- pure core (mirrors lib/lead-pages/snippet-core.ts) ----
  var KEY_RE = /^[0-9A-Za-z]{12}$/;
  var PREVIEW_RE = /(?:^#|[#&])sas-preview=([0-9a-z]{1,10}\.[A-Za-z0-9_-]{22})(?:&|$)/;
  var UTM = ["source", "medium", "campaign", "term", "content"];
  var CLICK = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id"];
  var MAX = 200;

  function previewFromHash(hash) { var m = PREVIEW_RE.exec(hash || ""); return m ? m[1] : null; }
  function scriptBase(src) { var m = /^(https?:\/\/[^/?#]+)\//i.exec(src || ""); return m ? m[1] : null; }
  function readAd(search, referrer, pageHost) {
    var out = {}, q = new URLSearchParams(search || ""), i, v;
    for (i = 0; i < UTM.length; i++) { v = (q.get("utm_" + UTM[i]) || "").trim().slice(0, MAX); if (v) out["utm_" + UTM[i]] = v; }
    for (i = 0; i < CLICK.length; i++) { v = (q.get(CLICK[i]) || "").trim().slice(0, MAX); if (v) out[CLICK[i]] = v; }
    var m = /^https?:\/\/([^/?#:]+)/i.exec(referrer || ""), host = m ? m[1].toLowerCase() : "";
    if (host && host !== (pageHost || "").toLowerCase()) out.referrer = host;
    return out;
  }
  var STORE = "sas_lp_ad";
  function parseKeptAd(raw) {
    var out = {}, v, keys = [], i;
    try { v = JSON.parse(raw || "null"); } catch (e) { return out; }
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (i = 0; i < UTM.length; i++) keys.push("utm_" + UTM[i]);
    keys = keys.concat(CLICK, ["referrer"]);
    for (i = 0; i < keys.length; i++) { var x = v[keys[i]]; if (typeof x === "string" && x.trim()) out[keys[i]] = x.trim().slice(0, MAX); }
    return out;
  }
  function keepAd(cur, kept, c) {
    if (c !== "granted") return { ad: cur, store: null, clear: c === "denied" };
    if (Object.keys(cur).length) return { ad: cur, store: JSON.stringify(cur), clear: false };
    return { ad: parseKeptAd(kept), store: null, clear: false };
  }
  function at(e, i) { return e && typeof e === "object" ? e[i] : undefined; }
  function readConsent(win, tc) {
    var seen = [];
    if (tc && tc.gdprApplies !== false && tc.purpose && tc.purpose.consents) seen.push(tc.purpose.consents["1"] === true ? "granted" : "denied");
    if (Array.isArray(win.dataLayer)) {
      var mode = "unknown";
      for (var i = 0; i < win.dataLayer.length; i++) {
        var e = win.dataLayer[i];
        if (at(e, 0) !== "consent") continue;
        var kind = at(e, 1), v = at(e, 2);
        if ((kind === "default" || kind === "update") && v && typeof v === "object") {
          if (v.analytics_storage === "granted") mode = "granted";
          else if (v.analytics_storage === "denied") mode = "denied";
        }
      }
      if (mode !== "unknown") seen.push(mode);
    }
    var cb = win.Cookiebot;
    if (cb && cb.consent && typeof cb.consent.statistics === "boolean") {
      if (cb.consent.statistics) seen.push("granted");
      else if (cb.hasResponse) seen.push("denied");
    }
    if (typeof win.OnetrustActiveGroups === "string" && win.OnetrustActiveGroups.trim()) {
      seen.push(/(^|,)C0002(,|$)/.test(win.OnetrustActiveGroups) ? "granted" : "denied");
    }
    if (seen.indexOf("denied") >= 0) return "denied";
    return seen.indexOf("granted") >= 0 ? "granted" : "unknown";
  }
  function tellPixels(win, eventId) {
    var r = { meta: "absent", google: "absent" };
    try { if (typeof win.fbq === "function") { win.fbq("track", "Lead", {}, { eventID: eventId }); r.meta = "called"; } } catch (e) { r.meta = "called"; }
    try {
      if (typeof win.gtag === "function") { win.gtag("event", "generate_lead", {}); r.google = "called"; }
      else if (Array.isArray(win.dataLayer)) { win.dataLayer.push({ event: "generate_lead" }); r.google = "called"; }
    } catch (e) { r.google = "called"; }
    return r;
  }
  function checkLocal(name, phone) {
    var out = [];
    if ((name || "").trim().length < 2) out.push("name");
    if ((phone || "").replace(/\D/g, "").length < 7) out.push("phone");
    return out;
  }
  function pageUrlOf(href) { var m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(href || ""); return m ? m[1] + (m[2] || "/") : ""; }
  function nextUrl(base, body) {
    var p = typeof body.handover === "string" ? body.handover : typeof body.thanks === "string" ? body.thanks : null;
    return p && /^\/[hp]\/[A-Za-z0-9_.?=&/-]+$/.test(p) ? base + p : null;
  }
  var core = { previewFromHash: previewFromHash, scriptBase: scriptBase, readAd: readAd, parseKeptAd: parseKeptAd, keepAd: keepAd, readConsent: readConsent, tellPixels: tellPixels, checkLocal: checkLocal, pageUrlOf: pageUrlOf, nextUrl: nextUrl };

  // ---- where we are ----
  var me = d.currentScript;
  if (!me || !/\/lp\/v1\.js/.test(me.src || "")) me = d.querySelector('script[src*="/lp/v1.js"]');
  var BASE = scriptBase(me && me.src);
  var PREVIEW = previewFromHash(w.location.hash);

  // ---- the page's consent banner (asked once) ----
  var consentP = null;
  function consent() {
    if (consentP) return consentP;
    consentP = new Promise(function (resolve) {
      var done = false;
      function fin(tc) { if (!done) { done = true; resolve(readConsent(w, tc)); } }
      if (typeof w.__tcfapi === "function") {
        try { w.__tcfapi("getTCData", 2, function (data, ok) { fin(ok ? data : null); }); } catch (e) { fin(null); }
        setTimeout(function () { fin(null); }, 600);
      } else fin(null);
    });
    return consentP;
  }

  // ---- network (never with cookies) ----
  function api(key, path) { return BASE + "/api/lp/" + key + path; }
  var configs = {};
  function config(key, fresh) {
    if (!configs[key] || fresh) {
      var url = api(key, "/config") + (PREVIEW ? "?preview=" + encodeURIComponent(PREVIEW) : "") + (fresh ? (PREVIEW ? "&" : "?") + "r=" + Date.now() : "");
      configs[key] = fetch(url, { credentials: "omit", mode: "cors" }).then(function (r) {
        if (!r.ok) { if (r.status === 403 && w.console) w.console.warn("[Sales at Scale] This page's address is not allowed for lead form " + key + ". Add it in Lead pages."); return null; }
        return r.json();
      }).catch(function () { return null; });
    }
    return configs[key];
  }
  function beacon(key, body) {
    try { fetch(api(key, "/e"), { method: "POST", body: JSON.stringify(body), keepalive: true, credentials: "omit", mode: "cors", headers: { "Content-Type": "text/plain" } }).catch(function () {}); } catch (e) { /* counting is best effort */ }
  }

  // ---- the form ----
  var CSS = ":host{all:initial!important;display:block!important;font-family:inherit!important;color:inherit!important;font-size:16px!important;line-height:1.4!important;text-align:start!important;visibility:visible!important}" +
    "*,*::before,*::after{box-sizing:border-box}" +
    ".w{max-width:520px;display:flex;flex-direction:column;gap:14px;margin:0;padding:0}" +
    ".a{margin:0;font-size:14px;line-height:20px;opacity:.72}" +
    ".t{margin:0;font-size:20px;line-height:26px;font-weight:700}" +
    "form{display:flex;flex-direction:column;gap:14px;margin:0;padding:0}" +
    ".l{display:flex;flex-direction:column;gap:6px;font-size:15px;line-height:20px;font-weight:600;margin:0;min-width:0}" +
    ".i{display:block;height:46px;width:100%;min-width:0;margin:0;padding:0 12px;border:1px solid #7d8697;border-radius:8px;background:#fff;color:#0f1420;font:inherit;font-size:16px;font-weight:400;line-height:normal;box-shadow:none;appearance:auto}" +
    ".i[aria-invalid=true]{border-color:#c23a2b}" +
    ".e{color:#c23a2b;font-size:13px;line-height:18px;font-weight:500}" +
    ".al{margin:0;padding:10px 12px;border-radius:10px;background:#fdecea;color:#c23a2b;font-size:14px;line-height:20px;font-weight:500}" +
    ".c{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:18px;font-weight:400;margin:0}" +
    ".c span{opacity:.8}@supports (color:color-mix(in srgb,red 50%,blue)){.c span{opacity:1;color:color-mix(in srgb,currentColor 80%,transparent)}}" +
    ".c input{width:20px;height:20px;margin:0;flex:none;accent-color:var(--brand,#0f6b5a)}" +
    "a{color:inherit;text-decoration:underline}" +
    ".hp{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}" +
    ".b{display:flex;align-items:center;justify-content:center;width:100%;height:48px;margin:0;padding:0 16px;border:1px solid var(--brand,#0f6b5a);border-radius:12px;background:var(--brand,#0f6b5a);color:var(--brand-on,#fff);font:inherit;font-size:16px;font-weight:600;line-height:normal;cursor:pointer;text-decoration:none;text-transform:none;letter-spacing:normal}" +
    ".b[disabled]{opacity:.6;cursor:default}" +
    ".i:focus-visible,.b:focus-visible,.c input:focus-visible,a:focus-visible{outline:2px solid var(--brand,#0f6b5a);outline-offset:2px}" +
    ".n{margin:0;font-size:15px;line-height:22px}";

  function el(tag, attrs, kids) {
    var n = d.createElement(tag), k;
    for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] != null && attrs[k] !== false) {
      if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k]));
    }
    for (var i = 0; kids && i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }

  function render(host, key, cfg) {
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    while (root.firstChild) root.removeChild(root.firstChild);
    var brand = cfg.brand || {}, vars = "";
    for (var v in brand) if (/^--brand(-on|-text)?$/.test(v) && /^#[0-9a-fA-F]{3,8}$/.test(brand[v])) vars += v + ":" + brand[v] + ";";
    root.appendChild(el("style", { text: CSS + (vars ? ".w{" + vars + "}" : "") }));
    var wrap = el("div", { "class": "w", lang: cfg.lang, dir: cfg.dir, "data-sas-form": key });
    root.appendChild(wrap);
    var T = cfg.text || {};
    if (cfg.closed) { wrap.appendChild(el("p", { "class": "n", role: "status", text: T.closed })); return; }
    if (cfg.about) wrap.appendChild(el("p", { "class": "a", text: cfg.about }));
    wrap.appendChild(el("p", { "class": "t", role: "heading", "aria-level": "2", text: T.title }));
    var alert = el("p", { "class": "al", role: "alert", hidden: true });
    var form = el("form", { novalidate: true, method: "post", action: "#" });
    wrap.appendChild(alert);
    wrap.appendChild(form);
    var uid = "sas" + Math.random().toString(36).slice(2, 8);
    function field(name, label, attrs, err) {
      var input = el("input", Object.assign({ "class": "i", name: name, id: uid + name }, attrs));
      var e = err ? el("span", { "class": "e", id: uid + name + "-e", hidden: true, text: err }) : null;
      form.appendChild(el("label", { "class": "l", "for": uid + name }, [d.createTextNode(label), input, e]));
      return input;
    }
    var inName = field("name", T.name, { autocomplete: "name", required: true, maxlength: 120, dir: "auto" }, T.errName);
    var inPhone = field("phone", T.phone, { type: "tel", inputmode: "tel", autocomplete: "tel", required: true, maxlength: 40, dir: "ltr" }, T.errPhone);
    var f = cfg.fields || {};
    if (f.company) field("company", T.company, { autocomplete: "organization", maxlength: 120, dir: "auto" });
    if (f.email) field("email", T.email, { type: "email", autocomplete: "email", maxlength: 200, dir: "ltr" });
    // Bots fill this in; people never see it.
    form.appendChild(el("div", { "class": "hp", "aria-hidden": "true" }, [el("label", {}, [d.createTextNode("Website"), el("input", { name: "sas_url", tabindex: "-1", autocomplete: "off" })])]));
    var tick = el("input", { type: "checkbox", name: "consent", value: "on" });
    tick.checked = !!(cfg.consent && cfg.consent.ticked);
    // The consent line with the seller's and agent's names (odd parts) isolated, as text nodes: never markup.
    var cs = cfg.consent || {}, parts = Array.isArray(cs.parts) ? cs.parts : [cs.line || ""], line = el("span", {});
    for (var pi = 0; pi < parts.length; pi++) line.appendChild(pi % 2 ? el("bdi", { text: String(parts[pi]) }) : d.createTextNode(String(parts[pi])));
    if (cfg.privacyUrl) { line.appendChild(d.createTextNode(" ")); line.appendChild(el("a", { href: cfg.privacyUrl, target: "_blank", rel: "noopener", text: T.privacy })); }
    form.appendChild(el("label", { "class": "c" }, [tick, line]));
    var btn = el("button", { type: "submit", "class": "b", text: T.send });
    form.appendChild(btn);

    var carry = !!(cfg.tracking && cfg.tracking.carryAdDetails);
    var ad = carry ? readAd(w.location.search, d.referrer, w.location.hostname) : {};
    // Kept for the rest of the visit only when the page's consent banner says granted; otherwise this URL's details only.
    var adReady = consent().then(function (c) {
      if (!carry) return;
      var ss = null, k;
      try { ss = w.sessionStorage; } catch (e) { ss = null; }
      try { k = keepAd(ad, ss ? ss.getItem(STORE) : null, c); } catch (e) { return; }
      ad = k.ad;
      try { if (ss && k.store) ss.setItem(STORE, k.store); else if (ss && k.clear) ss.removeItem(STORE); } catch (e) { /* storage is optional */ }
    });
    var opened = false;
    function onOpen() {
      if (opened) return;
      opened = true;
      consent().then(function (c) { if (c !== "denied") beacon(key, Object.assign({ t: "open" }, ad, cfg.preview ? { preview: PREVIEW } : {})); });
    }
    form.addEventListener("focusin", onOpen);
    form.addEventListener("input", onOpen);

    function setErr(input, on) {
      input.setAttribute("aria-invalid", on ? "true" : "false");
      var e = root.getElementById ? root.getElementById(input.id + "-e") : null;
      if (e) { e.hidden = !on; if (on) input.setAttribute("aria-describedby", e.id); else input.removeAttribute("aria-describedby"); }
    }
    function showErrors(list) {
      setErr(inName, list.indexOf("name") >= 0);
      setErr(inPhone, list.indexOf("phone") >= 0);
      if (list.length) (list[0] === "name" ? inName : inPhone).focus();
    }
    function say(text) { alert.textContent = text || ""; alert.hidden = !text; }
    var sending = false, retried = false, waited = false;
    function busy(on) { sending = on; btn.disabled = on; btn.textContent = on ? T.sending : T.send; if (on) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy"); }
    function go(url) {
      var framed = true;
      try { framed = w.top !== w.self; } catch (e) { framed = true; }
      if (!framed) { w.location.assign(url); return; }
      // A builder's sandboxed frame (Wix "Embed HTML") may not move the top page: offer a link that does.
      try { w.top.location.href = url; } catch (e) { /* the link below */ }
      wrap.appendChild(el("a", { "class": "b", href: url, target: "_top", rel: "noopener", "data-sas-continue": "", text: T["continue"] }));
    }
    function send() {
      var data = {}, els = form.elements, i;
      for (i = 0; i < els.length; i++) {
        var x = els[i];
        if (!x.name || x.type === "submit") continue;
        if (x.type === "checkbox") { if (x.checked) data[x.name] = x.value; } else data[x.name] = x.value;
      }
      Object.assign(data, ad, { ft: cfg.ft, page_url: pageUrlOf(w.location.href) }, cfg.preview ? { preview: PREVIEW } : {});
      return fetch(api(key, "/submit"), { method: "POST", body: JSON.stringify(data), credentials: "omit", mode: "cors", headers: { "Content-Type": "text/plain" } })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { s: r.status, ok: r.ok, b: b }; }); });
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (sending) return;
      var local = checkLocal(inName.value, inPhone.value);
      showErrors(local);
      say("");
      if (local.length) return;
      busy(true);
      var attempt = function () {
        return send().then(function (r) {
          var url = r.ok ? nextUrl(BASE, r.b) : null;
          if (url) {
            if (r.b.handover && !cfg.preview && cfg.tracking && cfg.tracking.tellPagePixel) tellPixels(w, String(r.b.eventId || ""));
            go(url);
            return;
          }
          if (r.s === 403 && r.b.error === "timing" && r.b.retryAfterMs > 0 && !waited) {
            // Sent within a second of the form loading (autofill and a quick tap): wait out the rest and send once more.
            waited = true;
            return new Promise(function (res) { w.setTimeout(res, Math.min(Number(r.b.retryAfterMs), 5000) + 150); }).then(attempt);
          }
          if (r.s === 403 && r.b.error === "timing" && !retried) {
            // The form-timing token was too old (a tab left open): fetch a fresh one and try once more.
            retried = true;
            return config(key, true).then(function (c) { if (c && c.ft) { cfg.ft = c.ft; return attempt(); } busy(false); say(T.errGeneric); });
          }
          busy(false);
          if (r.s === 422 && r.b.fields && r.b.fields.length) showErrors(r.b.fields);
          else say(r.s === 429 ? T.errBusy : T.errGeneric);
        });
      };
      attempt().catch(function () { busy(false); say(T.errGeneric); });
    });

    adReady.then(consent).then(function (c) { if (c !== "denied") beacon(key, Object.assign({ t: "view" }, ad, cfg.preview ? { preview: PREVIEW } : {})); });
  }

  function mount(host) {
    if (!host || host.nodeType !== 1 || host.__sasLead) return;
    var key = host.getAttribute("data-sas-lead-form") || "";
    if (!KEY_RE.test(key) || !BASE || !host.attachShadow) return;
    host.__sasLead = true;
    // Our own element inside the seller's placeholder: page CSS aimed at divs never reaches it.
    var box = d.createElement("sas-lead-form");
    host.appendChild(box);
    config(key).then(function (cfg) { if (cfg && cfg.v === 1) render(box, key, cfg); else host.removeChild(box); });
  }
  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute("data-sas-lead-form")) mount(node);
    var list = node.querySelectorAll ? node.querySelectorAll("[data-sas-lead-form]") : [];
    for (var i = 0; i < list.length; i++) mount(list[i]);
  }

  w.SasLeadForm = { v: 1, core: core, mount: mount, scan: function () { scan(d.documentElement); } };
  if (!d.documentElement) return;
  scan(d.documentElement);
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", function () { scan(d.documentElement); });
  if (typeof MutationObserver === "function") {
    // Placeholders that appear later (page builders, popups, single-page apps).
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) for (var j = 0; j < records[i].addedNodes.length; j++) scan(records[i].addedNodes[j]);
    }).observe(d.documentElement, { childList: true, subtree: true });
  }
})();
