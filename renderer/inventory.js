(() => {
  const API_BASE         = "https://cdn.tigertag.io";

  // ── Firebase helpers — one named app instance per account ────────────────
  // Each account has its own firebase.app(uid) with independent auth session.
  // Falls back to the DEFAULT app only during the sign-in flow (uid not known yet).
  const fbAuth = (id) => {
    const appId = id || state.activeAccountId;
    if (appId) { try { return firebase.app(appId).auth(); } catch (_) {} }
    return firebase.auth();
  };
  const fbDb = (id) => {
    const appId = id || state.activeAccountId;
    if (appId) { try { return firebase.app(appId).firestore(); } catch (_) {} }
    return firebase.firestore();
  };
  let _unsubInventory  = null; // active Firestore onSnapshot unsubscribe handle
  let _sliderDebounce  = null; // pending auto-save timer for weight slider

  const ACCOUNT_COLORS = {
    orange: ["#f97316","#fb923c"],   // orange vif
    amber:  ["#d97706","#f59e0b"],   // ambre doré
    yellow: ["#ca8a04","#eab308"],   // jaune
    lime:   ["#65a30d","#84cc16"],   // vert citron
    green:  ["#16a34a","#22c55e"],   // vert nature
    teal:   ["#0d9488","#14b8a6"],   // bleu-vert
    sky:    ["#0284c7","#0ea5e9"],   // bleu ciel
    blue:   ["#2563eb","#3b82f6"],   // bleu roi
    violet: ["#7c3aed","#8b5cf6"],   // violet
    fuchsia:["#c026d3","#d946ef"],   // fuchsia
    rose:   ["#e11d48","#f43f5e"],   // rose vif
    red:    ["#dc2626","#ef4444"],   // rouge
    slate:  ["#475569","#64748b"],   // ardoise
  };
  // Compute a two-stop gradient from a single hex colour
  function hexToGradientPair(hex) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const mix = (c) => Math.min(255, c + Math.round((255-c)*0.38));
    const h = n => n.toString(16).padStart(2,"0");
    return [hex, `#${h(mix(r))}${h(mix(g))}${h(mix(b))}`];
  }
  function getAccGradient(acc) {
    if (acc?.color === "custom" && acc.customColor) {
      const [c1,c2] = hexToGradientPair(acc.customColor);
      return `linear-gradient(135deg,${c1},${c2})`;
    }
    const [c1,c2] = ACCOUNT_COLORS[acc?.color] || ACCOUNT_COLORS.orange;
    return `linear-gradient(135deg,${c1},${c2})`;
  }
  function getAccShadow(acc) {
    if (acc?.color === "custom" && acc.customColor) return acc.customColor;
    return (ACCOUNT_COLORS[acc?.color] || ACCOUNT_COLORS.orange)[0];
  }
  function applyAvatarStyle(acc) {
    const grad = getAccGradient(acc); const sh = getAccShadow(acc);
    const el = $("sbAvatar");
    el.style.background = grad;
    el.style.boxShadow = `0 0 0 3px ${sh}40,0 4px 20px ${sh}33`;
    // Use the dominant colour to decide whether initials should be black or
    // white. Without this, picking a near-white custom colour leaves the
    // initials invisible (white-on-white).
    el.style.color = readableTextOn(sh);
  }

  const STORAGE_ACCOUNTS = "tigertag.accounts";
  const STORAGE_ACTIVE   = "tigertag.activeAccount";
  const invKey = id => `tigertag.inv.${id}`;
  const LOGO_PATH          = "../assets/svg/logos/logo_tigertag.svg";
  const LOGO_PATH_OUTLINE  = "../assets/svg/logos/logo_tigertag_contouring.svg";

  const state = {
    inventory: null,
    rows: [],
    selected: null,
    keyValid: null,
    displayName: null,
    showDeleted: false,
    search: "",
    brandFilter: "",                  // exact brand name to keep, "" = all
    materialFilter: "",               // exact material name to keep, "" = all
    typeFilter: "",                   // exact product type to keep, "" = all

    viewMode: localStorage.getItem("tigertag.view") || "table",
    lang: localStorage.getItem("tigertag.lang") || "en",
    sortCol: null,
    sortDir: "asc",
    activeAccountId: null,
    i18n: {},
    imgCache: new Map(),
    invLoading: false,
    // True between subscribePrinters() and the first snapshot from any
    // of the 5 brand subcollections firing. Drives the "loading…" UI
    // in the printers view so we don't flash the empty state while
    // Firestore is still on its way back.
    printersLoading: false,
    isAdmin: false,
    debugEnabled: false,
    publicKey: null,
    privateKey: null,
    isPublic: false,
    friends: [],             // [{ uid, displayName, addedAt, key }]
    friendRequests: [],      // [{ uid, displayName, requestedAt }]
    blacklist: [],           // [{ uid, displayName, blockedAt }]
    racks: [],               // [{ id, name, level, position, order, createdAt, lastUpdate }]
    rackPresets: [],         // loaded from data/rack-presets.json
    unsubRacks: null,        // Firestore unsubscribe handle for racks
    scales: [],              // [{ mac, name, last_seen, last_spool, fw_version, ... }]
    unsubScales: null,       // Firestore unsubscribe handle for scales
    printers: [],            // [{ id, brand, printerName, printerModelId, isActive, updatedAt, sortIndex, ... }]
    unsubPrinters: [],       // array of Firestore unsubscribe handles (one per brand subcollection)
    unsubFriendRequests: null,
    friendView: null,        // { uid, displayName, avatarColor } — set when viewing a friend's inventory
    td1sConnected: false,
    db: { brand: [], material: [], aspect: [], type: [], diameter: [], unit: [], version: [], containers: [] }
  };

  const $ = id => document.getElementById(id);

  // t(key, params?) — looks up a translation key in the loaded locale.
  // Supports: plain strings, {{param}} interpolation, ["array"] random pick,
  // and {"one": "…", "other": "…"} plurals (uses params.n to select form).
  function t(key, params = {}) {
    const lang = state.i18n[state.lang] || {};
    const en   = state.i18n.en || {};
    const val  = (key in lang) ? lang[key] : (key in en ? en[key] : key);
    if (Array.isArray(val)) {
      return val[Math.floor(Math.random() * val.length)];
    }
    if (val && typeof val === "object" && ("one" in val || "other" in val)) {
      const n = params.n ?? 0;
      const str = n === 1 ? (val.one ?? val.other) : (val.other ?? val.one);
      return (str || "").replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? "");
    }
    if (typeof val === "string") {
      return val.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? "");
    }
    return key;
  }

  function applyTranslations() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    // data-i18n-title — used for icon-only buttons that need a localised
    // tooltip + accessible label without any visible text.
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
      const v = t(el.dataset.i18nTitle);
      el.setAttribute("title", v);
      // Mirror the same value to aria-label so screen readers get the
      // localised name too (the static aria-label in the markup is
      // English-only, this keeps it in sync with the user's language).
      el.setAttribute("aria-label", v);
    });
    if ($("langSelect")) $("langSelect").value = state.lang;
    // Refresh dynamic tooltips
    $("td1sHealth")?.setAttribute("data-tooltip", t(state.td1sConnected ? "td1sDetected" : "td1sNotDetected"));
  }

  /* ── helpers ── */
  function v(val) { return (val === undefined || val === null || val === "" || val === "--") ? "-" : val; }
  function toHex(r, g, b) {
    if ([r,g,b].some(c => typeof c !== "number")) return null;
    const h = n => Math.max(0,Math.min(255,n|0)).toString(16).padStart(2,"0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function timeAgo(secOrMs) {
    if (!secOrMs) return "-";
    const ms = secOrMs > 1e12 ? secOrMs : secOrMs * 1000;
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60)                    return t("agoNow");
    const m = Math.floor(s / 60);  if (m < 60)   return t("agoMin",   {n: m});
    const h = Math.floor(m / 60);  if (h < 24)   return t("agoHour",  {n: h});
    const d = Math.floor(h / 24);  if (d < 30)   return t("agoDay",   {n: d});
    const mo = Math.floor(d / 30); if (mo < 12)  return t("agoMonth", {n: mo});
    return t("agoYear", {n: Math.floor(mo / 12)});
  }
  function fmtTs(secOrMs) {
    if (!secOrMs) return "-";
    const ms = secOrMs > 1e12 ? secOrMs : secOrMs * 1000;
    const d = new Date(ms); return isNaN(d.getTime()) ? "-" : d.toLocaleString();
  }
  // TigerTag chip timestamps use epoch = Jan 1 2000 (946684800 s offset from Unix)
  const CHIP_EPOCH_OFFSET = 946684800;
  function fmtChipTs(ts) {
    if (!ts) return null;
    const d = new Date((ts + CHIP_EPOCH_OFFSET) * 1000);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString();
  }
  function setLoading(btn, on) { if (!btn) return; btn.classList.toggle("loading", !!on); btn.disabled = !!on; }

  /* Press-and-hold "destructive action" pattern — replaces a confirm() popup.
     User must hold the button for `durationMs` ms; the inner .hold-progress
     fills left→right during the hold. Releasing early cancels & rolls back. */
  function setupHoldToConfirm(btn, durationMs, onConfirm) {
    if (!btn) return;
    const fill = btn.querySelector(".hold-progress");
    let timer = null;
    function start(e) {
      e.preventDefault();
      if (btn.disabled) return;
      btn.classList.add("is-holding");
      if (fill) {
        fill.style.transition = "width 0s";
        fill.style.width = "0%";
        // Force a reflow so the next transition takes effect from 0%
        // eslint-disable-next-line no-unused-expressions
        fill.offsetWidth;
        fill.style.transition = `width ${durationMs}ms linear`;
        fill.style.width = "100%";
      }
      timer = setTimeout(() => {
        timer = null;
        btn.classList.remove("is-holding");
        btn.classList.add("is-confirming");
        if (fill) { fill.style.width = "100%"; }
        try { onConfirm(); } finally {
          // Reset visual state shortly after — the modal usually closes anyway
          setTimeout(() => {
            btn.classList.remove("is-confirming");
            if (fill) { fill.style.transition = "width 0s"; fill.style.width = "0%"; }
          }, 300);
        }
      }, durationMs);
    }
    function cancel() {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      btn.classList.remove("is-holding");
      if (fill) {
        fill.style.transition = "width .15s ease-out";
        fill.style.width = "0%";
      }
    }
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup",     cancel);
    btn.addEventListener("pointerleave",  cancel);
    btn.addEventListener("pointercancel", cancel);
  }
  // toast(el, kind, msg, opts?) — opts.err + opts.context add a "Details" link that opens the diagnostic panel
  function toast(el, kind, msg, opts) {
    if (!el) return; el.innerHTML = "";
    const div = document.createElement("div"); div.className = `alert ${kind}`; div.textContent = msg;
    if (opts && opts.err) {
      const sep = document.createElement("span"); sep.textContent = " — "; sep.style.opacity = ".7"; div.appendChild(sep);
      const link = document.createElement("button");
      link.type = "button"; link.className = "alert-link";
      link.textContent = t("errDetailsLink");
      link.addEventListener("click", e => { e.preventDefault(); openDiagnosticModal(); });
      div.appendChild(link);
    }
    el.appendChild(div);
  }

  /* ── Error reporting / diagnostic system ───────────────────────────────────
     reportError(context, err) records errors in a circular buffer so users
     who hit a problem can copy a full diagnostic report and send it back. */
  const _errorLog = []; // [{ ts, context, code, message, stack }]
  const _ERR_LOG_MAX = 50;
  function reportError(context, err) {
    const entry = {
      ts: Date.now(),
      context: String(context || "unknown"),
      code: (err && (err.code || err.name)) || "",
      message: (err && err.message) || String(err),
      stack: (err && err.stack) || null,
    };
    _errorLog.unshift(entry);
    if (_errorLog.length > _ERR_LOG_MAX) _errorLog.length = _ERR_LOG_MAX;
    try { console.error(`[reportError] ${entry.context}`, err); } catch {}
    // Update badge in settings panel if mounted
    try { renderDiagBadge(); } catch {}
  }
  // Capture globally — anything that bubbles up unhandled lands in the report
  window.addEventListener("error", e => {
    reportError("window.error", e.error || { message: e.message, stack: `${e.filename}:${e.lineno}:${e.colno}` });
  });
  window.addEventListener("unhandledrejection", e => {
    reportError("unhandledrejection", e.reason || { message: String(e) });
  });

  // App / platform info — fetched once via the preload bridge (Electron) or stubbed (browser)
  let _appInfo = null;
  async function loadAppInfo() {
    if (_appInfo) return _appInfo;
    try {
      if (window.electronAPI && window.electronAPI.getAppInfo) {
        _appInfo = await window.electronAPI.getAppInfo();
      }
    } catch {}
    if (!_appInfo) _appInfo = { appVersion: "?", platform: navigator.platform || "?", electron: "n/a" };
    renderAppVersion(_appInfo);
    return _appInfo;
  }

  // Populate the sidebar footer version + the Settings → About block.
  function renderAppVersion(info) {
    const v = info?.appVersion || "?";
    const sb = document.getElementById("sbVersion");
    if (sb) sb.textContent = `v${v}`;
    const sv = document.getElementById("stgAboutVersion");
    if (sv) sv.textContent = `v${v}`;
    const st = document.getElementById("stgAboutTech");
    if (st) {
      const parts = [];
      if (info?.platform) parts.push(`${info.platform}${info.arch ? " " + info.arch : ""}`);
      if (info?.electron && info.electron !== "n/a") parts.push(`Electron ${info.electron}`);
      st.textContent = parts.join(" · ") || "—";
    }
  }

  function renderDiagBadge() {
    const el = document.getElementById("btnReportProblem");
    const elLogin = document.getElementById("btnReportProblemLogin");
    const n = _errorLog.length;
    [el, elLogin].forEach(b => {
      if (!b) return;
      let badge = b.querySelector(".diag-badge");
      if (n > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "diag-badge";
          b.appendChild(badge);
        }
        badge.textContent = String(n);
      } else if (badge) {
        badge.remove();
      }
    });
  }

  function buildDiagnosticReport() {
    const info = _appInfo || {};
    const acc = (function(){ try { return JSON.parse(localStorage.getItem("tigertag.accounts") || "[]"); } catch { return []; } })();
    const lines = [];
    lines.push("# Tiger Studio Manager — diagnostic report");
    lines.push("");
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- App version: ${info.appVersion || "?"}`);
    lines.push(`- Electron: ${info.electron || "n/a"}  ·  Chrome: ${info.chrome || "n/a"}  ·  Node: ${info.node || "n/a"}`);
    lines.push(`- Platform: ${info.platform || navigator.platform || "?"} ${info.arch || ""}  (${info.osRelease || ""})`);
    lines.push(`- Locale: ${state.lang}  ·  UA: ${navigator.userAgent}`);
    lines.push(`- Accounts (local): ${acc.length}  ·  Active: ${state.activeAccountId ? state.activeAccountId.slice(0,6)+"…" : "none"}`);
    lines.push(`- Online: ${navigator.onLine ? "yes" : "no"}`);
    lines.push("");
    lines.push(`## Errors captured (${_errorLog.length})`);
    if (!_errorLog.length) { lines.push("_(none)_"); }
    else {
      _errorLog.forEach((e, i) => {
        lines.push("");
        lines.push(`### ${i+1}. [${new Date(e.ts).toISOString()}] ${e.context}${e.code ? " · " + e.code : ""}`);
        lines.push("```");
        lines.push(e.message || "(no message)");
        if (e.stack) { lines.push(""); lines.push(e.stack); }
        lines.push("```");
      });
    }
    return lines.join("\n");
  }

  function openDiagnosticModal() {
    loadAppInfo().then(() => {
      const overlay = document.getElementById("diagModalOverlay");
      if (!overlay) return;
      const body = document.getElementById("diagBody");
      if (body) body.value = buildDiagnosticReport();
      overlay.classList.add("open");
    });
  }
  function closeDiagnosticModal() {
    const overlay = document.getElementById("diagModalOverlay");
    if (overlay) overlay.classList.remove("open");
  }
  // Expose for inline handlers / external use
  window.openDiagnosticModal = openDiagnosticModal;
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  }
  function highlight(json) {
    if (typeof json !== "string") json = JSON.stringify(json, null, 2);
    json = esc(json);
    return json.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, m => {
      let c = "n";
      if (/^"/.test(m)) c = /:$/.test(m) ? "k" : "s";
      else if (/true|false|null/.test(m)) c = "b";
      return `<span class="${c}">${m}</span>`;
    });
  }
  function debug(meta, body) { $("debugMeta").textContent = meta; $("debugBody").innerHTML = highlight(body); }
  async function apiFetch(url, opts = {}) {
    const t0 = performance.now(); let res, text, body;
    try { res = await fetch(url, opts); text = await res.text(); }
    catch (e) { debug(`${opts.method||"GET"} ${url}\n${e.message}`, {error: String(e)}); throw e; }
    try { body = JSON.parse(text); } catch { body = text; }
    debug(`${opts.method||"GET"} ${url}\n→ ${res.status} ${res.statusText}  ·  ${Math.round(performance.now()-t0)} ms`, body);
    return { ok: res.ok, status: res.status, body };
  }

  /* ── lookups ── */
  async function loadLocales() {
    await Promise.all(["en", "fr", "de", "es", "it", "zh", "pt", "pt-pt", "pl"].map(async lang => {
      try {
        const r = await fetch(`locales/${lang}.json`);
        if (r.ok) state.i18n[lang] = await r.json();
      } catch {}
    }));
  }

  async function loadLookups() {
    const files = ["id_brand","id_material","id_aspect","id_type","id_diameter","id_measure_unit","id_version"];
    const keys  = ["brand",   "material",   "aspect",   "type",   "diameter",   "unit",            "version"];
    await Promise.all(files.map(async (f, i) => {
      try {
        const r = await fetch(`../data/${f}.json`);
        if (r.ok) state.db[keys[i]] = await r.json();
      } catch {}
    }));
    try {
      const r = await fetch('../data/container_spool/spools_filament.json');
      if (r.ok) state.db.containers = await r.json();
    } catch {}
    try {
      const r = await fetch('../data/rack-presets.json');
      if (r.ok) state.rackPresets = await r.json();
    } catch {}
    // Printer model catalogs — one per brand, keyed by the same brand id
    // we use in Firestore (`bambulab`, `creality`, `elegoo`, `flashforge`,
    // `snapmaker`). The `printerModelId` field on each printer doc matches
    // either the `id` (preferred) or the `name` of one of these entries.
    try {
      const printerCatalogs = [
        ["bambulab",   "../data/printers/bbl_printer_models.json"],
        ["creality",   "../data/printers/cre_printer_models.json"],
        ["elegoo",     "../data/printers/eleg_printer_models.json"],
        ["flashforge", "../data/printers/ffg_printer_models.json"],
        ["snapmaker",  "../data/printers/snap_printer_models.json"]
      ];
      state.db.printerModels = {};
      await Promise.all(printerCatalogs.map(async ([brand, url]) => {
        try {
          const r = await fetch(url);
          if (r.ok) state.db.printerModels[brand] = await r.json();
          else state.db.printerModels[brand] = [];
        } catch { state.db.printerModels[brand] = []; }
      }));
    } catch {}
  }

  /* ── Printer model lookup ──────────────────────────────────────────────
     Resolve a Firestore `printerModelId` against the local brand catalog
     so we can show the human-readable model name + the photo. The catalog
     `id` is the canonical key, but we accept `name` as a fallback because
     the data-model spec leaves both shapes valid.                          */
  function findPrinterModel(brand, modelId) {
    if (!modelId) return null;
    const list = state.db.printerModels?.[brand] || [];
    const wanted = String(modelId).trim();
    const wantedLower = wanted.toLowerCase();
    return list.find(m => String(m.id) === wanted)
        || list.find(m => String(m.name || "").toLowerCase() === wantedLower)
        || null;
  }
  // Catalog paths use "assets/images/<brand>_printers/<file>.png" but the
  // actual folder on disk is "assets/img/...". This mapper bridges that
  // gap. Renderer paths are relative to renderer/inventory.html so we
  // prepend "../" for the file:// fetch.
  function printerImageUrl(model) {
    if (!model || !model.image) return null;
    return "../" + String(model.image).replace(/^assets\/images\//, "assets/img/");
  }
  function printerImageUrlFor(brand, modelId) {
    const m = findPrinterModel(brand, modelId);
    return printerImageUrl(m);
  }
  function printerModelName(brand, modelId) {
    const m = findPrinterModel(brand, modelId);
    return m ? m.name : (modelId || "—");
  }
  function printerModelFeatures(brand, modelId) {
    const m = findPrinterModel(brand, modelId);
    return Array.isArray(m?.features) ? m.features.filter(f => f && f !== "No") : [];
  }
  function dbFind(key, id) { return state.db[key].find(x => x.id === id) || null; }
  function containerFind(id) { return (state.db.containers || []).find(c => c.id === id) || null; }
  function brandName(id) { const b = dbFind("brand", id); return b ? b.name : "-"; }
  function materialLabel(id) { const m = dbFind("material", id); return m ? m.label : "-"; }
  function aspectLabel(id) { const a = dbFind("aspect", id); return a ? a.label : null; }
  function diamLabel(id) { const d = dbFind("diameter", id); return d ? d.label + " mm" : null; }
  function versionName(id) { const vv = dbFind("version", id); return vv ? vv.name : null; }
  function materialFull(id) { return dbFind("material", id); }
  function typeName(id) { const tp = dbFind("type", id); return tp ? tp.label : null; }

  /* ── Firestore Timestamp → epoch ms (accepts number, Timestamp, or {_seconds}) ── */
  function tsToMs(v) {
    if (!v) return null;
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (v._seconds != null) return v._seconds * 1000;
    return null;
  }

  /* ── normalize ── */
  function normalizeRow(spoolId, data) {
    const hex  = toHex(data.color_r,  data.color_g,  data.color_b);
    const hex2 = toHex(data.color_r2, data.color_g2, data.color_b2);
    const hex3 = toHex(data.color_r3, data.color_g3, data.color_b3);
    const isPlus = data.url_img && data.url_img !== "--" && data.url_img !== "";
    const mat = materialFull(data.id_material);
    return {
      spoolId: String(spoolId),
      uid: data.uid != null ? String(data.uid) : String(spoolId),
      material: mat ? mat.label : (data.material || data.series || "-"),
      materialData: mat,
      brand: brandName(data.id_brand),
      colorName: data.color_name || data.name || data.message || "-",
      colorHex: hex,
      colorHex2: hex2,
      colorHex3: hex3,
      colorList: Array.isArray(data.online_color_list) ? data.online_color_list : [],
      colorType: data.online_color_type || null,
      aspect1: aspectLabel(data.id_aspect1),
      aspect2: aspectLabel(data.id_aspect2),
      diameter: diamLabel(data.data1),
      tagType: versionName(data.id_tigertag),
      weightAvailable: data.weight_available,
      containerWeight: data.container_weight,
      capacity: data.measure_gr || data.measure,
      imgUrl: isPlus ? data.url_img : null,
      isPlus,
      series: data.series || null,
      label: data.label && data.label !== "--" ? data.label : null,
      productName: data.name && data.name !== "--" ? data.name : null,
      sku: data.sku && data.sku !== "--" ? data.sku : null,
      barcode: data.barcode && data.barcode !== "--" ? data.barcode : null,
      isRefill:   !!data.info1,
      isRecycled: !!data.info2,
      isFilled:   !!data.info3,
      temps: {
        nozzleMin: data.data2 || null,
        nozzleMax: data.data3 || null,
        dryTemp:   data.data4 || null,
        dryTime:   data.data5 || null,
        bedMin:    data.data6 || null,
        bedMax:    data.data7 || null,
      },
      links: {
        youtube: data.LinkYoutube && data.LinkYoutube !== "--" ? data.LinkYoutube : null,
        msds:    data.LinkMSDS    && data.LinkMSDS    !== "--" ? data.LinkMSDS    : null,
        tds:     data.LinkTDS     && data.LinkTDS     !== "--" ? data.LinkTDS     : null,
        rohs:    data.LinkROHS    && data.LinkROHS    !== "--" ? data.LinkROHS    : null,
        reach:   data.LinkREACH   && data.LinkREACH   !== "--" ? data.LinkREACH   : null,
        food:    data.LinkFOOD    && data.LinkFOOD    !== "--" ? data.LinkFOOD    : null,
      },
      td: data.TD != null ? data.TD : null,
      twinUid: data.twin_tag_uid || null,
      containerId: data.container_id || null,
      // Storage location — new shape is `rack: { id, level, position }`,
      // legacy docs still have flat `rack_id` / `level` / `position`. We
      // read both so the migration window doesn't blank-out placements.
      rackId:    (data.rack && typeof data.rack === "object" && data.rack.id) || data.rack_id || null,
      rackLevel: (data.rack && Number.isInteger(data.rack.level))    ? data.rack.level
               : (Number.isInteger(data.level)    ? data.level    : null),
      rackPos:   (data.rack && Number.isInteger(data.rack.position)) ? data.rack.position
               : (Number.isInteger(data.position) ? data.position : null),
      lastUpdate: tsToMs(data.last_update) || tsToMs(data.updated_at),
      // Only `deleted === true` counts as a tombstone (matches Flutter mobile
       // semantics). `deleted_at` alone is treated as historical metadata and
       // does NOT hide the spool.
      deleted: data.deleted === true,
      productType: typeName(data.id_type),
      chipTimestamp: data.timestamp || null,
      needUpdateAt: data.needUpdateAt || null,
      raw: data,
    };
  }

  /* ── health (driven by Firestore metadata) ── */
  function setHealthLive(ms)  {
    $("health").classList.add("ok"); $("health").classList.remove("bad");
    $("health").dataset.tooltip = ms != null ? `${t("backendOk")} — ${ms} ms` : t("backendOk");
  }
  function setHealthOffline() { $("health").classList.remove("ok"); $("health").classList.add("bad");    $("health").dataset.tooltip = t("backendOffline"); }
  function setHealthIdle()    { $("health").classList.remove("ok","bad");                                $("health").dataset.tooltip = t("backendIdle"); }

  // Lazy ping: only fires when user hovers the cloud icon
  let _pingInFlight = false;
  $("health").addEventListener("mouseenter", async () => {
    if (_pingInFlight) return;
    _pingInFlight = true;
    try {
      const t0 = performance.now();
      const r  = await fetch(`${API_BASE}/healthz/`);
      const ms = Math.round(performance.now() - t0);
      if (r.ok) setHealthLive(ms);
      else { $("health").classList.add("bad"); $("health").classList.remove("ok"); $("health").dataset.tooltip = `${t("backendErr", {n: r.status})} — ${ms} ms`; }
    } catch {
      setHealthOffline();
    } finally {
      _pingInFlight = false;
    }
  });

  /* ── connected state ── */
  function setConnected(displayName, email) {
    state.displayName = displayName;
    const initials = displayName
      ? displayName.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)
      : (email || "?")[0].toUpperCase();
    $("sbAvatar").textContent = initials;   // removes child nodes incl. SVG "+"
    $("sbWelcome").textContent = t("welcomeBack");
    $("sbName").textContent = displayName || email || "—";
    $("sbUser").classList.remove("sb-user--empty");
    applyAvatarStyle(activeAccount());
    // Render the top-header chip (own user variant — avatar + display name
    // + random welcome greeting) so the chip appears immediately on connect.
    renderFriendBanner();
    $("signInPlaceholder").classList.add("hidden");
    $("card-inv").classList.add("hidden");
    $("card-welcome").classList.add("hidden");
    state.invLoading = true;
    renderInventory(); // show spinner immediately, before first Firestore snapshot
  }
  function setDisconnected() {
    state.displayName = null; state.keyValid = null;
    // Restore "+" SVG inside avatar
    const av = $("sbAvatar");
    av.textContent = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "sb-avatar-plus");
    svg.setAttribute("width", "22"); svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
    av.appendChild(svg);
    av.style.background = ""; av.style.boxShadow = "";
    $("sbUser").classList.add("sb-user--empty");
    $("sbStats").classList.add("hidden");
    // Hide the top-header user/friend chip when not signed in.
    $("friendViewBanner")?.classList.add("hidden");
    // Reset migration consent flags so the next sign-in / account switch
    // re-prompts the user. We deliberately do NOT clear the localStorage
    // snooze — that's a per-machine, time-bounded preference that should
    // outlive a sign-out.
    _uidMigrationUserAccepted = false;
    _uidMigrationDeferredThisSession = false;
    _uidMigrationInitialSweepDone = false;
    // Same reset for the rack-shape migration so its consent prompt
    // re-fires on the next sign-in.
    _rackMigrationUserAccepted = false;
    _rackMigrationDeferredThisSession = false;
    _rackMigrationInitialSweepDone = false;
    _rackMigrationQueue = [];
    _rackMigrationStats = { migrated: 0, failed: 0 };
    $("signInPlaceholder").classList.remove("hidden");
    $("card-inv").classList.add("hidden");
    $("card-welcome").classList.add("hidden");
    state.invLoading = false;
    setHealthIdle();
  }
  /* ── account dropdown ── */
  function openAccountDropdown() {
    renderAccountDropdown();
    const dropdown  = $("acctDropdown");
    const sidebar   = document.querySelector(".sidebar");
    const rect      = $("sbAvatar").getBoundingClientRect();
    dropdown.classList.add("dropdown-fixed");
    // toujours collé au bord droit du sidebar, aligné sur l'avatar
    const sbRect = sidebar ? sidebar.getBoundingClientRect() : rect;
    dropdown.style.left = (sbRect.right + 8) + "px";
    dropdown.style.top  = rect.top + "px";
    dropdown.classList.add("open");
    $("sbAvatar").style.opacity = ".8";
    setTimeout(() => document.addEventListener("click", _dropOutside), 0);
  }
  function closeAccountDropdown() {
    const dropdown = $("acctDropdown");
    dropdown.classList.remove("open", "dropdown-fixed");
    dropdown.style.left = "";
    dropdown.style.top  = "";
    $("sbAvatar").style.opacity = "";
    document.removeEventListener("click", _dropOutside);
  }
  function _dropOutside(e) {
    if (!$("acctDropdown").contains(e.target) && e.target !== $("sbAvatar")) closeAccountDropdown();
  }
  function renderAccountDropdown() {
    // Mirror the friend list to the sidebar quick-access chips on every
    // dropdown re-render — same data, just a second presentation.
    renderSidebarFriends();
    const accounts = getAccounts();
    const activeId = state.activeAccountId;
    const list = $("acctDropdownList");

    // ── Connected accounts ──
    let html = accounts.map(acc => `
      <button class="acct-drop-item${acc.id===activeId?' active':''}" data-drop-id="${esc(acc.id)}">
        <span class="acct-drop-avatar" style="background:${getAccGradient(acc)};color:${readableTextOn(getAccShadow(acc))}">${esc(getInitials(acc))}</span>
        <span class="acct-drop-name">${esc(acc.displayName || acc.email)}</span>
        ${acc.id===activeId ? '<span class="acct-drop-check">✓</span>' : ''}
      </button>`).join("");

    // ── Manage profiles action — right under connected accounts ──
    html += `<div class="acct-drop-sep"></div>
      <button class="acct-drop-action" data-drop-action="manage-profiles">
        <span class="icon icon-user icon-13"></span>
        <span>${t("btnManageProfiles")}</span>
      </button>`;

    // ── Friends section ──
    if (state.friends && state.friends.length) {
      html += `<div class="acct-drop-sep"></div>
        <div class="acct-drop-section-label">${t("friendsList")}</div>`;
      html += state.friends.map(f => {
        const initials = (f.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
        const color = friendColor(f);
        const fg = readableTextOn(color);
        const isActive = state.friendView?.uid === f.uid;
        return `<button class="acct-drop-item${isActive ? ' acct-drop-friend-active' : ''}" data-drop-friend-uid="${esc(f.uid)}" data-drop-friend-name="${esc(f.displayName || f.uid)}" data-drop-friend-color="${esc(color)}">
          <span class="acct-drop-avatar" style="background:${color};color:${fg}">${initials}</span>
          <span class="acct-drop-name">${esc(f.displayName || f.uid)}</span>
          ${isActive ? '<span class="acct-drop-check">✓</span>' : '<span class="acct-drop-eye"><span class="icon icon-eye-on icon-11"></span></span>'}
        </button>`;
      }).join("");
    }

    // ── Add friend action — always visible at the bottom ──
    html += `<div class="acct-drop-sep"></div>
      <button class="acct-drop-action" data-drop-action="add-friend">
        <span class="icon icon-plus icon-13"></span>
        <span>${t("friendsAdd")}</span>
      </button>`;

    list.innerHTML = html;

    list.querySelectorAll("[data-drop-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.dropId;
        closeAccountDropdown();
        if (id !== activeId) {
          switchAccountUI(id);
        } else if (state.friendView) {
          // Clicking the already-active account while viewing a friend's stock
          // → exit friend-view and return to own inventory.
          switchBackToOwnView();
        }
      });
    });
    list.querySelectorAll("[data-drop-friend-uid]").forEach(btn => {
      btn.addEventListener("click", () => {
        closeAccountDropdown();
        switchToFriendView(btn.dataset.dropFriendUid, btn.dataset.dropFriendName, btn.dataset.dropFriendColor);
      });
    });
    list.querySelectorAll("[data-drop-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.dropAction;
        closeAccountDropdown();
        if (action === "manage-profiles") openProfilesModal();
        else if (action === "add-friend") openAddFriendModal();
      });
    });
  }

  /* ── profiles modal ── */
  function openProfilesModal() {
    closeAccountDropdown();
    renderAccountList();
    $("profilesModalOverlay").classList.add("open");
    // Refresh friends list so the friends section stays up-to-date
    loadFriendsList().then(() => renderAccountList());
  }
  function closeProfilesModal() {
    $("profilesModalOverlay").classList.remove("open");
  }

  /* ── settings panel ── */
  const SVG_COPY = `<span class="icon icon-copy icon-13"></span>`;
  function openSettings() {
    if ($("langSelect")) $("langSelect").value = state.lang;
    $("settingsPanel").classList.add("open"); $("settingsOverlay").classList.add("open");
  }
  function closeSettings() {
    $("settingsPanel").classList.remove("open"); $("settingsOverlay").classList.remove("open");
  }
  $("btnOpenSettings").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", closeSettings);
  $("settingsOverlay").addEventListener("click", closeSettings);

  // Settings → collapsible cards (Data / Tools).  Click the header to
  // expand / collapse the body. State lives in `data-collapsed` on the
  // card, mirrored on `aria-expanded` of the header button. Pure CSS
  // animation via max-height transition on .stg-card-body--collapsible.
  document.querySelectorAll("#settingsPanel .stg-card--collapsible").forEach(card => {
    const head = card.querySelector(".stg-card-head--btn");
    if (!head) return;
    head.addEventListener("click", () => {
      const collapsed = card.dataset.collapsed === "true";
      card.dataset.collapsed = collapsed ? "false" : "true";
      head.setAttribute("aria-expanded", collapsed ? "true" : "false");
    });
  });

  async function openFriends() {
    // Auto-generate public key on first open if missing
    if (!state.publicKey) await regeneratePublicKey();
    loadFriendsList();
    renderFriendsSection();
    $("friendsPanel").classList.add("open"); $("friendsOverlay").classList.add("open");
  }
  function closeFriends() {
    $("friendsPanel").classList.remove("open"); $("friendsOverlay").classList.remove("open");
  }
  $("btnOpenFriends").addEventListener("click", openFriends);
  $("friendsPanelClose").addEventListener("click", closeFriends);
  $("friendsOverlay").addEventListener("click", closeFriends);

  // Scales panel — opens when clicking the scale health icon in the header
  function openScalesPanel() {
    renderScalesPanel();
    $("scalesPanel").classList.add("open");
    $("scalesOverlay").classList.add("open");
  }
  function closeScalesPanel() {
    $("scalesPanel").classList.remove("open");
    $("scalesOverlay").classList.remove("open");
  }
  $("scaleHealth")?.addEventListener("click", openScalesPanel);
  $("scalesPanelClose")?.addEventListener("click", closeScalesPanel);
  $("scalesOverlay")?.addEventListener("click", closeScalesPanel);

  const SVG_CHECK = `<span class="icon icon-check icon-13"></span>`;

  $("btnStgExport").addEventListener("click", () => {
    if (!state.inventory) return;
    const blob = new Blob([JSON.stringify(state.inventory,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `tigertag-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  // Settings → Data → "Copy API URL"
  // Builds and copies a self-contained URL that scripts (HA, cron, Spoolman
  // bridge, etc.) can curl to fetch this user's inventory remotely.
  //
  // Endpoint shape: cdn.tigertag.io/exportInventory?ApiKey=<key6>&email=<email>
  // The Key6 is a 6-char HTTP API key (different from `state.privateKey` which
  // is for friend-system Firestore rules — DON'T confuse them).
  //
  // Flow:
  //   1. Try to read the existing Key6 from `users/{uid}/apiKeys/apiKey1`
  //      (stored in plaintext as field `keyId`; rules allow owner-read).
  //   2. If none exists, call the Cloud Function `createAccessKey6`
  //      (POST + idToken) which generates one and stores it.
  //   3. Build the URL with `ApiKey` + `email` (the Cloud Function rejects
  //      requests with mismatching email = anti-tampering).
  //   4. Copy to clipboard, display a short warning that the URL is sensitive.
  async function getOrCreateApiKey6() {
    const user = fbAuth().currentUser;
    if (!user) throw new Error("not signed in");
    // Try existing
    try {
      const snap = await fbDb().collection("users").doc(user.uid)
        .collection("apiKeys").doc("apiKey1").get();
      if (snap.exists) {
        const d = snap.data() || {};
        if (d.keyId && d.active !== false) return d.keyId;
      }
    } catch (e) {
      console.warn("[apiKey] read failed:", e?.message);
    }
    // Create via Cloud Function (will rotate, but we just confirmed there's
    // nothing to rotate)
    const idToken = await user.getIdToken();
    const r = await fetch(`${API_BASE}/createAccessKey6`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data: { action: "create", label: "tiger-studio" } }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json?.result?.key) {
      throw new Error(json?.error?.message || `createAccessKey6 HTTP ${r.status}`);
    }
    return json.result.key;
  }

  $("btnCopyApiUrl")?.addEventListener("click", async () => {
    const warn = $("stgApiUrlWarn");
    const btn  = $("btnCopyApiUrl");
    const lbl  = btn?.querySelector("[data-i18n='stgCopyApiUrl']");
    const origLabel = lbl?.textContent;
    function setStatus(msg, kind) {
      if (!warn) return;
      warn.textContent = msg;
      warn.dataset.kind = kind || "info";
      warn.hidden = false;
    }
    function flashLabel(text) {
      if (!lbl || !origLabel) return;
      lbl.textContent = text;
      setTimeout(() => { lbl.textContent = origLabel; }, 1500);
    }

    const user = fbAuth().currentUser;
    if (!user) {
      setStatus(t("stgCopyApiUrlNoKey") || "Sign in first.", "err");
      return;
    }
    const email = (user.email || "").trim().toLowerCase();
    if (!email) {
      setStatus(t("stgCopyApiUrlNoKey") || "Email not set on this account.", "err");
      return;
    }
    if (btn) btn.disabled = true;
    setStatus(t("stgCopyApiUrlGenerating") || "Generating URL…", "info");
    try {
      const key = await getOrCreateApiKey6();
      const url = `${API_BASE}/exportInventory?ApiKey=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
      await navigator.clipboard.writeText(url);
      setStatus(t("stgCopyApiUrlOk") || "Copied — keep this URL private; anyone with it can read your inventory.", "warn");
      flashLabel(t("settingsCopied") || "Copied!");
    } catch (e) {
      setStatus((t("stgCopyApiUrlErr") || "Copy failed") + ": " + (e?.message || e), "err");
    } finally {
      if (btn) setTimeout(() => { btn.disabled = false; }, 800);
    }
  });

  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeSettings(); closeFriends(); } });
  $("btnSbReload").addEventListener("click", () => loadInventory());

  const SVG_EYE_OFF = `<span class="icon icon-eye-off icon-14"></span>`;
  const SVG_EYE_ON  = `<span class="icon icon-eye-on icon-14"></span>`;
  function makeEyeToggle(btnId, fieldId) {
    const btn = $(btnId), field = $(fieldId);
    if (!btn || !field) return;
    // preventDefault sur mousedown : garde le focus sur l'input → pas de reflow → pas de saut
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      const reveal = !field.classList.contains("revealed");
      field.classList.toggle("revealed", reveal);
      // style direct = repaint immédiat (quirk Chromium avec valeurs définies programmatiquement)
      field.style.webkitTextSecurity = reveal ? "none" : "disc";
      btn.innerHTML = reveal ? SVG_EYE_ON : SVG_EYE_OFF;
    });
  }
  function makeCopyBtn(btnId, fieldId) {
    const btn = $(btnId), field = $(fieldId);
    if (!btn || !field) return;
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      const val = field.value; if (!val) return;
      navigator.clipboard.writeText(val).then(() => {
        btn.innerHTML = SVG_CHECK; btn.classList.add("copied");
        setTimeout(() => { btn.innerHTML = SVG_COPY; btn.classList.remove("copied"); }, 1800);
      });
    });
  }

  /* ── modal: disconnect account ── */
  /* ── modal: edit account ── */
  let _editingAccount = null;
  function openEditAccountModal(acc) {
    _editingAccount = acc || activeAccount(); if (!_editingAccount) return;
    $("eacAvatar").textContent  = getInitials(_editingAccount);
    $("eacName").textContent    = _editingAccount.displayName || "";
    $("eacName").style.display  = _editingAccount.displayName ? "" : "none";
    $("eacEmail").textContent   = _editingAccount.email || "";
    $("eacAvatar").style.background = getAccGradient(_editingAccount);
    $("eacAvatar").style.color = readableTextOn(getAccShadow(_editingAccount));
    $("eacDisplayNameInput").value = _editingAccount.displayName || "";
    $("eacNameResult").textContent = "";
    $("eacAdminBadge").classList.toggle("hidden", !state.isAdmin);
    $("eacDebugRow").classList.toggle("hidden",   !state.isAdmin);
    $("eacDebugToggle").checked = state.debugEnabled;
    const isCustom = _editingAccount?.color === "custom";
    if (isCustom && _editingAccount.customColor) {
      $("eacCustomColor").value = _editingAccount.customColor;
      $("eacSwatchCustom").style.background = getAccGradient(_editingAccount);
    }
    $("eacSwatches").querySelectorAll(".eac-swatch[data-color]").forEach(sw =>
      sw.classList.toggle("active", !isCustom && sw.dataset.color === (_editingAccount?.color || "orange"))
    );
    $("eacSwatchCustom").classList.toggle("active", isCustom);
    $("editAccountModalOverlay").classList.add("open");
  }
  function closeEditAccountModal() {
    $("editAccountModalOverlay").classList.remove("open");
  }
  // avatar dropdown
  $("sbAvatar").addEventListener("click", e => {
    e.stopPropagation();
    if ($("sbUser").classList.contains("sb-user--empty")) {
      openAddAccountModal();
      return;
    }
    // When the user is currently viewing a friend's inventory, the avatar
    // acts as a one-click "return to my own inventory" shortcut. The swap
    // badge overlay (.sb-avatar-swap) is the visual hint — the whole tile
    // is clickable and toggles back to ownership in a single tap.
    if (state.friendView) {
      // Make sure no dropdown is left half-open after the swap.
      if ($("acctDropdown").classList.contains("open")) closeAccountDropdown();
      switchBackToOwnView();
      return;
    }
    $("acctDropdown").classList.contains("open") ? closeAccountDropdown() : openAccountDropdown();
  });
  $("btnAddFirstAccount").addEventListener("click", openAddAccountModal);
  // btnManageProfiles is now rendered dynamically in renderAccountDropdown — listener attached there

  // profiles modal
  $("profilesModalClose").addEventListener("click", closeProfilesModal);
  $("profilesModalOverlay").addEventListener("click", e => { if (e.target === $("profilesModalOverlay")) closeProfilesModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("profilesModalOverlay").classList.contains("open")) closeProfilesModal(); });

  // preset color swatches
  // Resolve the primary hex of an account's chosen colour
  function accPrimaryHex(acc) {
    if (acc?.color === "custom" && acc.customColor) return acc.customColor;
    return (ACCOUNT_COLORS[acc?.color] || ACCOUNT_COLORS.orange)[0];
  }

  // Persist avatar colour as RGB integers in users/{uid} so any surface can read it
  function saveColorToFirestore(acc) {
    try {
      const user = fbAuth().currentUser;
      if (!user || user.uid !== acc.id) return;
      const hex = accPrimaryHex(acc).replace(/^#/, "");
      const r = parseInt(hex.slice(0,2), 16);
      const g = parseInt(hex.slice(2,4), 16);
      const b = parseInt(hex.slice(4,6), 16);
      fbDb().collection("users").doc(user.uid).set({ color_r: r, color_g: g, color_b: b }, { merge: true });
    } catch (e) { /* non-blocking */ }
  }

  $("eacSwatches").querySelectorAll(".eac-swatch[data-color]").forEach(sw => {
    sw.addEventListener("click", () => {
      if (!_editingAccount) return;
      const color = sw.dataset.color;
      $("eacSwatches").querySelectorAll(".eac-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
      const accounts = getAccounts();
      const idx = accounts.findIndex(a => a.id === _editingAccount.id);
      if (idx >= 0) { accounts[idx].color = color; delete accounts[idx].customColor; saveAccounts(accounts); _editingAccount = accounts[idx]; }
      $("eacAvatar").style.background = getAccGradient(_editingAccount);
      $("eacAvatar").style.color = readableTextOn(getAccShadow(_editingAccount));
      if (_editingAccount.id === state.activeAccountId) applyAvatarStyle(_editingAccount);
      renderAccountDropdown();
      saveColorToFirestore(_editingAccount);
    });
  });
  // custom color picker — debounce Firestore write, apply UI instantly
  let _colorDebounce = null;
  $("eacCustomColor").addEventListener("input", () => {
    if (!_editingAccount) return;
    const hex = $("eacCustomColor").value;
    const accounts = getAccounts();
    const idx = accounts.findIndex(a => a.id === _editingAccount.id);
    if (idx >= 0) { accounts[idx].color = "custom"; accounts[idx].customColor = hex; saveAccounts(accounts); _editingAccount = accounts[idx]; }
    $("eacSwatches").querySelectorAll(".eac-swatch").forEach(s => s.classList.remove("active"));
    $("eacSwatchCustom").classList.add("active");
    $("eacSwatchCustom").style.background = getAccGradient(_editingAccount);
    $("eacAvatar").style.background = getAccGradient(_editingAccount);
    $("eacAvatar").style.color = readableTextOn(getAccShadow(_editingAccount));
    if (_editingAccount.id === state.activeAccountId) applyAvatarStyle(_editingAccount);
    renderAccountDropdown();
    clearTimeout(_colorDebounce);
    _colorDebounce = setTimeout(() => saveColorToFirestore(_editingAccount), 600);
  });

  $("editAccountModalClose").addEventListener("click", closeEditAccountModal);
  $("editAccountModalOverlay").addEventListener("click", e => { if (e.target === $("editAccountModalOverlay")) closeEditAccountModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("editAccountModalOverlay").classList.contains("open")) closeEditAccountModal(); });

  // Save display name
  async function saveDisplayName() {
    if (!_editingAccount) return;
    const newName = $("eacDisplayNameInput").value.trim();
    const res = $("eacNameResult");
    if (!newName) { res.style.color = "var(--danger)"; res.textContent = "—"; return; }
    if (newName === (_editingAccount.displayName || "")) {
      res.style.color = "var(--muted)"; res.textContent = "✓";
      setTimeout(() => { res.textContent = ""; }, 1200); return;
    }
    res.style.color = "var(--muted)"; res.textContent = "Saving…";
    try {
      // 1. Firebase Auth profile
      const user = fbAuth().currentUser;
      if (user) await user.updateProfile({ displayName: newName });
      // 2. Firestore users/{uid}
      if (user) await fbDb().collection("users").doc(user.uid).set({ displayName: newName }, { merge: true });
      // 3. localStorage account
      const accounts = getAccounts();
      const idx = accounts.findIndex(a => a.id === _editingAccount.id);
      if (idx >= 0) { accounts[idx].displayName = newName; saveAccounts(accounts); _editingAccount = accounts[idx]; }
      // 4. Refresh UI
      $("eacName").textContent = newName; $("eacName").style.display = "";
      $("eacAvatar").textContent = getInitials(_editingAccount);
      if (_editingAccount.id === state.activeAccountId) {
        state.displayName = newName;
        $("sbName").textContent = newName;
        $("sbAvatar").textContent = getInitials(_editingAccount);
      }
      renderAccountDropdown();
      res.style.color = "var(--primary)"; res.textContent = "✓ Saved";
      setTimeout(() => { res.textContent = ""; }, 2000);
    } catch (e) {
      res.style.color = "var(--danger)"; res.textContent = e.message || "Error";
    }
  }
  $("btnSaveDisplayName").addEventListener("click", saveDisplayName);
  $("eacDisplayNameInput").addEventListener("keydown", e => { if (e.key === "Enter") saveDisplayName(); });

  $("eacDebugToggle").addEventListener("change", async () => {
    const enabled = $("eacDebugToggle").checked;
    state.debugEnabled = enabled;
    applyDebugMode();
    // Re-render any open detail / side panel so the Raw + Log sections
    // appear / disappear immediately without forcing the user to close
    // and reopen them.
    if (state.selected && $("detailPanel")?.classList.contains("open")) {
      try { openDetail(state.selected); } catch (_) {}
    }
    if (_activePrinter && $("printerPanel")?.classList.contains("open")) {
      try { renderPrinterDetail(); } catch (_) {}
    }
    const uid = state.activeAccountId; if (!uid) return;
    try {
      await fbDb().collection("users").doc(uid).set({ Debug: enabled }, { merge: true });
    } catch (e) { console.warn("[Firestore] debug toggle:", e.message); }
  });

  // Disconnect = Firebase sign-out
  $("btnEditModalDisconnect").addEventListener("click", async () => {
    if (!_editingAccount) return;
    closeEditAccountModal();
    await fbSignOut();
  });

  /* ── modal: login (Firebase) ── */
  let _lmMode = "signin"; // "signin" | "create"

  function lmSetMode(mode) {
    _lmMode = mode;
    const create = mode === "create";
    $("lmConfirmWrap").classList.toggle("hidden", !create);
    $("lmSignInExtras").classList.toggle("hidden", create);
    $("stgPassword").setAttribute("autocomplete", create ? "new-password" : "current-password");
    // Update dynamic labels (data-i18n + textContent)
    const set = (id, key) => { $(id).dataset.i18n = key; $(id).textContent = t(key); };
    set("lmTitle",          create ? "loginCreateTitle"    : "loginSignInTitle");
    set("lmSubtitle",       create ? "loginCreateSubtitle" : "loginSignInSubtitle");
    set("lmSubmitLabel",    create ? "loginCreateAccount"  : "btnSignIn");
    set("lmToggleText",     create ? "loginHaveAccount"    : "loginNoAccount");
    set("btnToggleAuthMode",create ? "btnSignIn"           : "loginCreateAccount");
    $("addModalResult").innerHTML = "";
  }

  function openAddAccountModal() {
    $("stgEmail").value = "";
    $("stgPassword").value = "";
    $("stgConfirmPassword").value = "";
    $("stgPassword").classList.remove("revealed");
    $("stgConfirmPassword").classList.remove("revealed");
    $("btnToggleStgPassword").innerHTML = SVG_EYE_OFF;
    $("btnToggleConfirmPassword").innerHTML = SVG_EYE_OFF;
    $("addModalResult").innerHTML = "";
    $("stgRememberMe").checked = true;
    lmSetMode("signin");
    // Sync language select to current app language
    $("lmLangSelect").value = state.lang;
    $("addAccountModalOverlay").classList.add("open");
    setTimeout(() => $("stgEmail").focus(), 180);
  }

  function closeAddAccountModal() {
    $("addAccountModalOverlay").classList.remove("open");
  }

  $("addModalClose").addEventListener("click", closeAddAccountModal);
  $("addAccountModalOverlay").addEventListener("click", e => { if (e.target === $("addAccountModalOverlay")) closeAddAccountModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("addAccountModalOverlay").classList.contains("open")) closeAddAccountModal(); });

  // Eye toggles for both password fields
  makeEyeToggle("btnToggleStgPassword", "stgPassword");
  makeEyeToggle("btnToggleConfirmPassword", "stgConfirmPassword");

  // Language switcher inside the login modal
  $("lmLangSelect").addEventListener("change", () => {
    const lang = $("lmLangSelect").value;
    saveAccountLang(lang);
    applyLang(lang);
  });

  // Mode toggle: sign-in ↔ create account
  $("btnToggleAuthMode").addEventListener("click", () => {
    lmSetMode(_lmMode === "signin" ? "create" : "signin");
  });

  // Forgot password
  $("btnForgotPassword").addEventListener("click", async () => {
    const email = $("stgEmail").value.trim();
    if (!email) { $("stgEmail").focus(); return; }
    $("addModalResult").innerHTML = "";
    try {
      await fbAuth().sendPasswordResetEmail(email);
      toast($("addModalResult"), "ok", t("loginResetSent"));
    } catch (err) {
      reportError("auth.resetPassword", err);
      toast($("addModalResult"), "bad", err.message || t("networkError"), { err, context: "auth.resetPassword" });
    }
  });

  // Google sign-in.
  //
  // In Electron we use the loopback OAuth flow (RFC 8252 + PKCE) — the
  // system browser handles the actual auth, which means Touch ID / passkey
  // / hardware keys work NATIVELY (Safari has full WebAuthn integration
  // with the macOS keychain; the Chromium popup spawned by
  // signInWithPopup does not).
  //
  // Outside Electron (future web build hosted on tigertag-cdn) we fall
  // back to signInWithPopup — that one works fine in real browsers.
  //
  // Either path produces the same end state: a signed-in firebase.User
  // we can hand to ensureFirebaseApp / setActiveId / setupNamedAuth.
  $("btnGoogleSignIn").addEventListener("click", async () => {
    setLoading($("btnGoogleSignIn"), true);
    $("addModalResult").innerHTML = "";
    try {
      let result;
      const loopback = window.electronAPI?.signInWithGoogleLoopback;
      if (loopback) {
        // Native Electron flow — opens Safari, returns once the user
        // completes the auth. The renderer stays unblocked but waits on
        // the IPC promise (the system browser is the real UI here).
        const r = await loopback();
        if (!r?.ok) {
          // Loopback failed (Client ID not configured, Google error,
          // user closed the tab, etc.). Fall through to popup so the
          // user isn't stuck — the popup at least lets them pick
          // password / SMS code as a fallback.
          console.warn("[auth.google] loopback failed, falling back to popup:", r?.error);
          const provider = new firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: "select_account" });
          result = await firebase.auth().signInWithPopup(provider);
        } else {
          // Build a Firebase credential from the tokens Google returned.
          // We pass BOTH idToken and accessToken: if the idToken's audience
          // doesn't match a Firebase-known OAuth client, Firebase falls
          // back to using the accessToken against Google's userinfo
          // endpoint (no audience constraint there).
          const credential = firebase.auth.GoogleAuthProvider.credential(r.idToken, r.accessToken);
          result = await firebase.auth().signInWithCredential(credential);
        }
      } else {
        // Non-Electron environments (future web build) — popup works
        // because the host browser owns the WebAuthn UI.
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        result = await firebase.auth().signInWithPopup(provider);
      }
      const uid = result.user.uid;
      // Transfer session to named instance, mark active, register listener,
      // then call handleSignedIn EXPLICITLY so the UI updates even if the
      // named-app onAuthStateChanged doesn't re-fire (Electron popup quirk).
      ensureFirebaseApp(uid);
      await firebase.app(uid).auth().updateCurrentUser(result.user);
      setActiveId(uid);
      setupNamedAuth(uid);
      await firebase.auth().signOut();
      closeAddAccountModal();
      await handleSignedIn(result.user, uid);   // ← explicit UI refresh
    } catch (err) {
      const code = err.code || "";
      if (code !== "auth/popup-closed-by-user") {
        reportError("auth.google", err);
        toast($("addModalResult"), "bad", t("addAccountAuthError"), { err, context: "auth.google" });
      }
    } finally { setLoading($("btnGoogleSignIn"), false); }
  });

  // Email/password sign-in or create account
  $("btnStgSave").addEventListener("click", async () => {
    const email    = $("stgEmail").value.trim();
    const password = $("stgPassword").value;
    if (!email || !password) return;
    setLoading($("btnStgSave"), true);
    $("addModalResult").innerHTML = "";
    try {
      const remember = $("stgRememberMe").checked;
      const persistence = remember
        ? firebase.auth.Auth.Persistence.LOCAL
        : firebase.auth.Auth.Persistence.SESSION;
      if (_lmMode === "create") {
        const confirm = $("stgConfirmPassword").value;
        if (password !== confirm) {
          toast($("addModalResult"), "bad", t("loginPasswordMismatch"));
          setLoading($("btnStgSave"), false);
          return;
        }
        if (password.length < 6) {
          toast($("addModalResult"), "bad", t("loginPasswordTooShort"));
          setLoading($("btnStgSave"), false);
          return;
        }
        // Create on DEFAULT, transfer to named instance, register listener,
        // then call handleSignedIn EXPLICITLY for guaranteed UI refresh.
        const result = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const uid = result.user.uid;
        ensureFirebaseApp(uid);
        await firebase.app(uid).auth().setPersistence(persistence);
        await firebase.app(uid).auth().updateCurrentUser(result.user);
        setActiveId(uid);
        setupNamedAuth(uid);
        await firebase.auth().signOut();
        toast($("addModalResult"), "ok", t("loginAccountCreated"));
        setTimeout(closeAddAccountModal, 1400);
        await handleSignedIn(result.user, uid);
      } else {
        // Sign in on DEFAULT, transfer to named instance, register listener,
        // then call handleSignedIn EXPLICITLY for guaranteed UI refresh.
        const result = await firebase.auth().signInWithEmailAndPassword(email, password);
        const uid = result.user.uid;
        ensureFirebaseApp(uid);
        await firebase.app(uid).auth().setPersistence(persistence);
        await firebase.app(uid).auth().updateCurrentUser(result.user);
        setActiveId(uid);
        setupNamedAuth(uid);
        await firebase.auth().signOut();
        closeAddAccountModal();
        await handleSignedIn(result.user, uid);
      }
    } catch (err) {
      const code = err.code || "";
      const msg = (code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-credential")
        ? t("addAccountAuthError")
        : code === "auth/email-already-in-use"
          ? t("loginEmailInUse")
          : (err.message || t("networkError"));
      reportError(_lmMode === "create" ? "auth.create" : "auth.signin", err);
      toast($("addModalResult"), "bad", msg, { err, context: _lmMode === "create" ? "auth.create" : "auth.signin" });
    }
    setLoading($("btnStgSave"), false);
  });

  // Allow Enter key in either password field to submit
  $("stgPassword").addEventListener("keydown", e => { if (e.key === "Enter") $("btnStgSave").click(); });
  $("stgConfirmPassword").addEventListener("keydown", e => { if (e.key === "Enter") $("btnStgSave").click(); });

  /* ── sidebar collapse toggle ── */
  (function() {
    const sidebar = $("sidebar");
    if (localStorage.getItem("tigertag.sidebar") === "collapsed") {
      sidebar.classList.add("collapsed");
    }
    $("btnSidebarToggle").addEventListener("click", () => {
      const collapsed = sidebar.classList.toggle("collapsed");
      localStorage.setItem("tigertag.sidebar", collapsed ? "collapsed" : "expanded");
    });
  })();

  /* ── account storage helpers ── */
  function getAccounts() { try { return JSON.parse(localStorage.getItem(STORAGE_ACCOUNTS) || "[]"); } catch { return []; } }
  function saveAccounts(arr) { localStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(arr)); }
  function getActiveId() { return localStorage.getItem(STORAGE_ACTIVE) || null; }
  function setActiveId(id) { localStorage.setItem(STORAGE_ACTIVE, id); state.activeAccountId = id; }
  function activeAccount() { const id = getActiveId(); return getAccounts().find(a => a.id === id) || null; }

  /* ── persistence ── */
  function saveInventory(raw) {
    if (!state.activeAccountId) return;
    try { localStorage.setItem(invKey(state.activeAccountId), JSON.stringify(raw)); } catch {}
  }

  /* ── forced migration: wipe pre-Firebase accounts (those that have apiKey field) ── */
  function runMigration() {
    const accounts = getAccounts();
    const hasLegacy = accounts.some(a => "apiKey" in a);
    if (!hasLegacy) return;
    accounts.forEach(a => localStorage.removeItem(invKey(a.id)));
    localStorage.removeItem(STORAGE_ACCOUNTS);
    localStorage.removeItem(STORAGE_ACTIVE);
    localStorage.removeItem("tigertag.creds");
    localStorage.removeItem("tigertag.inventory");
    console.info("[Migration] Legacy API-key accounts wiped. Please sign in with Firebase Auth.");
  }

  /* ── Firebase sign-out (named instance of active account) ── */
  async function fbSignOut() {
    unsubscribeInventory();
    const id = state.activeAccountId;
    if (id) { try { await firebase.app(id).auth().signOut(); } catch (_) {} }
    try { await firebase.auth().signOut(); } catch (_) {} // clean up DEFAULT too
  }

  /* ── UID format migration — decimal big-endian → hex uppercase ─────────
     The legacy mobile app (still in production at the time this code was
     written) creates `inventory/{spoolId}` doc ids in DECIMAL big-endian
     form, e.g. "8307741719072896". The canonical format going forward is
     HEX uppercase, no separators, e.g. "1D895E7C004A80". Both forms decode
     to the same integer.

     SHARED RESPONSIBILITY — every TigerTag client that has write access and
     sees a decimal-format inventory doc converts it to hex on the fly:
       - Tiger Studio Manager (here)
       - The new mobile app version (once deployed) — same algorithm, ported
       - TigerScale firmware writes hex from day one; for old decimal docs it
         encounters, it does a fallback lookup via `uidMigrationMap` (see
         tigerscale-doc-schema.md §"Mixed-format tolerance").

     The lookup table `users/{uid}/uidMigrationMap/{decimal_uid}` →
     `{ hex_uid, migrated_at }` lets external clients holding old decimal
     ids resolve them to the new hex doc ids without scanning the inventory.

     Properties of this implementation:
       1. Idempotent. If the hex doc already exists (re-run, partial
          migration, or another client beat us to it), we just clean up
          the decimal stub and write the map entry.
       2. Atomic per spool. One Firestore batch handles: SET hex doc,
          UPDATE every other doc whose `twin_tag_uid` pointed at this
          decimal id, SET map entry, DELETE decimal doc. All-or-nothing.
       3. Safe vs concurrent mobile-app writes. If the mobile app PATCHes
          the just-deleted decimal doc, Firestore creates a stub with
          partial data; the next snapshot re-queues it, we merge it back
          into the hex doc with `{merge: true}`, no data loss.
       4. Background, polite. Drains one spool every ~200 ms so we don't
          burst Firestore quota during a big initial sweep.
       5. Owner-only. Never runs while previewing a friend's inventory
          (state.friendView short-circuit).
  */
  const _uidMigrationQueue = [];        // [decimalId, ...] — pending
  let   _uidMigrationDraining = false;
  const _uidMigrationStats = { migrated: 0, skipped: 0, failed: 0 };
  // ── UI state for the migration flow ─────────────────────────────────
  // Two modals coordinate the experience:
  //   1. Confirm modal — shown ONCE per session when decimal docs are
  //      first detected. The user picks "Update now" / "Remind me later"
  //      / "Later". Until they choose "Update now", we never queue a
  //      migration.
  //   2. Progress lock-screen — shown only after consent, while the
  //      backlog is being drained. Once that initial sweep completes,
  //      subsequent migrations (mobile app creating one new decimal doc
  //      here and there) run silently — they're too quick to bother.
  let   _uidMigrationInitialSweepDone = false;
  let   _uidMigrationModalOpen        = false;
  let   _uidMigrationInitialTotal     = 0;
  // User-consent gating — read at the start of every snapshot. Reset on
  // every sign-out / account switch / app launch, which is exactly what
  // we want: "Remind me later" defers for the current session only and
  // re-prompts on the next launch. No persistent snooze.
  let   _uidMigrationUserAccepted     = false;
  let   _uidMigrationDeferredThisSession = false;
  let   _uidMigrationConfirmOpen      = false;
  // Pure decimal string check. We exclude leading zeros (other than the
  // standalone "0") because a real BigInt's toString() never has them —
  // a leading zero would mean someone wrote a malformed id we shouldn't
  // touch.
  function isDecimalSpoolId(id) {
    return typeof id === "string" && /^\d+$/.test(id) && (id === "0" || id[0] !== "0");
  }
  function decimalSpoolIdToHex(decimal) {
    try { return BigInt(decimal).toString(16).toUpperCase(); }
    catch { return null; }
  }

  /* ── Rack-shape migration — flat → nested `rack` object ────────────────
     Same UX pattern as the UID migration: consent modal (Update now /
     Remind me later) → progress modal with bar → silent done state.
     Studio Manager is the SOLE client that touches rack data (the
     Flutter mobile app and TigerScale firmware ignore these fields)
     so the migration is safe to be destructive — we drop the legacy
     `rack_id`/`level`/`position` keys via FieldValue.delete().         */
  let _rackMigrationConfirmOpen        = false;
  let _rackMigrationDeferredThisSession = false;
  let _rackMigrationUserAccepted       = false;
  let _rackMigrationModalOpen          = false;
  let _rackMigrationInitialSweepDone   = false;
  let _rackMigrationInitialTotal       = 0;
  let _rackMigrationDraining           = false;
  let _rackMigrationStats              = { migrated: 0, failed: 0 };
  let _rackMigrationQueue              = []; // array of { spoolId, data }

  function maybeMigrateFlatRackToNested(ownerUid) {
    if (state.friendView) return;
    if (!ownerUid || !state.inventory) return;
    if (_rackMigrationDeferredThisSession) return;
    // Don't pile a second consent / progress modal on top of the UID
    // migration — wait for that one to finish first.
    if (_uidMigrationConfirmOpen || _uidMigrationModalOpen) return;

    // Find every doc still using the flat schema in the current snapshot.
    const flatDocs = [];
    for (const [spoolId, data] of Object.entries(state.inventory)) {
      if (!data) continue;
      const alreadyNested = data.rack && typeof data.rack === "object" && data.rack.id;
      if (alreadyNested) continue;
      if (!data.rack_id) continue;
      flatDocs.push({ spoolId, data });
    }
    if (flatDocs.length === 0) return;

    if (_rackMigrationUserAccepted) {
      // Already accepted — enqueue any newly-discovered flat docs and
      // (re-)kick the drain.
      let added = 0;
      for (const item of flatDocs) {
        if (_rackMigrationQueue.some(q => q.spoolId === item.spoolId)) continue;
        _rackMigrationQueue.push(item);
        added++;
      }
      if (!_rackMigrationInitialSweepDone &&
          !_rackMigrationModalOpen &&
          _rackMigrationQueue.length >= 3) {
        _rackMigrationInitialTotal = _rackMigrationQueue.length;
        showRackMigrationModal(_rackMigrationInitialTotal);
        _rackMigrationModalOpen = true;
      }
      if (_rackMigrationModalOpen && added > 0) {
        const completed = _rackMigrationStats.migrated + _rackMigrationStats.failed;
        _rackMigrationInitialTotal = Math.max(
          _rackMigrationInitialTotal,
          completed + _rackMigrationQueue.length
        );
        updateRackMigrationModalProgress(completed, _rackMigrationInitialTotal);
      }
      drainRackMigrationQueue(ownerUid);
      return;
    }
    // Not asked yet — show the consent modal.
    if (!_rackMigrationConfirmOpen) {
      showRackMigrationConfirmModal(flatDocs.length, ownerUid);
    }
  }

  // Consent modal — re-uses the UID migration overlay but rewrites the
  // title / message text from the rackMigr* i18n keys.
  function showRackMigrationConfirmModal(flatCount, ownerUid) {
    const overlay = $("uidMigrationConfirmOverlay");
    if (!overlay) return;
    _rackMigrationConfirmOpen = true;
    const titleEl   = $("uidMigrationConfirmTitle");
    const msgEl     = $("uidMigrationConfirmMsg");
    const remindBtn = $("uidMigrationConfirmRemind");
    const acceptBtn = $("uidMigrationConfirmAccept");
    const duration = formatMigrationDuration(flatCount);
    // Generic title/message — same as the UID migration prompt so the
    // user gets a consistent, reassuring experience whichever migration
    // is queued.
    if (titleEl)   titleEl.textContent   = t("migrationConfirmTitle");
    if (msgEl)     msgEl.textContent     = t("migrationConfirmMsg", { count: flatCount, duration });
    if (remindBtn) remindBtn.textContent = t("uidMigrConfirmRemind");
    if (acceptBtn) acceptBtn.textContent = t("uidMigrConfirmAccept");
    overlay.classList.add("open");

    const rebind = (id, handler) => {
      const old = $(id);
      if (!old) return;
      const fresh = old.cloneNode(true);
      old.parentNode.replaceChild(fresh, old);
      fresh.addEventListener("click", handler);
    };
    rebind("uidMigrationConfirmAccept", () => {
      _rackMigrationConfirmOpen = false;
      _rackMigrationUserAccepted = true;
      overlay.classList.remove("open");
      maybeMigrateFlatRackToNested(ownerUid);
    });
    rebind("uidMigrationConfirmRemind", () => {
      _rackMigrationConfirmOpen = false;
      _rackMigrationDeferredThisSession = true;
      overlay.classList.remove("open");
    });
  }

  // Progress modal — same overlay, rack-flavoured text.
  function showRackMigrationModal(total) {
    const overlay = $("uidMigrationOverlay");
    if (!overlay) return;
    overlay.classList.add("open");
    const card = overlay.querySelector(".uid-migr-card");
    card?.classList.remove("uid-migr--done");
    const titleEl = $("uidMigrationTitle");
    const msgEl   = $("uidMigrationMsg");
    const warnEl  = $("uidMigrationWarn");
    if (titleEl) titleEl.textContent = t("migrationProgressTitle");
    if (msgEl)   msgEl.textContent   = t("migrationProgressMsg");
    if (warnEl)  warnEl.textContent  = t("migrationProgressWarn");
    updateRackMigrationModalProgress(0, total);
    try { window.electronAPI?.setMigrationInFlight?.(true); } catch {}
  }
  function updateRackMigrationModalProgress(done, total) {
    const countEl = $("uidMigrationCount");
    const barEl   = $("uidMigrationBar");
    if (!countEl || !barEl) return;
    countEl.textContent = `${done} / ${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    barEl.style.width = `${pct}%`;
  }
  function hideRackMigrationModalWithSuccess() {
    const overlay = $("uidMigrationOverlay");
    if (!overlay) return;
    const card = overlay.querySelector(".uid-migr-card");
    card?.classList.add("uid-migr--done");
    updateRackMigrationModalProgress(_rackMigrationInitialTotal, _rackMigrationInitialTotal);
    try { window.electronAPI?.setMigrationInFlight?.(false); } catch {}
    setTimeout(() => {
      overlay.classList.remove("open");
      card?.classList.remove("uid-migr--done");
    }, 1800);
  }

  async function drainRackMigrationQueue(ownerUid) {
    if (_rackMigrationDraining) return;
    _rackMigrationDraining = true;
    const FV = firebase.firestore.FieldValue;
    const invRef = fbDb().collection("users").doc(ownerUid).collection("inventory");
    try {
      while (_rackMigrationQueue.length > 0) {
        if (state.activeAccountId !== ownerUid) break;
        if (state.friendView) break;
        const { spoolId, data } = _rackMigrationQueue.shift();
        try {
          const rack = {
            id: data.rack_id,
            level:    Number.isInteger(data.level)    ? data.level    : null,
            position: Number.isInteger(data.position) ? data.position : null
          };
          await invRef.doc(spoolId).update({
            rack,
            rack_id:  FV.delete(),
            level:    FV.delete(),
            position: FV.delete()
          });
          _rackMigrationStats.migrated++;
        } catch (e) {
          console.warn(`[rackMigration] ${spoolId} failed:`, e?.code, e?.message);
          _rackMigrationStats.failed++;
        }
        if (_rackMigrationModalOpen) {
          const completed = _rackMigrationStats.migrated + _rackMigrationStats.failed;
          updateRackMigrationModalProgress(completed, _rackMigrationInitialTotal);
        }
        const gapMs = _rackMigrationQueue.length > 50 ? 500 : 250;
        await new Promise(r => setTimeout(r, gapMs));
      }
    } finally {
      _rackMigrationDraining = false;
      if (_rackMigrationModalOpen && _rackMigrationQueue.length === 0) {
        _rackMigrationInitialSweepDone = true;
        _rackMigrationModalOpen = false;
        hideRackMigrationModalWithSuccess();
        console.log(`[rackMigration] initial sweep done — migrated:${_rackMigrationStats.migrated} failed:${_rackMigrationStats.failed}`);
      }
    }
  }

  function maybeMigrateDecimalSpoolIds(ownerUid) {
    if (state.friendView) return;
    if (!ownerUid || !state.inventory) return;
    // Consent gating — never enqueue or migrate without explicit user
    // acceptance. The user can defer this session ("Remind me later")
    // or accept ("Update now"). The deferred flag resets on sign-out /
    // account switch / app relaunch, so the prompt re-fires next session.
    if (_uidMigrationDeferredThisSession) return;
    // Count decimal docs visible in the current snapshot
    const decimalIds = [];
    for (const docId of Object.keys(state.inventory)) {
      if (isDecimalSpoolId(docId)) decimalIds.push(docId);
    }
    if (decimalIds.length === 0) return;
    // Branch 1 — user already accepted earlier in this session: just
    // enqueue any newly-discovered decimal docs (mobile app concurrent
    // writes) and let the drain run.
    if (_uidMigrationUserAccepted) {
      let queuedNow = 0;
      for (const docId of decimalIds) {
        if (_uidMigrationQueue.includes(docId)) continue;
        _uidMigrationQueue.push(docId);
        queuedNow++;
      }
      // First-sweep heuristic — only show the progress modal when the
      // backlog is non-trivial. Subsequent single-doc concurrent
      // migrations during the same session run silently.
      if (!_uidMigrationInitialSweepDone &&
          !_uidMigrationModalOpen &&
          _uidMigrationQueue.length >= 3) {
        _uidMigrationInitialTotal = _uidMigrationQueue.length;
        showUidMigrationModal(_uidMigrationInitialTotal);
        _uidMigrationModalOpen = true;
      }
      if (_uidMigrationModalOpen && queuedNow > 0) {
        const completed = _uidMigrationStats.migrated + _uidMigrationStats.skipped + _uidMigrationStats.failed;
        _uidMigrationInitialTotal = Math.max(
          _uidMigrationInitialTotal,
          completed + _uidMigrationQueue.length
        );
        updateUidMigrationModalProgress(completed, _uidMigrationInitialTotal);
      }
      drainUidMigrationQueue(ownerUid);
      return;
    }
    // Branch 2 — first time we discover decimal docs this session and
    // the user hasn't been asked yet: pop the consent modal. Until they
    // click "Update now", we don't enqueue anything.
    if (!_uidMigrationConfirmOpen) {
      showUidMigrationConfirmModal(decimalIds.length, ownerUid);
    }
  }

  // ── Phase 1 — consent modal ──────────────────────────────────────────
  // Estimated migration duration based on observed throughput (~0.75 s
  // per spool when the queue is small enough for the 250 ms politeness
  // gap, ~1.0 s per spool above the 50-spool threshold which triggers
  // the 500 ms gap). The estimate is rounded to a humane unit (whole
  // seconds below 60, whole minutes above) and pluralised via i18n.
  function estimateMigrationDurationSeconds(spoolCount) {
    if (spoolCount <= 0) return 0;
    if (spoolCount <= 50) return Math.round(spoolCount * 0.75);
    return Math.round(50 * 0.75 + (spoolCount - 50) * 1.0);
  }
  function formatMigrationDuration(spoolCount) {
    const sec = estimateMigrationDurationSeconds(spoolCount);
    if (sec < 60) {
      const n = Math.max(1, sec);   // never display "0 seconds"
      return t("uidMigrDurationSeconds", { n });
    }
    const minutes = Math.max(1, Math.round(sec / 60));
    return t("uidMigrDurationMinutes", { n: minutes });
  }

  function showUidMigrationConfirmModal(decimalCount, ownerUid) {
    const overlay = $("uidMigrationConfirmOverlay");
    if (!overlay) return;
    _uidMigrationConfirmOpen = true;
    // Title + buttons get translated from data-i18n via applyTranslations(),
    // but the message carries a `{{count}}` and a `{{duration}}` that we
    // can only resolve once we know the spool count, so we render it here.
    const titleEl = $("uidMigrationConfirmTitle");
    const msgEl   = $("uidMigrationConfirmMsg");
    const remindBtn = $("uidMigrationConfirmRemind");
    const acceptBtn = $("uidMigrationConfirmAccept");
    const duration = formatMigrationDuration(decimalCount);
    // Generic title/message — same wording whatever the migration. The
    // user only needs reassurance that data stays put + a count + an
    // ETA; what's actually being repackaged is irrelevant.
    if (titleEl)   titleEl.textContent   = t("migrationConfirmTitle");
    if (msgEl)     msgEl.textContent     = t("migrationConfirmMsg", { count: decimalCount, duration });
    if (remindBtn) remindBtn.textContent = t("uidMigrConfirmRemind");
    if (acceptBtn) acceptBtn.textContent = t("uidMigrConfirmAccept");
    overlay.classList.add("open");

    // Re-bind buttons every time we open. We replace the nodes with a
    // clone to drop any previously attached listener — simpler than
    // tracking handler references across multiple opens.
    const rebind = (id, handler) => {
      const old = $(id);
      if (!old) return;
      const fresh = old.cloneNode(true);
      old.parentNode.replaceChild(fresh, old);
      fresh.addEventListener("click", handler);
    };

    rebind("uidMigrationConfirmAccept", () => {
      _uidMigrationConfirmOpen = false;
      _uidMigrationUserAccepted = true;
      overlay.classList.remove("open");
      // Re-trigger the snapshot path so we enqueue + drain right away.
      maybeMigrateDecimalSpoolIds(ownerUid);
    });
    rebind("uidMigrationConfirmRemind", () => {
      _uidMigrationConfirmOpen = false;
      // Defer this session only — the prompt will re-fire on the next
      // app launch / sign-in (no persistent snooze).
      _uidMigrationDeferredThisSession = true;
      overlay.classList.remove("open");
    });
  }

  // ── Modal helpers — full lock-screen during the initial sweep ────────
  function showUidMigrationModal(total) {
    const overlay = $("uidMigrationOverlay");
    if (!overlay) return;
    overlay.classList.add("open");
    const card = overlay.querySelector(".uid-migr-card");
    card?.classList.remove("uid-migr--done");
    // Translate the static text via i18n on every open so a language
    // switch between sessions takes effect.
    const titleEl = $("uidMigrationTitle");
    const msgEl   = $("uidMigrationMsg");
    const warnEl  = $("uidMigrationWarn");
    // Generic progress copy — same modal whatever the underlying migration.
    if (titleEl) titleEl.textContent = t("migrationProgressTitle");
    if (msgEl)   msgEl.textContent   = t("migrationProgressMsg");
    if (warnEl)  warnEl.textContent  = t("migrationProgressWarn");
    updateUidMigrationModalProgress(0, total);
    // Tell main we're in flight so Cmd+Q gets a confirm dialog. Ignored
    // gracefully if running outside Electron (web build).
    try { window.electronAPI?.setMigrationInFlight?.(true); } catch {}
  }
  function updateUidMigrationModalProgress(done, total) {
    const countEl = $("uidMigrationCount");
    const barEl   = $("uidMigrationBar");
    if (!countEl || !barEl) return;
    countEl.textContent = `${done} / ${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    barEl.style.width = `${pct}%`;
  }
  function hideUidMigrationModalWithSuccess() {
    const overlay = $("uidMigrationOverlay");
    if (!overlay) return;
    const card = overlay.querySelector(".uid-migr-card");
    // Show "done" state for ~1.8 s so the user gets a clear "OK it's
    // finished" cue before we whisk the modal away.
    card?.classList.add("uid-migr--done");
    updateUidMigrationModalProgress(_uidMigrationInitialTotal, _uidMigrationInitialTotal);
    // Release the quit-block so future Cmd+Q goes through immediately.
    try { window.electronAPI?.setMigrationInFlight?.(false); } catch {}
    setTimeout(() => {
      overlay.classList.remove("open");
      card?.classList.remove("uid-migr--done");
    }, 1800);
  }

  async function drainUidMigrationQueue(ownerUid) {
    if (_uidMigrationDraining) return;
    _uidMigrationDraining = true;
    try {
      while (_uidMigrationQueue.length > 0) {
        // Bail out cleanly if the user switched account / signed out
        // mid-sweep — never write to a different user's data.
        if (state.activeAccountId !== ownerUid) break;
        if (state.friendView) break;
        const decimalId = _uidMigrationQueue.shift();
        try {
          await migrateOneSpoolDecimalToHex(ownerUid, decimalId);
        } catch (e) {
          console.warn("[uidMigration] failed", decimalId, e?.message || e);
          _uidMigrationStats.failed++;
        }
        // Live progress update on the modal (if it's up). Total may have
        // grown since we started thanks to mobile-app concurrent writes;
        // maybeMigrateDecimalSpoolIds bumped the total in that case.
        if (_uidMigrationModalOpen) {
          const completed = _uidMigrationStats.migrated + _uidMigrationStats.skipped + _uidMigrationStats.failed;
          updateUidMigrationModalProgress(completed, _uidMigrationInitialTotal);
        }
        // Politeness — small gap between writes so we don't burst the
        // user's per-second Firestore quota during initial backfill.
        // Adaptive: slow down further if the backlog is huge (the user
        // can't tell the difference between 50 spools/min and 100, but
        // we don't want to blow past Firestore's per-document write
        // throughput cap or the project's daily write quota).
        //
        // Per-migration cost: 1 doc.get() + 1 limit(2) query + 1 batch
        // commit (3-5 ops). Default cadence ≈ 4 spools/sec, halved when
        // the queue exceeds 50 to keep large user backlogs well-behaved.
        const gapMs = _uidMigrationQueue.length > 50 ? 500 : 250;
        await new Promise(r => setTimeout(r, gapMs));
      }
    } finally {
      _uidMigrationDraining = false;
      // First-sweep done — close the modal with a success state. Future
      // single-doc migrations during the same session run silently.
      if (_uidMigrationModalOpen && _uidMigrationQueue.length === 0) {
        _uidMigrationInitialSweepDone = true;
        _uidMigrationModalOpen = false;
        hideUidMigrationModalWithSuccess();
        console.log(`[uidMigration] initial sweep done — migrated:${_uidMigrationStats.migrated} skipped:${_uidMigrationStats.skipped} failed:${_uidMigrationStats.failed}`);
      }
    }
  }

  async function migrateOneSpoolDecimalToHex(ownerUid, decimalId) {
    const hexId = decimalSpoolIdToHex(decimalId);
    if (!hexId) {
      console.warn("[uidMigration] cannot convert", decimalId);
      _uidMigrationStats.failed++;
      return;
    }
    const db          = fbDb(ownerUid);
    const invRef      = db.collection("users").doc(ownerUid).collection("inventory");
    const mapRef      = db.collection("users").doc(ownerUid).collection("uidMigrationMap");
    const decimalRef  = invRef.doc(decimalId);
    const hexRef      = invRef.doc(hexId);

    // Re-read the decimal doc — it may have been migrated by another
    // client (mobile app on another device, etc.) since we queued it.
    const decimalSnap = await decimalRef.get();
    if (!decimalSnap.exists) {
      // Already deleted — just make sure the map entry is there in case
      // the previous migrator didn't write it, then move on.
      await mapRef.doc(decimalId).set({
        hex_uid:     hexId,
        migrated_at: firebase.firestore.FieldValue.serverTimestamp(),
        migrated_by: "studio-manager",
      }, { merge: true }).catch(() => {});
      _uidMigrationStats.skipped++;
      return;
    }

    const data = decimalSnap.data();
    // If twin_tag_uid is decimal, convert it too. The other side's doc
    // will get its own twin_tag_uid retargeted via the reverseTwins query
    // below, so the pair stays consistent.
    const newData = { ...data, uid: hexId };
    if (data.twin_tag_uid && isDecimalSpoolId(String(data.twin_tag_uid))) {
      newData.twin_tag_uid = decimalSpoolIdToHex(String(data.twin_tag_uid));
    }

    // Find every OTHER inventory doc whose twin_tag_uid pointed at this
    // decimal id — typically one (the twin partner) but theoretically zero
    // or more. limit(2) keeps the query polite vs. the soft-rollout
    // `request.query.limit` rule in firestore.rules and detects the
    // anomaly case where >1 docs reference the same id (data corruption).
    const reverseTwins = await invRef
      .where("twin_tag_uid", "==", decimalId)
      .limit(2)
      .get();

    const batch = db.batch();
    // merge:true so a partial decimal stub re-written by the mobile app
    // doesn't wipe fields we already migrated to hex. The hex doc keeps
    // the union of fields.
    batch.set(hexRef, newData, { merge: true });
    batch.set(mapRef.doc(decimalId), {
      hex_uid:     hexId,
      migrated_at: firebase.firestore.FieldValue.serverTimestamp(),
      migrated_by: "studio-manager",
    }, { merge: true });
    reverseTwins.forEach(twin => {
      // Skip the doc we're about to delete (would race with the delete)
      if (twin.id === decimalId) return;
      batch.update(twin.ref, { twin_tag_uid: hexId });
    });
    batch.delete(decimalRef);

    await batch.commit();
    _uidMigrationStats.migrated++;
    console.log(`[uidMigration] ${decimalId} → ${hexId}` +
      (reverseTwins.size > 0 ? ` (twins retargeted: ${reverseTwins.size})` : ""));
  }

  /* ── Firestore inventory subscription ── */
  function subscribeInventory(uid) {
    unsubscribeInventory();
    _unsubInventory = fbDb()
      .collection("users").doc(uid)
      .collection("inventory")
      .onSnapshot({ includeMetadataChanges: true }, snapshot => {
        // ── Defense-in-depth — ignore any owner-inventory snapshot that
        // arrives WHILE we're previewing a friend's inventory. Without this
        // guard, a snapshot buffered before the user clicked a friend chip
        // can fire mid-switch and overwrite state.inventory / state.rows
        // with the owner's data, making the previous (read-write) view
        // bleed through into the friend's (read-only) view. The primary
        // protection is unsubscribing in switchToFriendView, but Firestore
        // can deliver one last in-flight callback before the unsub takes
        // effect, hence this belt-and-braces check.
        if (state.friendView) return;
        // Native connection detection — no ping needed
        if (snapshot.metadata.fromCache) {
          setHealthOffline();
        } else {
          setHealthLive();
        }

        // Skip data re-processing on metadata-only updates (but never skip the first load)
        const wasLoading = state.invLoading;
        state.invLoading = false;
        if (!wasLoading && snapshot.docChanges().length === 0 && !snapshot.metadata.hasPendingWrites) return;
        const raw = {};
        snapshot.forEach(doc => { raw[doc.id] = doc.data(); });
        state.inventory = raw;
        state.rows = snapshot.docs.map(doc => normalizeRow(doc.id, doc.data()));
        // Factory-bug fix: link twin pairs whose chip timestamps drifted ≤ 2s.
        // Fire-and-forget — the resulting Firestore writes will trigger a fresh
        // snapshot which will then see twin_tag_uid filled on both sides.
        autoLinkTwinsByTimestamp(state.rows);
        // Auto-unstorage runs FIRST so depleted spools leave their slot
        // before auto-storage tries to re-place anyone there. Otherwise we'd
        // create a loop: unstore → snapshot → auto-store re-places same 0g
        // spool. Both paths are fire-and-forget; their resulting writes
        // trigger a fresh snapshot that re-renders.
        maybeAutoUnstoreDepletedSpools();
        maybeAutoStoreUnrankedSpools();
        // Lazy migration of decimal-format spool ids → hex uppercase.
        // Picks up any decimal doc the mobile app may have just created
        // and migrates it in the background. Idempotent + safe vs
        // concurrent mobile-app writes (see the function header).
        maybeMigrateDecimalSpoolIds(uid);
        // Lazy migration of flat `rack_id` / `level` / `position` →
        // grouped `rack: { id, level, position }` sub-object. Same
        // streaming pattern: idempotent, polite, twin-aware.
        maybeMigrateFlatRackToNested(uid);
        saveInventory(raw);
        preCacheImages(state.rows).then(() => {
          sortRows(); renderStats(); renderInventory();
          // Refresh open detail panel with latest data
          if (state.selected && $("detailPanel").classList.contains("open")) {
            openDetail(state.selected);
          }
          // Refresh racks panel if open (positions/fills may have changed)
          if ($("racksPanel")?.classList.contains("open")) renderRacksList();
        });
        setLoading($("btnSbReload"), false);
      }, err => {
        console.error("[Firestore] onSnapshot error:", err.code, err.message);
        state.invLoading = false;
        setHealthOffline();
        setLoading($("btnSbReload"), false);
      });
  }
  function unsubscribeInventory() {
    if (_unsubInventory) { _unsubInventory(); _unsubInventory = null; }
  }

  /* ── Firebase auth state → app state ── */

  // Common handler called when a named-instance user session becomes active.
  // uid must equal user.uid and be the current active account.
  async function handleSignedIn(user, uid) {
    unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales(); unsubscribePrinters();
    // Always reset friend-view mode on account change — the new account's own inventory is what we want to show.
    // We also clear the inventory/rows so the previous (friend) data isn't briefly shown as if it belonged to the new account.
    if (state.friendView) {
      state.friendView = null;
      state.inventory  = null;
      state.rows       = [];
      renderFriendBanner();
      // Close any open detail panel — its content was rendered for the friend and is now stale
      if ($("detailPanel")?.classList.contains("open")) closeDetail();
    }
    const email    = user.email       || "";
    const authName = user.displayName || "";
    const photo    = user.photoURL    || null;

    // Upsert account in localStorage
    const accounts = getAccounts();
    let acc = accounts.find(a => a.id === uid);
    if (!acc) {
      acc = { id: uid, email, displayName: "", photoURL: photo, lang: state.lang };
      accounts.push(acc);
      saveAccounts(accounts);
    } else {
      let changed = false;
      if (photo && acc.photoURL !== photo) { acc.photoURL = photo; changed = true; }
      if (changed) saveAccounts(accounts);
    }
    setActiveId(uid);

    // Save Google real name to Firestore (admin reference, never shown in UI)
    if (authName || email) {
      const parts = authName.trim().split(/\s+/);
      fbDb(uid).collection("users").doc(uid).set(
        { googleName: authName, firstName: parts[0]||"", lastName: parts.slice(1).join(" ")||"", email },
        { merge: true }
      ).catch(() => {});
    }

    // Restore language preference
    if (acc.lang && state.i18n[acc.lang]) {
      state.lang = acc.lang;
      localStorage.setItem("tigertag.lang", acc.lang);
      applyTranslations();
    }

    setConnected(acc.displayName || email, email);

    // Show cached inventory while Firestore connects
    try {
      const raw = JSON.parse(localStorage.getItem(invKey(uid)) || "null");
      if (raw && typeof raw === "object") {
        state.inventory = raw;
        state.rows = Object.entries(raw).map(([k,vv]) => normalizeRow(k, vv || {}));
        await preCacheImages(state.rows);
        sortRows(); renderStats(); renderInventory();
      }
    } catch {}

    subscribeInventory(uid);
    syncLangFromFirestore(uid);
    syncUserDoc(uid);
    subscribeFriendRequests(uid);
    loadFriendsList();  // populate state.friends early so dropdown + profiles modal show friends immediately
    loadBlacklist();    // populate state.blacklist for the Friends panel
    subscribeRacks(uid);// live-sync the user's storage racks
    subscribeScales(uid);// live-sync the user's TigerScale heartbeats
    subscribePrinters(uid);// live-sync the user's 3D printers across all 5 brand subcollections
  }

  // Track which account ids already have an onAuthStateChanged listener set up.
  const _namedAuthSetup = new Set();

  // Set up an independent Firebase auth listener for one account (named instance).
  function setupNamedAuth(uid) {
    if (_namedAuthSetup.has(uid)) return;
    _namedAuthSetup.add(uid);
    ensureFirebaseApp(uid);
    firebase.app(uid).auth().onAuthStateChanged(async user => {
      if (user && user.uid === uid) {
        // Session active or restored from IndexedDB
        if (uid === getActiveId()) await handleSignedIn(user, uid);
      } else if (uid === getActiveId()) {
        // Active account's session expired → show login
        unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales(); unsubscribePrinters();
        state.inventory = null; state.rows = [];
        state.isAdmin = false; state.debugEnabled = false;
        state.publicKey = null; state.privateKey = null;
        state.friends = []; state.friendRequests = []; state.blacklist = []; state.racks = []; state.printers = [];
        applyDebugMode(); renderStats(); renderInventory();
        renderAccountDropdown();
        setDisconnected();
        setTimeout(() => openAddAccountModal(), 300);
      }
    });
  }

  function initAuth() {
    // Restore named instances for all saved accounts (sessions auto-reload from IndexedDB)
    const accounts = getAccounts();
    for (const acc of accounts) setupNamedAuth(acc.id);

    // If no saved accounts, show login immediately
    if (!accounts.length) setTimeout(() => openAddAccountModal(), 300);
  }


  /* ── account section UI ── */
  function getInitials(a) {
    const src = a.displayName || a.email || "?";
    return src.split(/[\s@]+/).filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
  }

  function renderAccountList() {
    const el = $("profilesList"); if (!el) return;
    const accounts = getAccounts();
    const activeId = state.activeAccountId;
    const sorted = [...accounts].sort((a, b) => (b.id === activeId ? 1 : 0) - (a.id === activeId ? 1 : 0));
    const SVG_PLUS = `<span class="icon icon-plus icon-11"></span>`;
    const SVG_CHEVRON = `<span class="icon icon-chevron-r icon-14"></span>`;

    let html = "";
    if (!sorted.length) {
      html = `<div style="font-size:12px;color:var(--muted);padding:12px 0;text-align:center">${t("noAccounts")}</div>`;
    } else {
      html = `<div class="prf-list">${sorted.map(acc => {
        const name = esc(acc.displayName || acc.email.split("@")[0]);
        return `
        <button class="prf-account-card" data-prf-id="${esc(acc.id)}">
          <span class="prf-account-avatar" style="background:${getAccGradient(acc)};color:${readableTextOn(getAccShadow(acc))}">${esc(getInitials(acc))}</span>
          <span class="prf-account-info">
            <span class="prf-account-name">${name}</span>
            <span class="prf-account-email">${esc(acc.email)}</span>
          </span>
          <span class="prf-account-chevron">${SVG_CHEVRON}</span>
        </button>`;
      }).join("")}</div>`;
    }
    html += `<button class="stg-add-btn" id="btnShowAddAccount">${SVG_PLUS} ${t("addAccountLabel")}</button>`;

    // ── Friends section ───────────────────────────────────────────────────────
    const SVG_EYE = `<span class="icon icon-eye-on icon-13"></span>`;
    html += `<div class="prf-section-sep"></div>
      <div class="prf-section-label">${t("friendsList")}</div>`;
    if (state.friends && state.friends.length) {
      html += `<div class="prf-list">${state.friends.map(f => {
          const name = esc(f.displayName || f.uid);
          const color = friendColor(f);
          const fg = readableTextOn(color);
          const initials = (f.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
          const isActive = state.friendView?.uid === f.uid;
          return `
          <button class="prf-account-card prf-friend-card${isActive ? " prf-friend-active" : ""}"
                  data-fv-uid="${esc(f.uid)}" data-fv-name="${esc(f.displayName || f.uid)}" data-fv-color="${esc(color)}">
            <span class="prf-account-avatar" style="background:${color};color:${fg}">${initials}</span>
            <span class="prf-account-info">
              <span class="prf-account-name">${name}</span>
              <span class="prf-account-email prf-friend-sub">${t("friendViewInv")}</span>
            </span>
            <span class="prf-account-chevron">${SVG_EYE}</span>
          </button>`;
        }).join("")}</div>`;
    } else {
      html += `<div class="prf-friends-empty">${t("friendsEmpty")}</div>`;
    }
    // Always show the "Add a friend" button under the friends list
    html += `<button class="stg-add-btn" id="btnPrfAddFriend">${SVG_PLUS} ${t("friendsAdd")}</button>`;

    el.innerHTML = html;

    el.querySelectorAll("[data-prf-id]").forEach(card => {
      card.addEventListener("click", () => {
        const acc = getAccounts().find(a => a.id === card.dataset.prfId);
        if (acc) { closeProfilesModal(); openEditAccountModal(acc); }
      });
    });
    el.querySelectorAll("[data-fv-uid]").forEach(card => {
      card.addEventListener("click", () => {
        switchToFriendView(card.dataset.fvUid, card.dataset.fvName, card.dataset.fvColor);
      });
    });
    $("btnShowAddAccount").addEventListener("click", () => { closeProfilesModal(); openAddAccountModal(); });
    $("btnPrfAddFriend")?.addEventListener("click", () => { closeProfilesModal(); openAddFriendModal(); });
  }

  async function switchAccountUI(id) {
    if (id === state.activeAccountId) {
      // Even if active account didn't change, exit friend-view if user is in it
      if (state.friendView) switchBackToOwnView();
      closeProfilesModal(); closeSettings(); return;
    }
    // Always exit friend-view before switching accounts
    if (state.friendView) {
      state.friendView = null;
      renderFriendBanner();
    }
    // Check if the target account has an active named Firebase session
    let targetUser = null;
    try { targetUser = firebase.app(id).auth().currentUser; } catch (_) {}

    if (targetUser && targetUser.uid === id) {
      // Session alive — switch instantly, no re-authentication needed
      setActiveId(id);
      closeProfilesModal(); closeSettings();
      await handleSignedIn(targetUser, id);
    } else {
      // Session missing or expired — pre-select the account and ask for credentials
      setActiveId(id);
      closeProfilesModal(); closeSettings();
      setTimeout(() => openAddAccountModal(), 250);
    }
  }

  function deleteAccountUI(id) {
    let accounts = getAccounts();
    const wasActive = state.activeAccountId === id;
    accounts = accounts.filter(a => a.id !== id);
    saveAccounts(accounts);
    localStorage.removeItem(invKey(id));
    _namedAuthSetup.delete(id);
    // Sign out the named instance so its IndexedDB session is cleared
    try { firebase.app(id).auth().signOut(); } catch (_) {}
    if (wasActive) {
      unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales(); unsubscribePrinters();
      state.inventory = null; state.rows = [];
      state.isAdmin = false; state.debugEnabled = false;
      state.publicKey = null; state.privateKey = null;
      state.friends = []; state.friendRequests = []; state.blacklist = []; state.racks = []; state.printers = [];
      applyDebugMode(); renderStats(); renderInventory();
      setDisconnected();
      // Switch to another account if available, otherwise show login
      const remaining = getAccounts();
      if (remaining.length) {
        setActiveId(remaining[0].id);
        setupNamedAuth(remaining[0].id);
        const u = firebase.app(remaining[0].id).auth().currentUser;
        if (u) handleSignedIn(u, remaining[0].id);
        else setTimeout(() => openAddAccountModal(), 300);
      } else {
        state.activeAccountId = null;
        setTimeout(() => openAddAccountModal(), 300);
      }
    } else {
      renderAccountList();
    }
  }

  /* ── key status (state only — no DOM badge) ── */
  function setKeyStatus(s) {
    state.keyValid = (s === "ok") ? true : (s === "bad") ? false : null;
  }

  /* ── inventory load ── */
  function sortRows() {
    state.rows.sort((a, b) => {
      if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
      return a.uid.localeCompare(b.uid);
    });
  }
  // loadInventory: re-attaches the Firestore listener (called by the Refresh button).
  // The listener itself calls renderInventory/renderStats via onSnapshot.
  function loadInventory() {
    const uid = state.activeAccountId;
    if (!uid) return;
    setLoading($("btnSbReload"), true);
    subscribeInventory(uid); // re-subscribe; listener calls setLoading(false) on first snapshot
  }

  /* ── stats ── */
  function renderStats() {
    const all = deduplicateTwins(state.rows.slice()); const active = all.filter(r => !r.deleted);
    const plus = active.filter(r => r.isPlus);
    const totalW = active.reduce((s, r) => s + (Number(r.weightAvailable)||0), 0);
    const el = $("sbStats");
    if (!all.length) { el.classList.add("hidden"); return; }
    const kgFull = `${Math.round(totalW / 1000)} kg`;
    const kgMini = kgFull;
    el.innerHTML = [
      { label: t("statActive"), mini: t("statActiveMini"), value: active.length,            miniVal: active.length },
      { label: t("statTotal"),  mini: t("statTotalMini"),  value: kgFull,                    miniVal: kgMini },
      { label: t("statDiy"),    mini: t("statDiyMini"),    value: active.length-plus.length, miniVal: active.length-plus.length },
      { label: t("statPlus"),   mini: t("statPlusMini"),   value: plus.length,               miniVal: plus.length },
    ].map(s => `<div class="sb-stat" data-mini="${s.mini}" data-mini-val="${s.miniVal}"><div class="value">${s.value}</div><div class="label">${s.label}</div></div>`).join("");
    el.classList.remove("hidden");
  }

  /* ── filter ── */
  function deduplicateTwins(rows) {
    const skip = new Set();
    const result = [];
    for (const row of rows) {
      if (skip.has(row.spoolId)) continue;
      if (row.twinUid) {
        const twinId = String(row.twinUid);
        const twin = rows.find(r =>
          !skip.has(r.spoolId) &&
          r.spoolId !== row.spoolId &&
          (String(r.uid) === twinId || String(r.spoolId) === twinId)
        );
        if (twin) {
          row.hasTwinPair = true;
          skip.add(twin.spoolId);
        }
      }
      skip.add(row.spoolId);
      result.push(row);
    }
    return result;
  }

  /* ── Auto-link twin pairs broken by a known factory programmer bug ─────────
     The factory wrote thousands of chips where the two halves of a twin pair
     ended up with timestamps drifting by ≤ 2 seconds instead of being identical,
     which prevented twin_tag_uid from being set. We patch it client-side: when
     two unlinked rows share the same `id_tigertag` and their chip timestamps
     are within 2s, we write twin_tag_uid on BOTH docs in a single Firestore
     batch. Pairs already linked are left untouched (idempotent, breaks the
     snapshot→write→snapshot loop on the second pass). */
  const _twinAutoLinkAttempted = new Set();   // session memo: "uidA|uidB" sorted
  async function autoLinkTwinsByTimestamp(rows) {
    // Hard guards
    if (state.friendView) return;                // never write to a friend's docs
    const user = fbAuth().currentUser;
    if (!user) return;

    // Candidates: not deleted, no twin yet, must have both id_tigertag and timestamp
    const cand = rows.filter(r =>
      !r.deleted && !r.twinUid &&
      r.raw && r.raw.id_tigertag != null &&
      typeof r.chipTimestamp === "number"
    );
    if (cand.length < 2) return;

    // Group by id_tigertag
    const groups = new Map();
    for (const r of cand) {
      const k = String(r.raw.id_tigertag);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    // Walk consecutive pairs in time order; pair if |Δt| ≤ 2s and neither was paired yet
    const pairs = [];
    const usedSpoolIds = new Set();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.chipTimestamp - b.chipTimestamp);
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1];
        if (usedSpoolIds.has(a.spoolId) || usedSpoolIds.has(b.spoolId)) continue;
        const dt = Math.abs(b.chipTimestamp - a.chipTimestamp);
        if (dt > 2) continue;
        // Memoization key — sorted UID pair, never re-attempt this session
        const memoKey = [a.uid, b.uid].sort().join("|");
        if (_twinAutoLinkAttempted.has(memoKey)) continue;
        pairs.push({ a, b, dt, idtt: list[0].raw.id_tigertag });
        usedSpoolIds.add(a.spoolId); usedSpoolIds.add(b.spoolId);
        _twinAutoLinkAttempted.add(memoKey);
      }
    }
    if (!pairs.length) return;

    // Single batched write — twin_tag_uid on both sides + lastUpdate timestamp
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch  = fbDb().batch();
    const ts     = firebase.firestore.FieldValue.serverTimestamp();
    for (const { a, b, dt, idtt } of pairs) {
      batch.update(invRef.doc(a.spoolId), { twin_tag_uid: b.uid, last_update: ts });
      batch.update(invRef.doc(b.spoolId), { twin_tag_uid: a.uid, last_update: ts });
      console.log(`[twinAutoLink] paired uid=${a.uid} ↔ uid=${b.uid}  (id_tigertag=${idtt}, Δt=${dt}s)`);
    }
    try {
      await batch.commit();
      console.log(`[twinAutoLink] committed ${pairs.length} pair(s)`);
    } catch (err) {
      reportError("twinAutoLink", err);
      // Roll back the memo so a future snapshot can retry
      for (const { a, b } of pairs) {
        const memoKey = [a.uid, b.uid].sort().join("|");
        _twinAutoLinkAttempted.delete(memoKey);
      }
    }
  }

  /* ── Manual twin pairing — user-assisted repair tool ───────────────────
     The auto-linker (autoLinkTwinsByTimestamp) only pairs spools whose
     chip timestamps differ by ≤ 2 s. When the factory programmer left
     a wider gap, both halves of a real twin pair end up as separate
     inventory entries — and they stay separate forever because no
     batch above can prove they belong together. This trio of helpers
     gives the user a manual repair path:
       - findTwinCandidates(row)  → list of compatible peers (same
         brand / material / type / version / colour, not already paired,
         not deleted, not the source itself)
       - linkTwinPair(rowA, rowB) → write twin_tag_uid both ways in a
         single batch (same shape as the auto-linker, so the rest of
         the app — writeWithTwin, hasTwinPair, etc. — picks them up
         immediately on the next snapshot)
       - unlinkTwinPair(row)      → debug-only inverse operation,
         clears twin_tag_uid on both docs                           */
  function findTwinCandidates(row) {
    if (!row || !row.raw) return [];
    const src = row.raw;
    return state.rows.filter(r => {
      if (r.spoolId === row.spoolId) return false;     // not self
      if (r.deleted) return false;                     // not tombstoned
      if (r.twinUid) return false;                     // already paired (excluded per UX spec)
      if (!r.raw) return false;
      const o = r.raw;
      // Identity quartet — must all match for it to be the SAME spool model.
      if (o.id_brand    !== src.id_brand)    return false;
      if (o.id_material !== src.id_material) return false;
      if (o.id_type     !== src.id_type)     return false;
      if (o.id_tigertag !== src.id_tigertag) return false;
      // Colour — exact RGB triplet match. The factory writes identical
      // R/G/B on both halves of a twin pair so this is safe; a soft
      // tolerance would only invite false positives.
      if (o.color_r !== src.color_r) return false;
      if (o.color_g !== src.color_g) return false;
      if (o.color_b !== src.color_b) return false;
      return true;
    });
  }
  async function linkTwinPair(rowA, rowB) {
    if (!rowA || !rowB || rowA.spoolId === rowB.spoolId) return;
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch  = fbDb().batch();
    const ts     = firebase.firestore.FieldValue.serverTimestamp();
    batch.update(invRef.doc(rowA.spoolId), { twin_tag_uid: rowB.uid, last_update: ts });
    batch.update(invRef.doc(rowB.spoolId), { twin_tag_uid: rowA.uid, last_update: ts });
    await batch.commit();
    console.log(`[twinManualLink] paired uid=${rowA.uid} ↔ uid=${rowB.uid}`);
  }
  async function unlinkTwinPair(row) {
    if (!row) return;
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const twinId = twinSpoolIdOf(row);
    const batch  = fbDb().batch();
    const ts     = firebase.firestore.FieldValue.serverTimestamp();
    const clear  = { twin_tag_uid: firebase.firestore.FieldValue.delete(), last_update: ts };
    batch.update(invRef.doc(row.spoolId), clear);
    if (twinId) batch.update(invRef.doc(twinId), clear);
    await batch.commit();
    console.log(`[twinManualLink] unpaired spoolId=${row.spoolId}${twinId ? " ↔ " + twinId : ""}`);
  }

  function sortRows(rows) {
    if (!state.sortCol) return rows;
    const dir = state.sortDir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      let va = a[state.sortCol], vb = b[state.sortCol];
      if (va == null && vb == null) return 0;
      if (va == null) return dir;
      if (vb == null) return -dir;
      if (typeof va === "boolean") return dir * ((va ? 1 : 0) - (vb ? 1 : 0));
      if (typeof va === "number" && typeof vb === "number") return dir * (va - vb);
      return dir * String(va).localeCompare(String(vb), undefined, { sensitivity: "base" });
    });
  }

  function filteredRows() {
    let rows = state.rows.slice();
    if (!state.showDeleted) rows = rows.filter(r => !r.deleted);
    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter(r =>
        r.uid.toLowerCase().includes(q) ||
        String(r.material).toLowerCase().includes(q) ||
        String(r.brand).toLowerCase().includes(q) ||
        String(r.colorName).toLowerCase().includes(q)
      );
    }
    if (state.brandFilter) {
      rows = rows.filter(r => String(r.brand) === state.brandFilter);
    }
    if (state.materialFilter) {
      rows = rows.filter(r => String(r.material) === state.materialFilter);
    }
    if (state.typeFilter) {
      rows = rows.filter(r => String(r.productType) === state.typeFilter);
    }
    return sortRows(deduplicateTwins(rows));
  }

  // Refresh quick-filter dropdowns (brand + material) from the current inventory.
  // Preserves the user's current selection if it still exists.
  function populateQuickFilters() {
    populateOneQuickFilter({
      sel: $("brandFilter"),
      currentKey: "brandFilter",
      labelKey: "filterAllBrands",
      defaultLabel: "All brands",
      pickValue: r => r.brand,
    });
    populateOneQuickFilter({
      sel: $("materialFilter"),
      currentKey: "materialFilter",
      labelKey: "filterAllMaterials",
      defaultLabel: "All materials",
      pickValue: r => r.material,
    });
    populateOneQuickFilter({
      sel: $("typeFilter"),
      currentKey: "typeFilter",
      labelKey: "filterAllTypes",
      defaultLabel: "All types",
      pickValue: r => r.productType,
    });
  }
  function populateOneQuickFilter({ sel, currentKey, labelKey, defaultLabel, pickValue }) {
    if (!sel) return;
    const values = Array.from(new Set(
      state.rows
        .filter(r => !r.deleted)
        .map(pickValue)
        .filter(v => v && v !== "-")
        .map(v => String(v))
    )).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const current = state[currentKey];
    const allLabel = t(labelKey) || defaultLabel;
    sel.innerHTML = `<option value="" data-i18n="${labelKey}">${esc(allLabel)}</option>`
      + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (current && values.includes(current)) sel.value = current;
    else { sel.value = ""; state[currentKey] = ""; }
    sel.classList.toggle("is-active", !!state[currentKey]);
  }
  // Backwards-compat alias used in renderInventory()
  const populateBrandFilter = populateQuickFilters;

  /* ── render ── */
  function renderInventory() {
    populateBrandFilter();      // refresh dropdown options on every render
    const rows = filteredRows();
    renderFriendBanner();

    // ── Loading or truly empty → dedicated welcome card ──────────────────────
    // In friendView, keep card-inv visible so the banner stays; show spinner there
    if (state.invLoading || (state.inventory !== null && state.rows.length === 0)) {
      // ── Rack view priority — even when the friend's inventory is empty or
      // still loading, we MUST hand off to renderRackView() so it can clear
      // the previously-rendered rack DOM (the owner's own racks). Without
      // this, the previous user's racks bleed through and remain interactive.
      // renderRackView() handles its own empty/loading states gracefully.
      if (state.viewMode === "rack") {
        $("card-welcome").classList.add("hidden");
        $("card-inv").classList.remove("hidden");
        $("invTableWrap").classList.add("hidden");
        $("invGrid").classList.add("hidden");
        $("invEmpty").classList.add("hidden");
        $("mainResult").innerHTML = "";
        $("invRackView").classList.remove("hidden");
        $("invPrinterView")?.classList.add("hidden");
        renderRackView();
        return;
      }
      // Same defensive handoff for printer view — the printer collection is
      // independent from the inventory rows, so an empty/loading inventory
      // is still a perfectly valid moment to show the user's printers.
      if (state.viewMode === "printer") {
        $("card-welcome").classList.add("hidden");
        $("card-inv").classList.remove("hidden");
        $("invTableWrap").classList.add("hidden");
        $("invGrid").classList.add("hidden");
        $("invRackView")?.classList.add("hidden");
        $("invEmpty").classList.add("hidden");
        $("mainResult").innerHTML = "";
        $("invPrinterView").classList.remove("hidden");
        renderPrintersView();
        return;
      }
      if (state.friendView) {
        $("card-welcome").classList.add("hidden");
        $("card-inv").classList.remove("hidden");
        $("invTableWrap").classList.add("hidden"); $("invGrid").classList.add("hidden");
        $("invEmpty").classList.add("hidden");
        if (state.invLoading) {
          $("mainResult").innerHTML = `<div class="inv-loading"><div class="inv-loading-spin"></div><span>${t("invLoading")}</span></div>`;
        } else if (state.friendView.error) {
          $("mainResult").innerHTML = `
            <div class="friend-inv-error">
              <div class="friend-inv-error-icon">⚠</div>
              <div class="friend-inv-error-title">${t("friendInvErrorTitle")}</div>
              <div class="friend-inv-error-msg">${esc(state.friendView.error)}</div>
              <div class="friend-inv-error-hint">${t("friendInvErrorHint")}</div>
              <div class="friend-inv-error-actions">
                <button class="fie-btn" id="fieRetry">
                  <span class="icon icon-refresh icon-13"></span>
                  ${t("friendInvErrorRetry")}
                </button>
                <button class="fie-btn fie-btn--danger" id="fieRemove">
                  <span class="icon icon-trash icon-13"></span>
                  ${t("friendInvErrorRemove")}
                </button>
              </div>
            </div>`;
          $("fieRetry")?.addEventListener("click", () => {
            const fv = state.friendView;
            if (fv) switchToFriendView(fv.uid, fv.displayName, fv.avatarColor);
          });
          $("fieRemove")?.addEventListener("click", async () => {
            const fv = state.friendView;
            if (!fv) return;
            const btn = $("fieRemove");
            if (btn) btn.disabled = true;
            try {
              await removeFriend(fv.uid);
              await loadFriendsList();
              switchBackToOwnView();
            } catch (e) {
              console.error("[FriendView] remove failed:", e);
              if (btn) btn.disabled = false;
            }
          });
        } else {
          $("mainResult").innerHTML = "";
          $("invEmpty").textContent = t("noInventory");
          $("invEmpty").classList.remove("hidden");
        }
        return;
      }
      $("card-inv").classList.add("hidden");
      $("card-welcome").classList.remove("hidden");

      if (state.invLoading) {
        $("invWelcome").innerHTML = `<div class="inv-loading"><div class="inv-loading-spin"></div><span>${t("invLoading")}</span></div>`;
      } else {
        // Connected + 0 spools → Apple-style welcome with 2 QR cards
        const qrUniversal  = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https%3A%2F%2Ftaap.it%2FDF1Aqt&bgcolor=ffffff&color=1d1d1f&margin=16&qzone=1`;
        const qrTestflight = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https%3A%2F%2Ftestflight.apple.com%2Fjoin%2FjVHhmK4C&bgcolor=ffffff&color=1d1d1f&margin=16&qzone=1`;
        $("invWelcome").innerHTML = `
          <div class="inv-welcome">
            <div class="inv-welcome-hero">
              <div class="inv-welcome-logo inv-welcome-logo--framed">
                <img src="../assets/img/icon.png" alt="TigerTag" />
              </div>
              <h1 class="inv-welcome-h1">${t("invWelcomeTitle")}</h1>
              <p class="inv-welcome-p">${t("invWelcomeSub")}</p>
            </div>
            <div class="inv-welcome-grid">
              <!-- Card 1 : App Store + Google Play (lien universel taap.it) -->
              <div class="inv-qr-card">
                <div class="inv-qr-card-head inv-qr-card-head--dark">
                  <span class="icon icon-apple icon-13"></span>
                  <span class="icon icon-android icon-13"></span>
                  App Store &amp; Google Play
                </div>
                <div class="inv-qr-card-body">
                  <img class="inv-qr-img" src="${qrUniversal}" alt="QR" onerror="this.style.opacity='.15'" />
                  <div class="inv-qr-store-row">
                    <a class="inv-qr-store-pill" href="https://taap.it/DF1Aqt" target="_blank" rel="noopener">
                      <span class="icon icon-apple icon-12"></span> App Store
                    </a>
                    <a class="inv-qr-store-pill" href="https://taap.it/DF1Aqt" target="_blank" rel="noopener">
                      <span class="icon icon-android icon-12"></span> Google Play
                    </a>
                  </div>
                </div>
                <div class="inv-qr-card-foot">${t("invQrScanHint")}</div>
              </div>
              <!-- Card 2 : TestFlight beta -->
              <div class="inv-qr-card">
                <div class="inv-qr-card-head inv-qr-card-head--orange">
                  <span class="icon icon-apple icon-13"></span>
                  TestFlight
                  <span class="inv-qr-beta-badge">BETA</span>
                </div>
                <div class="inv-qr-card-body">
                  <img class="inv-qr-img" src="${qrTestflight}" alt="QR" onerror="this.style.opacity='.15'" />
                  <div class="inv-qr-store-row">
                    <a class="inv-qr-store-pill" href="https://testflight.apple.com/join/jVHhmK4C" target="_blank" rel="noopener">
                      <span class="icon icon-apple icon-12"></span> TestFlight
                    </a>
                  </div>
                </div>
                <div class="inv-qr-card-foot">${t("invQrBetaNote")}</div>
              </div>
            </div>
          </div>`;
      }
      return;
    }

    // ── Has spools → inventory card ───────────────────────────────────────────
    $("card-welcome").classList.add("hidden");
    $("card-inv").classList.remove("hidden");
    $("mainResult").innerHTML = "";  // clear any spinner left by friendView loading

    // Rack view bypasses the rows-empty short-circuit (a rack can be useful even with 0 spools).
    // In friend view this renders read-only — no edit / drag / drop / kebab.
    if (state.viewMode === "rack") {
      $("invTableWrap").classList.add("hidden");
      $("invGrid").classList.add("hidden");
      $("invEmpty").classList.add("hidden");
      $("invRackView").classList.remove("hidden");
      $("invPrinterView")?.classList.add("hidden");
      renderRackView();
      return;
    }
    $("invRackView").classList.add("hidden");

    // Printer view — same deal as rack, decoupled from spool rows.
    if (state.viewMode === "printer") {
      $("invTableWrap").classList.add("hidden");
      $("invGrid").classList.add("hidden");
      $("invEmpty").classList.add("hidden");
      $("invPrinterView").classList.remove("hidden");
      renderPrintersView();
      return;
    }
    $("invPrinterView")?.classList.add("hidden");

    // Filter returned no results
    if (rows.length === 0) {
      $("invTableWrap").classList.add("hidden"); $("invGrid").classList.add("hidden");
      $("invEmpty").textContent = t("noMatch");
      $("invEmpty").classList.remove("hidden");
      return;
    }

    $("invEmpty").classList.add("hidden");
    if (state.viewMode === "grid") {
      $("invTableWrap").classList.add("hidden"); $("invGrid").classList.remove("hidden"); renderGrid(rows);
    } else {
      $("invGrid").classList.add("hidden"); $("invTableWrap").classList.remove("hidden"); renderTable(rows);
    }
  }

  function colorBg(row) {
    const aspects = [row.aspect1, row.aspect2].map(a => (a || '').toLowerCase());
    const isRainbow  = aspects.some(a => a.includes('rainbow') || a.includes('multicolor'));
    const isTricolor = aspects.some(a => a.includes('tricolor') || a.includes('tri color') || a.includes('tricolore'));
    const isBicolor  = aspects.some(a => a.includes('bicolor')  || a.includes('bi color')  || a.includes('bicolore'));
    // Normalize each entry: strip optional # and 2-char alpha (only for 8-digit RRGGBBAA), add # for CSS
    const normalizeColor = c => {
      const s = (c || '').trim().replace(/^#/, '');
      const hex6 = s.length === 8 ? s.slice(0, 6) : s;
      return /^[0-9a-fA-F]{6}$/.test(hex6) ? `#${hex6}` : null;
    };
    const cls = (row.colorList || []).map(normalizeColor).filter(Boolean);
    const colorType = row.colorType || '';
    if (cls.length >= 2 && colorType === 'conic_gradient') {
      return `conic-gradient(from 0deg, ${cls.join(', ')}, ${cls[0]})`;
    } else if (cls.length >= 2 && colorType === 'gradient') {
      return `linear-gradient(90deg, ${cls.join(', ')})`;
    } else if (cls.length >= 2) {
      const step = 360 / cls.length;
      const stops = cls.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ');
      return `conic-gradient(${stops})`;
    } else if (cls.length === 1) {
      return cls[0];   // online_color_list mono — takes priority over RFID chip color
    } else if (isRainbow && isTricolor) {
      const [c1=`#ff4d4d`, c2=`#ffd93d`, c3=`#4da3ff`] = cls;
      return `linear-gradient(90deg, ${c1} 0%, ${c2} 50%, ${c3} 100%)`;
    } else if (isRainbow && isBicolor) {
      const [c1=`#ff7a00`, c2=`#8a2be2`] = cls;
      return `linear-gradient(90deg, ${c1} 0%, ${c2} 100%)`;
    } else if (isRainbow) {
      const colors = [row.colorHex, row.colorHex2, row.colorHex3].filter(Boolean);
      if (colors.length >= 2) return `linear-gradient(90deg, ${colors.join(', ')})`;
      if (colors.length === 1) return colors[0];
      return `linear-gradient(90deg, #ff0000, #ff8800, #ffff00, #00cc00, #0000ff, #8b00ff)`;
    } else if (isTricolor) {
      const colors = [row.colorHex, row.colorHex2, row.colorHex3].filter(Boolean);
      const [c1 = '#cccccc', c2 = '#888888', c3] = colors;
      const _c3 = c3 || c1;
      return `conic-gradient(${c1} 0deg 120deg, ${c2} 120deg 240deg, ${_c3} 240deg 360deg)`;
    } else if (isBicolor) {
      const colors = [row.colorHex, row.colorHex2, row.colorHex3].filter(Boolean);
      const [c1 = '#cccccc', c2 = '#ffffff'] = colors;
      return `conic-gradient(${c1} 0deg 180deg, ${c2} 180deg 360deg)`;
    } else {
      return row.colorHex || '#1c2030';
    }
  }

  function colorCircleHTML(row, size = 15) {
    const bg = colorBg(row);
    const borderColor = isColorDark(bg) ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
    return `<span class="color-circle" style="width:${size}px;height:${size}px;background:${bg};border-color:${borderColor}"></span>`;
  }

  // Returns true if the first color found in a CSS background string is dark.
  function isColorDark(bg) {
    const m = bg.match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/);
    if (!m) return false;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
  }

  // Dark bg → normal logo (white fill), light bg → contouring logo (black outline)
  function logoSrc(bg) {
    return isColorDark(bg) ? LOGO_PATH : LOGO_PATH_OUTLINE;
  }

  async function preCacheImages(rows) {
    if (!window.electronAPI?.imgGet) return;
    const urls = [...new Set(rows.map(r => r.imgUrl).filter(Boolean))];
    await Promise.all(urls.map(async url => {
      if (!state.imgCache.has(url)) {
        const local = await window.electronAPI.imgGet(url).catch(() => null);
        state.imgCache.set(url, local); // null = lien mort sans cache
      }
    }));
  }

  function resolvedImg(url) {
    if (!url) return null;
    return state.imgCache.has(url) ? state.imgCache.get(url) : url;
  }

  const SVG_TWIN_SMALL = `<span class="icon icon-link icon-9"></span>`;
  function twinOverlayBadge(r) {
    return r.hasTwinPair ? `<span class="thumb-twin-badge" title="${t('twinBadge')} — ${t('twinTitle')}">${SVG_TWIN_SMALL}</span>` : "";
  }
  function thumbHTML(row, size = 28) {
    const src = row.imgUrl ? resolvedImg(row.imgUrl) : null;
    const overlay = twinOverlayBadge(row);
    const tdBadge = row.td != null ? `<span class="thumb-td-badge">TD ${row.td}</span>` : "";
    const chipBadge = row.needUpdateAt ? `<span class="chip-badge thumb-chip-badge" title="${t("chipPendingHint")}"><span class="icon icon-refresh icon-9"></span></span>` : "";
    const inner = src
      ? `<img class="thumb" src="${esc(src)}" width="${size}" height="${size}" loading="lazy" />`
      : `<span class="thumb-color" style="width:${size}px;height:${size}px;background:${colorBg(row)}"><img src="${logoSrc(colorBg(row))}" /></span>`;
    return `<span class="thumb-wrap">${inner}${overlay}${tdBadge}${chipBadge}</span>`;
  }

  function renderTable(rows) {
    const tbody = $("invBody"); tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.dataset.id = r.spoolId;
      if (state.selected === r.spoolId) tr.classList.add("selected");
      if (r.deleted) tr.classList.add("deleted");
      const swatch = colorCircleHTML(r, 28);
      let wCell = "-";
      if (r.weightAvailable != null) {
        wCell = `${r.weightAvailable} g`;
        if (r.capacity) { const p = Math.max(0,Math.min(100,Math.round(r.weightAvailable/r.capacity*100))); wCell += `<span class="bar" title="${p}%"><span style="width:${p}%"></span></span>`; }
      }
      tr.innerHTML = `
        <td class="thumb-cell">${thumbHTML(r, 50)}</td>
        <td>${r.isPlus ? '<span class="tag-plus">TigerTag+</span>' : '<span class="tag-diy">TigerTag</span>'}</td>
        <td>${esc(v(r.material))}</td>
        <td>${esc(v(r.brand))}</td>
        <td class="color-cell">${swatch}</td>
        <td>${esc(v(r.colorName) !== "-" ? r.colorName : [r.aspect1, r.aspect2].filter(a => a && a !== "-" && a !== "None").join(" ") || r.colorName)}</td>
        <td style="font-variant-numeric:tabular-nums">${wCell}</td>
        <td style="font-variant-numeric:tabular-nums">${v(r.capacity)}${r.capacity!=null?" g":""}</td>
        <td title="${esc(fmtTs(r.lastUpdate))}">${esc(timeAgo(r.lastUpdate))}</td>`;
      tr.addEventListener("click", () => openDetail(r.spoolId));
      tbody.appendChild(tr);
    }
  }

  function renderGrid(rows) {
    const grid = $("invGrid"); grid.innerHTML = "";
    for (const r of rows) {
      const card = document.createElement("div");
      card.className = "spool-card" + (state.selected===r.spoolId?" selected":"") + (r.deleted?" deleted":"");
      card.dataset.id = r.spoolId;
      const _resolvedCard = r.imgUrl ? resolvedImg(r.imgUrl) : null;
      const imgHtml = _resolvedCard
        ? `<img class="card-img" src="${esc(_resolvedCard)}" loading="lazy" onerror="this.outerHTML='<div class=\\'card-img-color-placeholder\\'style=\\'background:${colorBg(r)}\\'><img src=\\'${logoSrc(colorBg(r))}\\'></div>'" />`
        : `<div class="card-img-color-placeholder" style="background:${colorBg(r)}"><img src="${logoSrc(colorBg(r))}" /></div>`;
      const pct = (r.weightAvailable != null && r.capacity) ? Math.max(0,Math.min(100,Math.round(r.weightAvailable/r.capacity*100))) : null;
      const swatch = colorCircleHTML(r);
      const badge = r.isPlus ? '<span class="tag-plus">TigerTag+</span>' : '<span class="tag-diy">TigerTag</span>';
      const tdBadge = r.td != null ? `<span class="card-td-badge">TD ${r.td}</span>` : "";
      const chipDot = r.needUpdateAt ? `<span class="chip-badge card-chip-badge" title="${t("chipPendingHint")}"><span class="icon icon-refresh icon-11"></span></span>` : "";
      card.innerHTML = `
        <div class="card-img-wrap">${imgHtml}${twinOverlayBadge(r)}${tdBadge}${chipDot}</div>
        <div class="card-body">
          <div class="card-name">${swatch}${esc(v(r.colorName) !== "-" ? r.colorName : [r.aspect1, r.aspect2].filter(a => a && a !== "-" && a !== "None").join(" ") || r.material)}</div>
          <div class="card-sub">${esc(v(r.material))} · ${esc(v(r.brand))}</div>
          <div class="card-footer">
            <span class="card-weight">${r.weightAvailable!=null ? r.weightAvailable+" g" : "-"}</span>
            <span style="display:flex;gap:3px;align-items:center">${badge}</span>
          </div>
          ${pct!==null ? `<div class="card-bar"><span style="width:${pct}%"></span></div>` : ""}
        </div>`;
      card.addEventListener("click", () => openDetail(r.spoolId));
      grid.appendChild(card);
    }
  }

  /* ── view toggle ── */
  function setViewMode(mode) {
    const prevMode = state.viewMode;
    state.viewMode = mode;
    localStorage.setItem("tigertag.view", mode);
    $("btnViewTable")?.classList.toggle("active", mode === "table");
    $("btnViewGrid")?.classList.toggle("active",  mode === "grid");
    $("btnViewRack")?.classList.toggle("active",  mode === "rack");
    $("btnViewPrinter")?.classList.toggle("active", mode === "printer");
    // Force-open + animate the side panel ONLY when transitioning INTO rack
    // mode from another view. Re-clicking Storage while already in Storage
    // is a no-op for the panel.
    if (mode === "rack" && prevMode !== "rack" && getUnrackedSpools().length > 0) {
      localStorage.setItem("tigertag.unrackedPanelOpen", "true");
      _unrackedAnimateOpen = true;
    }
    renderInventory();
    // Safety re-subscribe when switching to rack mode (handles users connected before this feature)
    if (mode === "rack" && !state.unsubRacks && state.activeAccountId) {
      subscribeRacks(state.activeAccountId);
    }
    // Safety re-subscribe when switching to printer mode (handles users connected before this feature)
    if (mode === "printer" && (!state.unsubPrinters || !state.unsubPrinters.length) && state.activeAccountId) {
      subscribePrinters(state.activeAccountId);
    }
  }
  $("btnViewTable").addEventListener("click", () => setViewMode("table"));
  $("btnViewGrid").addEventListener("click",  () => setViewMode("grid"));
  $("btnViewRack")?.addEventListener("click", () => setViewMode("rack"));
  $("btnViewPrinter")?.addEventListener("click", () => setViewMode("printer"));
  // Restore active button on boot
  if (state.viewMode === "grid") { $("btnViewGrid").classList.add("active"); $("btnViewTable").classList.remove("active"); }
  else if (state.viewMode === "rack") { $("btnViewRack")?.classList.add("active"); $("btnViewTable").classList.remove("active"); }
  else if (state.viewMode === "printer") { $("btnViewPrinter")?.classList.add("active"); $("btnViewTable").classList.remove("active"); }

  $("searchInv").addEventListener("input", e => { state.search = e.target.value.trim(); renderInventory(); });
  $("brandFilter")?.addEventListener("change", e => {
    state.brandFilter = e.target.value;
    e.target.classList.toggle("is-active", !!state.brandFilter);
    renderInventory();
  });
  $("materialFilter")?.addEventListener("change", e => {
    state.materialFilter = e.target.value;
    e.target.classList.toggle("is-active", !!state.materialFilter);
    renderInventory();
  });
  $("typeFilter")?.addEventListener("change", e => {
    state.typeFilter = e.target.value;
    e.target.classList.toggle("is-active", !!state.typeFilter);
    renderInventory();
  });

  function updateSortIndicators() {
    document.querySelectorAll("th.sortable").forEach(th => {
      th.classList.toggle("sort-asc",  state.sortCol === th.dataset.sort && state.sortDir === "asc");
      th.classList.toggle("sort-desc", state.sortCol === th.dataset.sort && state.sortDir === "desc");
    });
  }
  document.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      if (state.sortCol === th.dataset.sort) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortCol = th.dataset.sort;
        state.sortDir = "asc";
      }
      updateSortIndicators();
      renderInventory();
    });
  });

  /* ── detail panel ── */
  function openDetail(spoolId) {
    state.selected = spoolId;
    document.querySelectorAll("[data-id]").forEach(el => el.classList.toggle("selected", el.dataset.id === spoolId));
    const r = state.rows.find(x => x.spoolId === spoolId);
    if (!r) return;
    $("panelBody").innerHTML = buildPanelHTML(r);
    // Hold-to-confirm "Mark as deleted" — same 1.5s pattern as the rack delete.
    // Sets `deleted: true` (matches the mobile semantics — the spool then
    // appears in Settings → Debug → Deleted where it can be restored).
    setupHoldToConfirm($("btnSpoolDelete"), 1500, async () => {
      try {
        await markSpoolDeleted(r.spoolId);
        closeDetail();
      } catch (e) { reportError("spool.markDeleted", e); }
    });

    // Manual twin-pair repair button — opens the picker pre-filtered to
    // candidates compatible with this spool. Only present when the spool
    // is not already part of a twin pair (the panel render gates this).
    $("btnTwinLink")?.addEventListener("click", () => openTwinLinkPicker(r));

    // Debug-only "Unlink" — undoes a twin pairing. Same 1.5s hold-to-
    // confirm pattern used elsewhere for non-trivial actions.
    setupHoldToConfirm($("btnTwinUnlink"), 1500, async () => {
      try {
        await unlinkTwinPair(r);
      } catch (e) { reportError("spool.twinUnlink", e); }
    });

    // ── Toolbox actions ─────────────────────────────────────────────
    // TD1S — measure colour. If the device isn't connected we open
    // the connect modal first; once it's connected the colour-edit
    // modal is the natural next step.
    $("btnToolMeasureColor")?.addEventListener("click", () => {
      if (!state.td1sConnected) { openTd1sConnectModal(); return; }
      openColorEditModal(r);
    });
    // TD1S — measure TD. Same pattern as the colour tool.
    $("btnToolMeasureTd")?.addEventListener("click", () => {
      if (!state.td1sConnected) { openTd1sConnectModal(); return; }
      openTdEditModal(r);
    });
    // Remove from rack — hold-to-confirm so an accidental tap doesn't
    // unrank a placed spool. Reuses the eject animation that void-drop
    // fires so the visual language stays consistent.
    setupHoldToConfirm($("btnToolRemoveFromRack"), 1500, async () => {
      try {
        // Snapshot the row before async — state.rows might rebuild
        // between the await and the animation trigger.
        const snapshot = { ...r };
        // Fire the eject animation FIRST (covers the gap until the
        // Firestore listener rebuilds the rack view), then unassign.
        playUnrankAnimation(snapshot).catch(() => {});
        await unassignSpool(r.spoolId);
        closeDetail();
      } catch (e) { reportError("spool.removeFromRack", e); }
    });
    // Locate-in-storage: clicking the placed-state storage-loc row jumps
    // to the Storage view with the search prefilled to the spool's RFID
    // UID, so all other slots are dimmed and the user sees this one in
    // its rack at a glance.
    $("btnLocateSpool")?.addEventListener("click", () => {
      const uid = $("btnLocateSpool")?.dataset.spoolUid || "";
      // Close the detail panel + reset selection so a re-click opens it
      closeDetail();
      // Apply the search to the global state + UI
      const searchInput = $("searchInv");
      if (searchInput) searchInput.value = uid;
      state.search = uid;
      // Switch view (forces a fresh rack render that calls applyRackSearchDim)
      setViewMode("rack");
    });
    // Auto-assign: place the spool in the first available unlocked slot.
    // Triggered from the storage-loc empty-state row when no rack assignment.
    $("btnStorageAutoAssign")?.addEventListener("click", async () => {
      const btn = $("btnStorageAutoAssign");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      try {
        const result = await autoAssignSingleSpool(r.spoolId);
        if (!result) {
          // Out of slots — surface a small inline error in the row
          const row = btn.closest(".storage-loc-row");
          if (row) {
            const lbl = row.querySelector(".storage-loc-rack");
            if (lbl) {
              const orig = lbl.textContent;
              lbl.textContent = t("storageAutoAssignFull") || "All racks are full.";
              lbl.classList.add("storage-loc-rack--err");
              setTimeout(() => {
                lbl.textContent = orig;
                lbl.classList.remove("storage-loc-rack--err");
              }, 2500);
            }
          }
        }
        // Snapshot listener will re-render the panel with the new location.
      } catch (e) {
        reportError("spool.autoAssign", e);
      } finally {
        setTimeout(() => { if (btn) btn.disabled = false; }, 800);
      }
    });
    // collapsible "Details" section — toggle + persist preference
    const btnToggleDetails = $("btnToggleDetails");
    if (btnToggleDetails) {
      btnToggleDetails.addEventListener("click", () => {
        const section = btnToggleDetails.closest(".panel-details");
        const open = section.classList.toggle("open");
        localStorage.setItem("tigertag.detailsExpanded", open ? "1" : "0");
      });
    }
    // copy raw JSON button
    const btnCopyRaw = $("btnCopyRaw");
    if (btnCopyRaw) {
      btnCopyRaw.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        const pre = $("rawJsonPre");
        const text = pre.textContent;
        navigator.clipboard.writeText(text).then(() => {
          btnCopyRaw.classList.add("copied");
          setTimeout(() => btnCopyRaw.classList.remove("copied"), 1800);
        });
      });
    }
    // twin raw JSON tab switching
    $("panelBody").querySelectorAll("[data-raw-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        $("panelBody").querySelectorAll("[data-raw-tab]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const pre = $("rawJsonPre");
        const raw = decodeURIComponent(btn.dataset.rawTab === "a" ? pre.dataset.rawA : pre.dataset.rawB);
        pre.innerHTML = highlight(raw);
      });
    });
    // video button — YouTube thumbnail opens in browser
    const panelVideoBtn = $("panelVideoBtn");
    if (panelVideoBtn) {
      panelVideoBtn.addEventListener("click", () => {
        window.open(panelVideoBtn.dataset.url);
      });
    }

    $("detailPanel").classList.add("open"); $("panelOverlay").classList.add("open");
    // slider ↔ display ↔ inline edit
    const slider  = $("weightSlider");
    const fill    = $("wbFill");
    const display = $("sliderDisplay");
    const cap     = Number(slider.max);

    function syncFromValue(val) {
      const w = Math.max(0, Math.min(val, cap));
      slider.value = w;
      fill.style.width = cap ? Math.round(w / cap * 100) + "%" : "0%";
      display.innerHTML = `${w}<span>g</span>`;
      // Keep inline input in sync if open
      const inp = $("wbInlineInput");
      if (inp && !$("wbInlineEdit").classList.contains("hidden")) inp.value = w;
    }

    // Cancel any pending auto-save from a previous panel open
    clearTimeout(_sliderDebounce); _sliderDebounce = null;

    function cancelSliderDebounce() {
      clearTimeout(_sliderDebounce); _sliderDebounce = null;
      fill.classList.remove("wb-saving");
    }

    function openInlineEdit() {
      cancelSliderDebounce();
      $("sliderDisplay").classList.add("hidden");
      $("wbEditOpen").classList.add("hidden");
      $("wbInlineEdit").classList.remove("hidden");
      $("wbInlineInput").value = slider.value;
      $("wbInlineInput").focus();
      $("wbInlineInput").select();
    }
    function closeInlineEdit() {
      $("sliderDisplay").classList.remove("hidden");
      $("wbEditOpen").classList.remove("hidden");
      $("wbInlineEdit").classList.add("hidden");
    }
    function confirmInlineEdit() {
      const val = $("wbInlineInput").value;
      closeInlineEdit();
      syncFromValue(Number(val) || 0);
      doWeightUpdate(r, "direct", val);
    }

    slider.addEventListener("input", () => {
      syncFromValue(Number(slider.value));
      // Debounced auto-save: wait 500 ms of inactivity, then write to Firestore
      clearTimeout(_sliderDebounce);
      fill.classList.add("wb-saving");
      _sliderDebounce = setTimeout(() => {
        fill.classList.remove("wb-saving");
        _sliderDebounce = null;
        doWeightUpdate(r, "direct", slider.value);
      }, 500);
    });

    $("wbEditOpen").addEventListener("click", openInlineEdit);
    $("wbInlineConfirm").addEventListener("click", confirmInlineEdit);
    $("wbInlineCancel").addEventListener("click", closeInlineEdit);
    $("wbInlineInput").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); confirmInlineEdit(); }
      if (e.key === "Escape") closeInlineEdit();
    });

    if ($("btnChangeContainerCard")) {
      $("btnChangeContainerCard").addEventListener("click", () => openContainerPicker(r));
      // JS hover — shows both edit-container and edit-weight buttons on hover
      const ccSec = document.querySelector(".cc-section");
      const ccBtn = $("btnChangeContainerCard");
      if (ccSec && ccBtn) {
        ccSec.addEventListener("mouseenter", () => {
          ccBtn.classList.add("cc-visible");
          if ($("btnEditCw")) $("btnEditCw").classList.add("cc-visible");
        });
        ccSec.addEventListener("mouseleave", () => {
          ccBtn.classList.remove("cc-visible");
          if ($("btnEditCw")) $("btnEditCw").classList.remove("cc-visible");
        });
      }
    }

    // Inline container weight edit
    if ($("btnEditCw")) {
      const openCwEdit = () => {
        $("ccCwVal").style.display = "none";
        $("btnEditCw").style.display = "none";
        $("ccCwEditRow").style.display = "flex";
        $("ccCwInput").focus();
        $("ccCwInput").select();
      };
      const closeCwEdit = () => {
        $("ccCwVal").style.display = "";
        $("btnEditCw").style.display = "";
        $("ccCwEditRow").style.display = "none";
      };
      const confirmCwEdit = async () => {
        const val = parseInt($("ccCwInput").value, 10);
        if (isNaN(val) || val < 0) return;
        const uid = state.activeAccountId; if (!uid) return;
        const okBtn = $("ccCwOk"); if (okBtn) okBtn.disabled = true;
        try {
          await fbDb().collection("users").doc(uid).collection("inventory").doc(r.spoolId).update({
            container_weight: val,
            last_update:      Date.now()
          });
          // onSnapshot propagates change and re-renders the panel automatically
        } catch (e) {
          console.error("[CW edit] update error:", e);
          if (okBtn) okBtn.disabled = false;
        }
      };
      $("btnEditCw").addEventListener("click", openCwEdit);
      $("ccCwOk").addEventListener("click", confirmCwEdit);
      $("ccCwCancel").addEventListener("click", closeCwEdit);
      $("ccCwInput").addEventListener("keydown", e => {
        if (e.key === "Enter")  { e.preventDefault(); confirmCwEdit(); }
        if (e.key === "Escape") closeCwEdit();
      });
    }

    // TD edit chip
    if ($("btnEditTd")) {
      $("btnEditTd").addEventListener("click", () => openTdEditModal(r));
    }
    // Color circle → open color edit modal
    if ($("btnEditColor")) {
      $("btnEditColor").addEventListener("click", () => openColorEditModal(r));
    }
    // Chip done → clear needUpdateAt (and twin)
    if ($("btnChipDone")) {
      $("btnChipDone").addEventListener("click", async () => {
        const uid = state.activeAccountId; if (!uid) return;
        $("btnChipDone").disabled = true;
        const invRef = fbDb().collection("users").doc(uid).collection("inventory");
        try {
          const batch = fbDb().batch();
          batch.update(invRef.doc(r.spoolId), { needUpdateAt: null });
          if (r.twinUid) {
            const tr = state.rows.find(x =>
              x.spoolId !== r.spoolId &&
              (String(x.uid) === String(r.twinUid) || String(x.spoolId) === String(r.twinUid))
            );
            if (tr) batch.update(invRef.doc(tr.spoolId), { needUpdateAt: null });
          }
          await batch.commit();
        } catch (err) {
          console.error("[chipDone] error:", err);
          $("btnChipDone").disabled = false;
        }
      });
    }
  }
  function closeDetail() {
    // Cancel any pending auto-save (don't fire on close)
    clearTimeout(_sliderDebounce); _sliderDebounce = null;
    // Stop any playing video
    const vp = $("panelVideoPlayer"); if (vp) vp.innerHTML = "";
    $("detailPanel").classList.remove("open"); $("panelOverlay").classList.remove("open");
  }

  /* ── shared helpers ── */
  // Clamp TD value to valid range [0.1 – 100], returns null if not a number
  function _tdValClamp(v) {
    const n = parseFloat(v);
    if (isNaN(n)) return null;
    return Math.min(100, Math.max(0.1, n));
  }
  function _tdClampInput(el) {
    if (!el || el.value === "") return;
    const clamped = _tdValClamp(el.value);
    if (clamped !== null) el.value = clamped;
  }
  function _tdClampLive(el) {
    if (!el) return;
    // Strip any character that isn't a digit, dot, or comma; then convert comma → dot.
    // TD values are always stored with a dot decimal separator (no commas).
    const cleaned = el.value
      .replace(/[^\d.,]/g, "")   // keep only digits, dot, comma
      .replace(/,/g, ".")        // convert comma → dot
      .replace(/(\..*)\./g, "$1"); // collapse multiple dots into one
    if (cleaned !== el.value) {
      const pos = el.selectionStart;
      el.value = cleaned;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
    }
    if (el.value === "") return;
    const n = parseFloat(el.value);
    if (!isNaN(n) && n > 100) el.value = 100;
  }
  function _readHex(inputId) {
    const raw = ($(`${inputId}`)?.value || "").replace(/^#/, "").trim();
    return /^[0-9A-Fa-f]{6}$/.test(raw) ? raw.toUpperCase() : null;
  }
  // Block e/E/+/- keys on number inputs; call saveFn on Enter
  const _blockBadKeys = (e, saveFn) => {
    if (["e", "E", "+", "-"].includes(e.key)) { e.preventDefault(); return; }
    if (e.key === "Enter") saveFn();
  };
  // Generic modal-state setter reused by both TD and Color modals
  function _setEditState(ids, s) {
    // ids: { disc, active, waitRow, spinner, waitMsg }
    $(ids.disc).classList.toggle("td-edit-hidden",   s !== "disconnected");
    $(ids.active).classList.toggle("td-edit-hidden", s === "disconnected");
    if (s !== "disconnected") {
      $(ids.waitRow).classList.remove("td-edit-hidden");
      const sp = $(ids.spinner);
      if (sp) sp.classList.toggle("td-edit-hidden", s === "result");
      const msg = $(ids.waitMsg);
      if (msg) {
        if (s === "result") { msg.removeAttribute("data-i18n"); msg.textContent = t("tdEditScannedMsg"); }
        else { msg.setAttribute("data-i18n", "tdEditWaitMsg"); msg.textContent = t("tdEditWaitMsg"); }
      }
    }
  }
  // Generic Firestore save: writes TD and/or HEX color to a spool + its twin
  // Fields that live on the physical RFID chip — editing them requires re-tagging the spool
  const CHIP_FIELDS = ["TD", "online_color_list"];

  async function _saveTdHex(row, update, lockBtns, unlockBtns, closeFn, tag) {
    if (!row) return;
    const uid = state.activeAccountId; if (!uid) return;
    lockBtns.forEach(b => { if (b) b.disabled = true; });
    // If any chip field is being changed, flag the spool for re-tagging
    if (CHIP_FIELDS.some(f => f in update)) update.needUpdateAt = Date.now();
    const invRef = fbDb().collection("users").doc(uid).collection("inventory");
    try {
      const batch = fbDb().batch();
      batch.update(invRef.doc(row.spoolId), update);
      let twin = false;
      if (row.twinUid) {
        const tr = state.rows.find(r =>
          r.spoolId !== row.spoolId &&
          (String(r.uid) === String(row.twinUid) || String(r.spoolId) === String(row.twinUid))
        );
        if (tr) { batch.update(invRef.doc(tr.spoolId), { ...update }); twin = true; }
      }
      await batch.commit();
      closeFn();
      console.log(`[${tag}] saved`, update, twin ? "(twin)" : "");
    } catch (err) {
      console.error(`[${tag}] save error:`, err);
      unlockBtns.forEach(b => { if (b) b.disabled = false; });
    }
  }

  /* ── TD Edit modal ── */
  let _tdEditRow     = null;
  let _tdEditWaiting = false;
  let _tdEditData    = null;

  const _tdIds = { disc: "tdEditStateDisconnected", active: "tdEditStateActive",
                   waitRow: "tdEditWaitRow", spinner: "tdEditSpinner", waitMsg: "tdEditWaitMsg" };

  function openTdEditModal(r) {
    _tdEditRow = r; _tdEditWaiting = false; _tdEditData = null;
    $("tdEditModalOverlay").classList.add("open");
    window.td1s?.need();
    _setEditState(_tdIds, state.td1sConnected ? "waiting" : "disconnected");
    if (state.td1sConnected) _tdEditWaiting = true;
  }

  function closeTdEditModal() {
    _tdEditRow = _tdEditData = null; _tdEditWaiting = false;
    [$("tdEditBtnTdOnly"), $("tdEditBtnAll"), $("tdEditManualSaveBtn")].forEach(b => { if (b) b.disabled = false; });
    $("tdEditModalOverlay").classList.remove("open");
    ["tdEditManualInput","tdEditHexInput","tdEditTdInput"].forEach(id => { const el = $(id); if (el) el.value = ""; });
    const c = $("tdEditCircle"); if (c) c.style.background = "#2a2a2a";
    const sp = $("tdEditSpinner"); if (sp) sp.classList.remove("td-edit-hidden");
    const msg = $("tdEditWaitMsg"); if (msg) { msg.setAttribute("data-i18n","tdEditWaitMsg"); msg.textContent = t("tdEditWaitMsg"); }
    window.td1s?.release();
  }

  function _tdEditReceiveData(data) {
    _tdEditWaiting = false; _tdEditData = data;
    const hex = (data.HEX || "").replace(/^#/, "");
    const c = $("tdEditCircle"); if (c) c.style.background = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : "#888";
    const hi = $("tdEditHexInput"); if (hi) hi.value = hex ? `#${hex.toUpperCase()}` : "";
    const ti = $("tdEditTdInput");  if (ti) ti.value  = data.TD != null ? data.TD : "";
    _setEditState(_tdIds, "result");
  }

  function _tdEditSaveTdOnly() {
    const tdVal = _tdValClamp($("tdEditTdInput")?.value);
    if (tdVal === null) { $("tdEditTdInput")?.focus(); return; }
    _saveTdHex(_tdEditRow, { TD: tdVal, last_update: Date.now() },
      [$("tdEditBtnTdOnly"), $("tdEditBtnAll")], [$("tdEditBtnTdOnly"), $("tdEditBtnAll")],
      closeTdEditModal, "TD edit");
  }
  function _tdEditSaveAll() {
    const tdVal = _tdValClamp($("tdEditTdInput")?.value);
    if (tdVal === null) { $("tdEditTdInput")?.focus(); return; }
    const hexVal = _readHex("tdEditHexInput");
    const update = { TD: tdVal, last_update: Date.now() };
    if (hexVal) update.online_color_list = [hexVal];
    _saveTdHex(_tdEditRow, update,
      [$("tdEditBtnTdOnly"), $("tdEditBtnAll")], [$("tdEditBtnTdOnly"), $("tdEditBtnAll")],
      closeTdEditModal, "TD edit");
  }
  function _tdEditSaveManual() {
    const tdVal = _tdValClamp($("tdEditManualInput")?.value);
    if (tdVal === null) { $("tdEditManualInput")?.focus(); return; }
    _saveTdHex(_tdEditRow, { TD: tdVal, last_update: Date.now() },
      [$("tdEditManualSaveBtn")], [$("tdEditManualSaveBtn")],
      closeTdEditModal, "TD edit manual");
  }

  // Event listeners — TD modal
  $("tdEditClose").addEventListener("click", closeTdEditModal);
  $("tdEditBtnTdOnly").addEventListener("click", _tdEditSaveTdOnly);
  $("tdEditBtnAll").addEventListener("click", _tdEditSaveAll);
  $("tdEditManualSaveBtn").addEventListener("click", _tdEditSaveManual);
  $("tdEditManualInput").addEventListener("keydown", e => _blockBadKeys(e, _tdEditSaveManual));
  $("tdEditManualInput").addEventListener("blur",  () => _tdClampInput($("tdEditManualInput")));
  $("tdEditManualInput").addEventListener("input", () => _tdClampLive($("tdEditManualInput")));
  $("tdEditHexInput").addEventListener("input", () => {
    const hex = ($("tdEditHexInput").value || "").replace(/^#/, "");
    const c = $("tdEditCircle");
    if (c) c.style.background = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : "#2a2a2a";
  });
  $("tdEditTdInput").addEventListener("keydown", e => _blockBadKeys(e, _tdEditSaveTdOnly));
  $("tdEditTdInput").addEventListener("blur",  () => _tdClampInput($("tdEditTdInput")));
  $("tdEditTdInput").addEventListener("input", () => _tdClampLive($("tdEditTdInput")));
  $("tdEditModalOverlay").addEventListener("click", e => { if (e.target === $("tdEditModalOverlay")) closeTdEditModal(); });

  /* ── Color Edit modal ── */
  let _colorEditRow     = null;
  let _colorEditWaiting = false;
  let _colorEditData    = null;

  const _ceIds = { disc: "colorEditStateDisconnected", active: "colorEditStateActive",
                   waitRow: "colorEditWaitRow", spinner: "colorEditSpinner", waitMsg: "colorEditWaitMsg" };

  function _ceSetSwatch(hex6) {
    const sw = $("colorEditSwatch");
    const np = $("colorEditNativePicker");
    const hi = $("colorEditManualHex");
    const valid = /^[0-9A-Fa-f]{6}$/.test(hex6);
    if (sw) sw.style.background = valid ? `#${hex6}` : "#2a2a2a";
    if (np && valid) np.value = `#${hex6}`;
    if (hi) hi.value = valid ? `#${hex6.toUpperCase()}` : "";
  }

  function openColorEditModal(r) {
    _colorEditRow = r; _colorEditWaiting = false; _colorEditData = null;
    // Pre-fill swatch + hex input with current spool color
    const cur = (r.colorList && r.colorList[0])
      ? r.colorList[0].replace(/^#/, "").replace(/FF$/i, "").toUpperCase() : "";
    _ceSetSwatch(cur);
    const ci = $("colorEditCircle"); if (ci) ci.style.background = /^[0-9A-Fa-f]{6}$/.test(cur) ? `#${cur}` : "#2a2a2a";
    $("colorEditModalOverlay").classList.add("open");
    window.td1s?.need();
    _setEditState(_ceIds, state.td1sConnected ? "waiting" : "disconnected");
    if (state.td1sConnected) _colorEditWaiting = true;
  }

  function closeColorEditModal() {
    _colorEditRow = _colorEditData = null; _colorEditWaiting = false;
    [$("colorEditBtnColorOnly"),$("colorEditBtnAll"),$("colorEditManualSaveBtn")].forEach(b => { if (b) b.disabled = false; });
    $("colorEditModalOverlay").classList.remove("open");
    ["colorEditHexInput","colorEditTdInput"].forEach(id => { const el = $(id); if (el) el.value = ""; });
    const sw = $("colorEditSwatch"); if (sw) sw.style.background = "#2a2a2a";
    const np = $("colorEditNativePicker"); if (np) np.value = "#000000";
    const mh = $("colorEditManualHex"); if (mh) mh.value = "";
    const ci = $("colorEditCircle"); if (ci) ci.style.background = "#2a2a2a";
    const sp = $("colorEditSpinner"); if (sp) sp.classList.remove("td-edit-hidden");
    const msg = $("colorEditWaitMsg"); if (msg) { msg.setAttribute("data-i18n","tdEditWaitMsg"); msg.textContent = t("tdEditWaitMsg"); }
    window.td1s?.release();
  }

  function _colorEditReceiveData(data) {
    _colorEditWaiting = false; _colorEditData = data;
    const hex = (data.HEX || "").replace(/^#/, "");
    const ci = $("colorEditCircle"); if (ci) ci.style.background = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : "#888";
    const hi = $("colorEditHexInput"); if (hi) hi.value = hex ? `#${hex.toUpperCase()}` : "";
    const ti = $("colorEditTdInput");  if (ti) ti.value  = data.TD != null ? data.TD : "";
    _setEditState(_ceIds, "result");
  }

  function _colorEditSaveColorOnly() {
    const hexVal = _readHex("colorEditHexInput");
    if (!hexVal) { $("colorEditHexInput")?.focus(); return; }
    _saveTdHex(_colorEditRow, { online_color_list: [hexVal], last_update: Date.now() },
      [$("colorEditBtnColorOnly"),$("colorEditBtnAll")], [$("colorEditBtnColorOnly"),$("colorEditBtnAll")],
      closeColorEditModal, "Color edit");
  }
  function _colorEditSaveAll() {
    const hexVal = _readHex("colorEditHexInput");
    if (!hexVal) { $("colorEditHexInput")?.focus(); return; }
    const tdVal  = _tdValClamp($("colorEditTdInput")?.value);
    const update = { online_color_list: [hexVal], last_update: Date.now() };
    if (tdVal !== null) update.TD = tdVal;
    _saveTdHex(_colorEditRow, update,
      [$("colorEditBtnColorOnly"),$("colorEditBtnAll")], [$("colorEditBtnColorOnly"),$("colorEditBtnAll")],
      closeColorEditModal, "Color edit");
  }
  function _colorEditSaveManual() {
    const hexVal = _readHex("colorEditManualHex");
    if (!hexVal) { $("colorEditManualHex")?.focus(); return; }
    _saveTdHex(_colorEditRow, { online_color_list: [hexVal], last_update: Date.now() },
      [$("colorEditManualSaveBtn")], [$("colorEditManualSaveBtn")],
      closeColorEditModal, "Color edit manual");
  }

  // Event listeners — Color modal
  $("colorEditClose").addEventListener("click", closeColorEditModal);
  $("colorEditBtnColorOnly").addEventListener("click", _colorEditSaveColorOnly);
  $("colorEditBtnAll").addEventListener("click", _colorEditSaveAll);
  $("colorEditManualSaveBtn").addEventListener("click", _colorEditSaveManual);
  // Swatch click → open native color picker
  $("colorEditSwatch").addEventListener("click", () => $("colorEditNativePicker").click());
  // Native picker change → sync swatch + text input
  $("colorEditNativePicker").addEventListener("input", e => {
    const hex = e.target.value.replace(/^#/, "").toUpperCase();
    const sw = $("colorEditSwatch"); if (sw) sw.style.background = `#${hex}`;
    const hi = $("colorEditManualHex"); if (hi) hi.value = `#${hex}`;
  });
  // Text HEX input → sync swatch + native picker
  $("colorEditManualHex").addEventListener("input", () => {
    const hex = ($("colorEditManualHex").value || "").replace(/^#/, "");
    const valid = /^[0-9A-Fa-f]{6}$/.test(hex);
    const sw = $("colorEditSwatch"); if (sw) sw.style.background = valid ? `#${hex}` : "#2a2a2a";
    const np = $("colorEditNativePicker"); if (np && valid) np.value = `#${hex}`;
  });
  // State 2: HEX input live-updates big circle
  $("colorEditHexInput").addEventListener("input", () => {
    const hex = ($("colorEditHexInput").value || "").replace(/^#/, "");
    const ci = $("colorEditCircle");
    if (ci) ci.style.background = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : "#2a2a2a";
  });
  $("colorEditTdInput").addEventListener("keydown", e => _blockBadKeys(e, _colorEditSaveColorOnly));
  $("colorEditTdInput").addEventListener("blur",  () => _tdClampInput($("colorEditTdInput")));
  $("colorEditTdInput").addEventListener("input", () => _tdClampLive($("colorEditTdInput")));
  $("colorEditModalOverlay").addEventListener("click", e => { if (e.target === $("colorEditModalOverlay")) closeColorEditModal(); });

  /* ── TD1S connect modal ── */
  let _td1sConnectOpen = false;

  function openTd1sConnectModal() {
    _td1sConnectOpen = true;
    $("td1sConnectModalOverlay").classList.add("open");
    if (!state.td1sConnected) window.td1s?.need();
  }

  function closeTd1sConnectModal() {
    _td1sConnectOpen = false;
    $("td1sConnectModalOverlay").classList.remove("open");
    window.td1s?.release();
  }

  $("td1sConnectClose").addEventListener("click", closeTd1sConnectModal);
  $("td1sConnectCancelBtn").addEventListener("click", closeTd1sConnectModal);
  $("td1sConnectModalOverlay").addEventListener("click", e => {
    if (e.target === $("td1sConnectModalOverlay")) closeTd1sConnectModal();
  });

  /* ── TD1S tester modal ── */
  let _td1sTesterOpen = false;

  function openTd1sTesterModal() {
    _td1sTesterOpen = true;
    // Reset display fields
    const circle = $("td1sTesterCircle");
    const hexIn  = $("td1sTesterHex");
    const tdIn   = $("td1sTesterTd");
    if (circle) circle.style.background = "#2a2a2a";
    if (hexIn)  hexIn.value  = "";
    if (tdIn)   tdIn.value   = "";
    $("td1sTesterOverlay").classList.add("open");
    window.td1s?.need();
  }

  function closeTd1sTesterModal() {
    _td1sTesterOpen = false;
    $("td1sTesterOverlay").classList.remove("open");
    window.td1s?.release();
  }

  $("td1sTesterClose").addEventListener("click", closeTd1sTesterModal);
  $("td1sTesterOverlay").addEventListener("click", e => {
    if (e.target === $("td1sTesterOverlay")) closeTd1sTesterModal();
  });

  $("td1sHealth")?.addEventListener("click", () => {
    if (state.td1sConnected) { openTd1sTesterModal(); return; }
    if (!state.td1sConnected) openTd1sConnectModal();
  });

  /* ── twin-link picker ──────────────────────────────────────────────────
     Manual repair flow for twin spool pairs the auto-linker missed.
     Opens with a list of candidates returned by findTwinCandidates(),
     each rendered as a clickable card. A click triggers linkTwinPair
     directly — no confirmation step (the action is reversible via
     debug Unlink, and the candidate list is already strict). */
  let _twinLinkSrc = null;
  function openTwinLinkPicker(srcRow) {
    if (!srcRow) return;
    _twinLinkSrc = srcRow;
    const sub  = $("twinLinkPickerSub");
    const list = $("twinLinkPickerList");
    const empty = $("twinLinkPickerEmpty");
    if (sub) sub.textContent = t("twinLinkPickerSub")
                            || "Pick the matching half of this spool.";
    const cands = findTwinCandidates(srcRow);
    if (list) list.innerHTML = "";
    if (empty) empty.hidden = cands.length > 0;
    if (cands.length && list) {
      for (const c of cands) {
        const node = document.createElement("button");
        node.type = "button";
        node.className = "twin-link-card";
        // Use the same colour rendering helper the inventory list does
        // so the candidate visually reads as the same product as the
        // source — same colour swatch + brand + material text.
        const swatch = `<span class="twin-link-card-swatch" style="background:${colorBg(c)}"></span>`;
        const subText = [c.colorName, c.material].filter(s => s && s !== "-").join(" · ");
        node.innerHTML = `
          ${swatch}
          <span class="twin-link-card-main">
            <span class="twin-link-card-title">${esc(c.brand || "—")}</span>
            <span class="twin-link-card-sub">${esc(subText || c.uid)}</span>
            <span class="twin-link-card-uid">${esc(c.uid)}</span>
          </span>
          <span class="icon icon-chevron-r icon-13 twin-link-card-chev"></span>
        `;
        node.addEventListener("click", async () => {
          if (node.classList.contains("is-loading")) return;
          node.classList.add("is-loading");
          try {
            await linkTwinPair(srcRow, c);
            closeTwinLinkPicker();
          } catch (e) {
            reportError("spool.twinLink", e);
            node.classList.remove("is-loading");
          }
        });
        list.appendChild(node);
      }
    }
    $("twinLinkPickerOverlay").classList.add("open");
  }
  function closeTwinLinkPicker() {
    $("twinLinkPickerOverlay")?.classList.remove("open");
    _twinLinkSrc = null;
  }
  $("twinLinkPickerClose")?.addEventListener("click", closeTwinLinkPicker);
  $("twinLinkPickerOverlay")?.addEventListener("click", e => {
    if (e.target.id === "twinLinkPickerOverlay") closeTwinLinkPicker();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("twinLinkPickerOverlay")?.classList.contains("open")) {
      closeTwinLinkPicker();
    }
  });

  /* ── container picker ── */
  let _cpRow = null; // spool row currently being edited in the picker

  function openContainerPicker(r) {
    _cpRow = r;
    _renderCpList("");
    $("containerPickerSearch").value = "";
    $("containerPickerOverlay").classList.add("open");
    setTimeout(() => $("containerPickerSearch").focus(), 120);
  }
  function closeContainerPicker() {
    $("containerPickerOverlay").classList.remove("open");
    _cpRow = null;
  }
  function _renderCpList(query) {
    const q = query.trim().toLowerCase();
    const containers = (state.db.containers || []).filter(c =>
      !q ||
      c.brand.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.type.toLowerCase().includes(q) ||
      String(c.container_weight).includes(q)
    );
    // Group by brand
    const byBrand = {};
    containers.forEach(c => { (byBrand[c.brand] = byBrand[c.brand] || []).push(c); });
    const currentId = _cpRow?.containerId;
    const html = Object.entries(byBrand).map(([brand, items]) => `
      <div class="cp-group-label">${esc(brand)}</div>
      ${items.map(c => `
        <button class="cp-item${c.id === currentId ? " active" : ""}" data-cid="${esc(c.id)}">
          <img src="${esc(c.img)}" alt="${esc(c.label)}" onerror="this.style.display='none'" />
          <div class="cp-item-info">
            <div class="cp-item-name">${esc(c.label)}</div>
            <div class="cp-item-meta">${esc(c.type)}</div>
          </div>
          <span class="cp-item-cw">${c.container_weight} g</span>
          ${c.id === currentId ? '<span class="cp-check">✓</span>' : ""}
        </button>
      `).join("")}
    `).join("");
    $("containerPickerList").innerHTML = html || `<div class="cp-empty">—</div>`;
  }
  async function doContainerUpdate(r, newContainerId) {
    const uid = state.activeAccountId; if (!uid) return;
    const c = containerFind(newContainerId); if (!c) return;
    try {
      await fbDb().collection("users").doc(uid).collection("inventory").doc(r.spoolId).update({
        container_id:     newContainerId,
        container_weight: c.container_weight,
        last_update:      Date.now()
      });
      closeContainerPicker();
      // onSnapshot propagates change; detail panel refreshes automatically
    } catch (e) {
      console.error("[Container] update error:", e);
    }
  }

  function parseVideoUrl(url) {
    if (!url) return null;
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/);
    if (yt) return { type: "youtube", id: yt[1] };
    if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return { type: "direct", src: url };
    return { type: "external", src: url };
  }
  $("panelOverlay").addEventListener("click", closeDetail);
  document.addEventListener("keydown", e => { if (e.key==="Escape") { closeDetail(); closeContainerPicker(); } });

  // container picker events
  $("containerPickerClose").addEventListener("click", closeContainerPicker);
  $("containerPickerOverlay").addEventListener("click", e => { if (e.target === $("containerPickerOverlay")) closeContainerPicker(); });
  $("containerPickerSearch").addEventListener("input", e => _renderCpList(e.target.value));
  $("containerPickerList").addEventListener("click", e => {
    const btn = e.target.closest(".cp-item[data-cid]");
    if (btn && _cpRow) doContainerUpdate(_cpRow, btn.dataset.cid);
  });

  function buildPanelHTML(r) {
    const mat = r.materialData;

    // image + badge overlay
    const badgeLeft = r.isPlus
      ? '<span class="tag-plus panel-img-badge panel-img-badge--tl">TigerTag+</span>'
      : '<span class="tag-diy panel-img-badge panel-img-badge--tl">TigerTag</span>';
    const badgeTwin = r.hasTwinPair
      ? `<span class="tag-twin panel-img-badge-tr-item panel-img-icon-badge" title="${t("twinBadge")} — ${t("twinTitle")}"><span class="icon icon-link icon-11"></span></span>`
      : "";
    const badgeChip = r.needUpdateAt
      ? `<span class="chip-badge panel-img-badge-tr-item panel-img-icon-badge" title="${t("chipPendingHint")}"><span class="icon icon-refresh icon-11"></span></span>`
      : "";
    const badgeTd = r.td != null
      ? `<span class="panel-img-badge panel-img-badge--bl panel-td-badge">TD ${r.td}</span>`
      : "";
    const badgeTrGroup = (badgeTwin || badgeChip)
      ? `<div class="panel-img-badge panel-img-badge--tr panel-img-badge-tr-group">${badgeTwin}${badgeChip}</div>`
      : "";
    const overlays = badgeLeft + badgeTrGroup + badgeTd;
    let imgSection = "";
    const _resolvedPanel = r.imgUrl ? resolvedImg(r.imgUrl) : null;
    if (_resolvedPanel) {
      imgSection = `<div class="panel-img-wrap">${overlays}<img class="panel-img" src="${esc(_resolvedPanel)}" onerror="this.outerHTML='<div class=\\'panel-img-color-placeholder\\'style=\\'background:${colorBg(r)}\\'><img src=\\'${logoSrc(colorBg(r))}\\'class=\\'panel-img-logo\\'></div>'" /></div>`;
    } else {
      imgSection = `<div class="panel-img-wrap">${overlays}<div class="panel-img-color-placeholder" style="background:${colorBg(r)}"><img src="${logoSrc(colorBg(r))}" class="panel-img-logo" /></div></div>`;
    }

    // colors — same circle design as table rows
    const colorsHtml = colorCircleHTML(r, 56);

    // print settings — renamed local var to avoid shadowing t()
    const temps = r.temps;
    const hasDirect = temps.nozzleMin || temps.nozzleMax || temps.bedMin || temps.bedMax || temps.dryTemp || temps.dryTime;
    const rec = mat && mat.recommended;
    // TD chip — editable only when viewing own inventory
    const tdChipEl = state.friendView
      ? `<div class="temp-chip">
          <div class="tc-label">TD</div>
          <div class="tc-value">${r.td != null ? r.td : "—"}</div>
        </div>`
      : `<div class="temp-chip temp-chip--editable" id="btnEditTd" title="${t("tdEditTitle")}">
          <div class="tc-label">TD</div>
          <div class="tc-value">${r.td != null ? r.td : `<span class="tc-add">${t("tdNotSet")}</span>`}</div>
        </div>`;

    let tempHtml = "";
    {
      const nozzle = temps.nozzleMin && temps.nozzleMax ? `${temps.nozzleMin}–${temps.nozzleMax} °C`
                   : rec ? `${rec.nozzleTempMin}–${rec.nozzleTempMax} °C` : "—";
      const bed    = temps.bedMin && temps.bedMax ? `${temps.bedMin}–${temps.bedMax} °C`
                   : rec ? `${rec.bedTempMin}–${rec.bedTempMax} °C` : "—";
      const dryT   = temps.dryTemp ? `${temps.dryTemp} °C` : rec ? `${rec.dryTemp} °C` : "—";
      const dryH   = temps.dryTime ? `${temps.dryTime} h`  : rec ? `${rec.dryTime} h`  : "—";
      const density = mat && mat.density ? `<div style="margin-top:8px;font-size:12px;color:var(--muted)">${t("lbDensity")}: ${mat.density} g/cm³</div>` : "";
      const tempChips = (hasDirect || rec) ? `
          <div class="temp-chip"><div class="tc-label">${t("lbNozzle")}</div><div class="tc-value">${nozzle}</div></div>
          <div class="temp-chip"><div class="tc-label">${t("lbBed")}</div><div class="tc-value">${bed}</div></div>
          <div class="temp-chip"><div class="tc-label">${t("lbDryTemp")}</div><div class="tc-value">${dryT}</div></div>
          <div class="temp-chip"><div class="tc-label">${t("lbDryTime")}</div><div class="tc-value">${dryH}</div></div>` : "";
      tempHtml = `
      <div class="panel-section">
        <div class="panel-label">${t("sectionPrint")}</div>
        <div class="temp-grid">${tempChips}${tdChipEl}</div>
        ${density}
      </div>`;
    }

    // info badges (Refill / Recycled / Filled)
    const infoBadges = [
      r.isRefill   ? t("badgeRefill")   : null,
      r.isRecycled ? t("badgeRecycled") : null,
      r.isFilled   ? t("badgeFilled")   : null,
    ].filter(Boolean);
    const infoHtml2 = infoBadges.length ? `<div class="aspect-chips" style="margin-top:8px">${infoBadges.map(b=>`<span class="aspect-chip">${b}</span>`).join("")}</div>` : "";

    // video player (YouTube thumbnail→browser OR direct MP4 inline)
    const videoInfo = parseVideoUrl(r.links.youtube);
    let videoHtml = "";
    if (videoInfo) {
      if (videoInfo.type === "youtube") {
        // YouTube: embed bloqué (err 153) → miniature cliquable, s'ouvre dans le navigateur
        const thumb = `https://img.youtube.com/vi/${esc(videoInfo.id)}/hqdefault.jpg`;
        videoHtml = `
      <div class="panel-video-section">
        <button class="panel-yt-thumb" id="panelVideoBtn" data-url="${esc(r.links.youtube)}">
          <img src="${thumb}" alt="YouTube" loading="lazy" onerror="this.style.display='none'" />
          <div class="pvt-play"><span class="icon icon-play icon-22" style="background-color:#fff;margin-left:3px"></span></div>
        </button>
      </div>`;
      } else if (videoInfo.type === "direct") {
        // MP4/WebM direct → lecteur inline immédiat, pleine largeur
        videoHtml = `
      <div class="panel-video-section">
        <div class="panel-video-player">
          <video src="${esc(videoInfo.src)}" controls></video>
        </div>
      </div>`;
      }
      // type "external" → link-btn géré dans linkDefs ci-dessous
    }

    // doc links (MSDS, TDS, RoHS, REACH, food — video handled separately above)
    const SVG_PDF = `<span class="icon icon-pdf icon-13" style="width:11px"></span>`;
    const linkDefs = [
      { key: "msds",  label: "MSDS" },
      { key: "tds",   label: "TDS" },
      { key: "rohs",  label: "RoHS" },
      { key: "reach", label: "REACH" },
      { key: "food",  label: t("linkFood") },
      ...(videoInfo?.type === "external" ? [{ key: "youtube", label: t("linkYt") }] : []),
    ];
    const activeLinks = linkDefs.filter(l => r.links[l.key]);
    const linksHtml = activeLinks.length ? `
      <div class="panel-section">
        <div class="panel-label">${t("sectionLinks")}</div>
        <div class="links-row">${activeLinks.map(l => `<a class="link-btn" href="${esc(r.links[l.key])}" target="_blank" rel="noopener">${SVG_PDF}${l.label}</a>`).join("")}</div>
      </div>` : "";

    // weight
    const cap = r.capacity || 1000;
    const curW = r.weightAvailable != null ? r.weightAvailable : 0;
    const weightHtml = state.friendView ? `
      <div class="panel-section">
        <div class="panel-label">${t("sectionWeight")}</div>
        <div class="weight-bar-wrap">
          <div class="wb-labels">
            <div class="wb-val-group">
              <div class="wb-val">${curW}<span>g</span></div>
            </div>
            <div class="wb-cap">${cap >= 1000 ? (cap/1000).toFixed(cap % 1000 === 0 ? 0 : 1) + ' kg' : cap + ' g'} total</div>
          </div>
          <div class="wb-track wb-track--ro">
            <div class="wb-fill" style="width:${Math.round(curW/cap*100)}%"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:5px">
            <span>0 g</span><span>${cap} g</span>
          </div>
        </div>
      </div>` : `
      <div class="panel-section">
        <div class="panel-label">${t("sectionWeight")}</div>
        <div class="weight-bar-wrap">
          <div class="wb-labels">
            <div class="wb-val-group">
              <div class="wb-val" id="sliderDisplay">${curW}<span>g</span></div>
              <button id="wbEditOpen" class="wb-edit-open" title="${t("btnEditManually")}">
                <span class="icon icon-edit icon-13"></span>
              </button>
              <div class="wb-inline-edit hidden" id="wbInlineEdit">
                <input type="number" id="wbInlineInput" min="0" max="${cap}" step="1" value="${curW}" />
                <button id="wbInlineConfirm" class="wb-inline-ok" title="Confirm">✓</button>
                <button id="wbInlineCancel" class="wb-inline-cancel" title="Cancel">✕</button>
              </div>
            </div>
            <div class="wb-cap">${cap >= 1000 ? (cap/1000).toFixed(cap % 1000 === 0 ? 0 : 1) + ' kg' : cap + ' g'} total</div>
          </div>
          <div class="wb-track">
            <div class="wb-fill" id="wbFill" style="width:${Math.round(curW/cap*100)}%"></div>
            <input type="range" id="weightSlider" min="0" max="${cap}" step="1" value="${curW}" />
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:5px">
            <span>0 g</span><span>${cap} g</span>
          </div>
        </div>

        <div id="panelWeightResult"></div>
      </div>`;

    // info rows
    const infoRows = [
      [t("detUid"),           r.uid],
      [t("detType"),          r.productType],
      [t("thName"),           r.colorName !== "-" ? r.colorName : null],
      [t("detSeries"),        r.series],
      [t("detBrand"),         r.brand],
      [t("detMaterial"),      r.material],
      [t("detDiameter"),      r.diameter],
      [t("detTagType"),       r.tagType],
      [t("detSku"),           r.sku],
      [t("detBarcode"),       r.barcode],
      [t("detContainer"),     r.containerId],
      [t("detTwin"),          r.twinUid],
      [t("detUpdated"),       fmtTs(r.lastUpdate)],
      ...(!r.isPlus && fmtChipTs(r.chipTimestamp) ? [[t("detManufactured"), fmtChipTs(r.chipTimestamp)]] : []),
    ].filter(([,val]) => val && val !== "-");

    // Details section is collapsible — state persisted in localStorage.
    // Defaults to collapsed (the user said it's rarely useful and takes space).
    const detailsOpen = localStorage.getItem("tigertag.detailsExpanded") === "1";
    const infoHtml = `
      <div class="panel-section panel-details${detailsOpen ? " open" : ""}">
        <button class="panel-details-head" type="button" id="btnToggleDetails">
          <span class="panel-label">${t("sectionDetails")}</span>
          <span class="panel-details-chevron">›</span>
        </button>
        <div class="panel-details-body">
          ${infoRows.map(([k,val]) => `<div class="panel-row"><span class="pk">${k}</span><span class="pv">${esc(String(val))}</span></div>`).join("")}
          <div style="margin-top:8px;display:flex;gap:6px">
            ${r.isPlus ? '<span class="tag-plus">TigerTag+</span>' : '<span class="tag-diy">TigerTag</span>'}
            ${r.deleted ? `<span class="badge bad" style="font-size:11px">${t("badgeDeleted")}</span>` : ""}
          </div>
        </div>
      </div>`;

    // ── Storage location row (rack name + coordinate, or auto-assign button)
    // Shown for any active spool. Two states:
    //   • Placed in a rack    → display the rack name + coordinate (A1, B5…)
    //   • Not placed yet      → display an "Auto-assign" button that drops
    //                           the spool into the first available unlocked
    //                           slot, scanning racks in display order.
    // Hidden in friend-view (read-only) and when there are no racks at all.
    const _rackForSpool = (r.rackId && r.rackLevel != null && r.rackPos != null)
      ? state.racks.find(x => x.id === r.rackId) : null;
    const _hasRacks = state.racks.length > 0;
    let storageHtml = "";
    if (_rackForSpool) {
      const coord = String.fromCharCode(65 + r.rackLevel) + (r.rackPos + 1);
      const lockedHere = isSlotLocked(_rackForSpool.id, r.rackLevel, r.rackPos);
      // Clickable row → closes the detail panel, switches to Storage view,
      // and prefills the search bar with the spool's RFID UID so the user
      // visually locates it (matching slot stays bright, others dim).
      storageHtml = `
        <div class="panel-section panel-storage-loc">
          <div class="panel-label">${t("sectionStorageLoc") || "Storage location"}</div>
          <button class="storage-loc-row storage-loc-row--clickable" id="btnLocateSpool"
                  data-spool-uid="${esc(r.uid || "")}"
                  data-spool-id="${esc(r.spoolId)}"
                  title="${esc(t("storageLocateTip") || "Show in Storage view")}">
            <span class="icon icon-package icon-14"></span>
            <span class="storage-loc-rack">${esc(_rackForSpool.name)}</span>
            <span class="storage-loc-coord">${coord}</span>
            ${lockedHere ? `<span class="storage-loc-locked icon icon-lock icon-13" title="${esc(t("rackLockedTip"))}"></span>` : ""}
            <span class="storage-loc-locate icon icon-chevron-r icon-13" aria-hidden="true"></span>
          </button>
        </div>`;
    } else if (_hasRacks && !state.friendView && !r.deleted) {
      storageHtml = `
        <div class="panel-section panel-storage-loc">
          <div class="panel-label">${t("sectionStorageLoc") || "Storage location"}</div>
          <div class="storage-loc-row storage-loc-row--empty">
            <span class="icon icon-package icon-14"></span>
            <span class="storage-loc-rack storage-loc-rack--empty">${esc(t("storageNotPlaced") || "Not placed in a rack")}</span>
            <button class="ghost sm storage-loc-autobtn" id="btnStorageAutoAssign" data-spool-id="${esc(r.spoolId)}" title="${esc(t("storageAutoAssignTip") || "Place in the first available slot")}">
              <span class="icon icon-sparkle icon-13"></span>
              <span data-i18n="storageAutoAssign">${esc(t("storageAutoAssign") || "Auto-assign")}</span>
            </button>
          </div>
        </div>`;
    }

    // container card — flat layout (no border box)
    const container = r.containerId ? containerFind(r.containerId) : null;
    const containerHtml = container ? `
      <div class="panel-section cc-section">
        <div class="cc-head">${esc(container.brand)} · ${esc(container.label)}</div>
        <div class="cc-body">
          <img src="${esc(container.img)}" alt="${esc(container.brand)}" onerror="this.style.display='none'" />
          <div class="cc-meta">
            <div class="cc-type">${esc(container.type)}</div>
            <div class="cc-cw-row">
              <span id="ccCwVal" class="cc-cw">${r.containerWeight} g</span>
              ${state.friendView ? "" : `<button id="btnEditCw" class="cc-cw-btn" title="${t("cwEditWeight")}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`}
            </div>
            ${state.friendView ? "" : `<div id="ccCwEditRow" class="cc-cw-edit-row">
              <input id="ccCwInput" type="number" class="cc-cw-input" value="${r.containerWeight}" min="0" max="9999" step="1" />
              <button id="ccCwOk" class="cc-cw-ok">✓</button>
              <button id="ccCwCancel" class="cc-cw-cancel">✕</button>
            </div>`}
          </div>
          ${state.friendView ? "" : `<button id="btnChangeContainerCard" class="cc-edit" title="${t("btnChangeContainer")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`}
        </div>
      </div>` : "";

    // aspects + badges — all chips in one wrapping row beside the color circle
    const aspectChips = [r.aspect1, r.aspect2].filter(a => a && a !== "-" && a !== "None");
    const allChips = [
      ...aspectChips.map(a => `<span class="aspect-chip">${esc(a)}</span>`),
      ...infoBadges.map(b => `<span class="aspect-chip">${b}</span>`)
    ];
    const aspectHtml = "";
    const badgeHtml = allChips.length
      ? `<div class="aspect-chips">${allChips.join("")}</div>`
      : "";

    // identity block — Brand + Series on line 1, Material + Name on line 2
    const hasBrand   = r.brand && r.brand !== "-";
    const hasSeries  = r.series && r.series !== "-";
    const hasMat     = r.material && r.material !== "-";
    const rawName    = r.colorName && r.colorName !== "-" ? r.colorName : null;
    const aspectFallback = [r.aspect1, r.aspect2].filter(a => a && a !== "-" && a !== "None").join(" ");
    const displayName = rawName || aspectFallback || null;
    const identityHtml = `
      <div class="panel-section panel-identity">
        ${hasBrand || hasSeries ? `<div class="pi-row1">${[hasBrand ? esc(r.brand) : "", hasSeries ? esc(r.series) : ""].filter(Boolean).join(" ")}</div>` : ""}
        ${hasMat || displayName ? `<div class="pi-row2">${[hasMat ? esc(r.material) : "", displayName ? esc(displayName) : ""].filter(Boolean).join(" ")}</div>` : ""}
      </div>`;

    const chipBannerHtml = r.needUpdateAt ? `
      <div class="chip-update-banner">
        <span class="chip-update-icon"><span class="icon icon-refresh icon-13"></span></span>
        <span class="chip-update-text">${t("chipPendingHint")}</span>
        <button class="btn chip-update-done" id="btnChipDone">${t("btnChipDone")}</button>
      </div>` : "";

    return `
      ${imgSection}
      ${identityHtml}
      ${chipBannerHtml}
      <div class="panel-section">
        <div class="panel-label">${t("sectionColors", {n: r.colorList.length})} &amp; Aspect</div>
        <div class="color-aspect-row">
          <div class="color-circles-col">
            <button class="color-edit-trigger" id="btnEditColor" title="${t("colorEditTitle")}">${colorsHtml || '<span style="color:var(--muted);font-size:13px">—</span>'}<span class="color-edit-plus">+</span></button>
          </div>
          <div class="aspect-col">
            ${aspectHtml}
            ${badgeHtml}
          </div>
        </div>
      </div>
      ${weightHtml}
      ${storageHtml}
      ${containerHtml}
      ${tempHtml}
      ${videoHtml}
      ${linksHtml}
      ${infoHtml}
      ${(() => {
        // ── Toolbox — bundles every action available on this spool.
        // Hidden in friend view (read-only) and on tombstoned rows
        // (deleted spools have nothing to act on).
        if (state.friendView || r.deleted) return "";
        const tools = [];

        // 1. TD1S — measure colour. Always shown; if the device isn't
        //    connected the click opens the connect modal first so the
        //    user has a clear path to fixing it.
        tools.push({
          id: "btnToolMeasureColor",
          icon: "icon-palette",
          label: t("toolMeasureColor"),
          variant: "default",
        });

        // 2. TD1S — measure TD (transparency). Same pattern.
        tools.push({
          id: "btnToolMeasureTd",
          icon: "icon-search",
          label: t("toolMeasureTd"),
          variant: "default",
        });

        // 3. Twin pairing — three possible visibilities:
        //    - paired (normal user)        → row hidden (the twin
        //      badge on the photo + the raw-data tab already convey
        //      the paired state; an extra info row would just take
        //      vertical space without giving the user an action)
        //    - paired (debug user)         → "Unlink" tool (delete
        //      pairing, hold-to-confirm)
        //    - unpaired + has candidates   → "Link to a twin spool"
        //    - unpaired + no candidates    → row hidden
        if (r.hasTwinPair) {
          if (state.debugEnabled) {
            tools.push({
              id: "btnTwinUnlink",
              icon: "icon-link",
              label: t("twinLinkUnlink"),
              variant: "danger-soft",
              holdConfirm: true,
              title: t("twinLinkUnlinkHint"),
              dataAttrs: `data-spool-id="${esc(r.spoolId)}"`,
            });
          }
          // Normal users: no twin row at all when already paired.
        } else if (findTwinCandidates(r).length > 0) {
          tools.push({
            id: "btnTwinLink",
            icon: "icon-link",
            label: t("twinLinkAction"),
            variant: "default",
            dataAttrs: `data-spool-id="${esc(r.spoolId)}"`,
          });
        }

        // 4. Remove from rack — only when the spool IS placed in a
        //    rack. Hold-to-confirm + reuses the eject animation that
        //    void-drop fires.
        if (r.rackId) {
          tools.push({
            id: "btnToolRemoveFromRack",
            icon: "icon-package",
            label: t("toolRemoveFromRack"),
            variant: "danger-soft",
            holdConfirm: true,
            dataAttrs: `data-spool-id="${esc(r.spoolId)}"`,
          });
        }

        // 5. Delete — moved out of its own section into the toolbox.
        tools.push({
          id: "btnSpoolDelete",
          icon: "icon-trash",
          label: t("spoolMarkDeleted"),
          variant: "danger",
          holdConfirm: true,
          title: t("spoolMarkDeletedTip"),
          dataAttrs: `data-spool-id="${esc(r.spoolId)}"`,
        });

        // Render — each tool is a row (button or div with trailing
        // button). Hold-confirm rows include the .hold-progress fill
        // span that setupHoldToConfirm targets for the animation.
        const rowsHtml = tools.map(tool => {
          const cls = `toolbox-row toolbox-row--${tool.variant}${tool.holdConfirm ? " toolbox-row--hold" : ""}${tool.inert ? " toolbox-row--inert" : ""}`;
          const titleAttr = tool.title ? ` title="${esc(tool.title)}"` : "";
          const dataAttrs = tool.dataAttrs || "";
          // Inert rows render as a <div> with a trailing <button> for the
          // action; clickable rows render as a <button> directly.
          if (tool.inert) {
            return `
              <div class="${cls}" id="${esc(tool.id)}"${titleAttr} ${dataAttrs}>
                <span class="icon ${esc(tool.icon)} icon-14 toolbox-row-icon"></span>
                <span class="toolbox-row-label">${esc(tool.label)}</span>
                ${tool.trailing || ""}
              </div>`;
          }
          return `
            <button type="button" class="${cls}" id="${esc(tool.id)}"${titleAttr} ${dataAttrs}>
              ${tool.holdConfirm ? '<span class="hold-progress"></span>' : ""}
              <span class="icon ${esc(tool.icon)} icon-14 toolbox-row-icon"></span>
              <span class="toolbox-row-label">${esc(tool.label)}</span>
              <span class="icon icon-chevron-r icon-13 toolbox-row-chev"></span>
            </button>`;
        }).join("");

        return `
          <div class="panel-section panel-section--toolbox">
            <div class="panel-label">${esc(t("toolboxTitle"))}</div>
            <div class="toolbox-list">${rowsHtml}</div>
          </div>`;
      })()}
      ${state.debugEnabled ? `
      <div class="panel-section">
        <details class="debug" id="rawDetails">
          <summary style="display:flex;align-items:center;justify-content:space-between">
            <strong>${t("sectionRaw")}</strong>
            <button class="stg-copy-btn" id="btnCopyRaw" title="Copy JSON" style="height:26px;width:26px;flex-shrink:0">${SVG_COPY}</button>
          </summary>
          ${(() => {
            if (!r.hasTwinPair) {
              return `<pre class="json" id="rawJsonPre" style="margin-top:10px;max-height:400px">${highlight(r.raw)}</pre>`;
            }
            const twin = state.rows.find(x => x.spoolId !== r.spoolId && (String(x.uid) === String(r.twinUid) || String(x.spoolId) === String(r.twinUid)));
            const twinRaw = twin ? twin.raw : {};
            return `
            <div class="raw-tabs" style="margin-top:10px">
              <button class="raw-tab active" data-raw-tab="a">${t("twinTabThis")}</button>
              <button class="raw-tab" data-raw-tab="b">${t("twinTabTwin")}</button>
            </div>
            <pre class="json" id="rawJsonPre" style="max-height:400px" data-raw-a="${encodeURIComponent(JSON.stringify(r.raw, null, 2))}" data-raw-b="${encodeURIComponent(JSON.stringify(twinRaw, null, 2))}">${highlight(r.raw)}</pre>`;
          })()}
        </details>
      </div>` : ""}`;
  }

  async function doWeightUpdate(r, mode = "direct", w = "") {
    // Studio Manager has the full inventory in memory — same model as the mobile app.
    // Tare and twin logic are client-side; we write directly to Firestore.
    const uid = state.activeAccountId; if (!uid) return;
    if (w === "" || isNaN(Number(w))) { toast($("panelWeightResult"), "bad", t("enterNumeric")); return; }

    const btn = $("panelWeightBtn"); // may be null when called from slider/inline edit
    try {
      setLoading(btn, true);
      const rawW = Number(w);
      const cw   = Number(r.containerWeight) || 0;
      const cap  = Number(r.capacity) || 1000;

      // Tare: raw mode = scale reading includes container; direct mode = net weight
      const weightAvailable = mode === "raw" ? rawW - cw : rawW;
      const weightDisplay   = mode === "raw" ? rawW : rawW + cw; // gross for toast

      if (weightAvailable < 0 || weightAvailable > cap) {
        toast($("panelWeightResult"), "bad", t("weightErr", { r: `${weightAvailable} g — hors plage [0–${cap} g]` }));
        setLoading(btn, false); return;
      }

      const update = { weight_available: weightAvailable, last_update: Date.now() };
      const invRef = fbDb().collection("users").doc(uid).collection("inventory");
      const batch  = fbDb().batch();
      batch.update(invRef.doc(r.spoolId), update);

      // Twin — client already knows the twin relationship (same as mobile app)
      let twinUpdated = false;
      if (r.twinUid) {
        const twinRow = state.rows.find(row =>
          row.spoolId !== r.spoolId &&
          (String(row.uid) === String(r.twinUid) || String(row.spoolId) === String(r.twinUid))
        );
        if (twinRow) { batch.update(invRef.doc(twinRow.spoolId), update); twinUpdated = true; }
      }

      await batch.commit();
      // onSnapshot propagates the change to the UI automatically — no loadInventory() needed
      toast($("panelWeightResult"), "ok",
        t("weightOk", { wa: weightAvailable, w: weightDisplay, cw }) +
        (twinUpdated ? t("weightOkTwin") : "")
      );
      // Refresh detail panel once onSnapshot fires (give Firestore ~500 ms)
      setTimeout(() => {
        if ($("detailPanel").classList.contains("open") && state.selected === r.spoolId) openDetail(r.spoolId);
      }, 500);

    } catch (e) { toast($("panelWeightResult"), "bad", e.message || t("networkError")); }
    finally { setLoading(btn, false); }
  }

  /* ── resizable panels ── */
  function makePanelResizable(panelEl, handleEl, storageKey) {
    const MIN_W = 280;
    const MAX_W = () => Math.round(window.innerWidth * 0.85);

    // Restore saved width
    const saved = parseInt(localStorage.getItem(storageKey), 10);
    if (saved && saved >= MIN_W) panelEl.style.width = saved + "px";

    let startX, startW;

    function onMove(e) {
      const dx = startX - (e.clientX ?? e.touches?.[0]?.clientX ?? startX);
      const w  = Math.max(MIN_W, Math.min(MAX_W(), startW + dx));
      panelEl.style.width = w + "px";
    }
    function onUp() {
      handleEl.classList.remove("dragging");
      panelEl.classList.remove("resizing");
      document.body.style.cursor  = "";
      document.body.style.userSelect = "";
      const w = parseInt(panelEl.style.width, 10);
      if (w) localStorage.setItem(storageKey, w);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend",  onUp);
    }

    handleEl.addEventListener("mousedown", e => {
      e.preventDefault();
      startX = e.clientX;
      startW = panelEl.offsetWidth;
      handleEl.classList.add("dragging");
      panelEl.classList.add("resizing");
      document.body.style.cursor     = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
    // touch support
    handleEl.addEventListener("touchstart", e => {
      startX = e.touches[0].clientX;
      startW = panelEl.offsetWidth;
      handleEl.classList.add("dragging");
      panelEl.classList.add("resizing");
      document.addEventListener("touchmove", onMove, { passive: true });
      document.addEventListener("touchend",  onUp);
    }, { passive: true });
  }

  makePanelResizable($("detailPanel"), $("detailResize"), "tigertag.panelWidth.detail");
  makePanelResizable($("debugPanel"),  $("debugResize"),  "tigertag.panelWidth.debug");
  makePanelResizable($("td1sPanel"),   $("td1sResize"),   "tigertag.panelWidth.td1s");

  /* ── TD1S panel ── */
  function openTD1S() {
    $("td1sPanel").classList.add("open");
    $("td1sOverlay").classList.add("open");
    window.td1s?.need();
  }
  function closeTD1S() {
    $("td1sPanel").classList.remove("open");
    $("td1sOverlay").classList.remove("open");
    window.td1s?.release();
  }
  $("btnTD1S").addEventListener("click", openTD1S);
  $("td1sClose").addEventListener("click", closeTD1S);
  $("td1sOverlay").addEventListener("click", closeTD1S);

  /* ── debug panel ── */
  function openDebug() {
    $("debugPanel").classList.add("open");
    $("debugOverlay").classList.add("open");
    fsExplRefresh();
  }
  function closeDebug() { $("debugPanel").classList.remove("open"); $("debugOverlay").classList.remove("open"); }
  $("btnDebug").addEventListener("click", openDebug);
  $("debugPanelClose").addEventListener("click", closeDebug);
  $("debugOverlay").addEventListener("click", closeDebug);

  /* ── diagnostic / report-problem modal ── */
  $("dbgDelRefresh")?.addEventListener("click", renderDeletedSpoolsList);
  $("dbgDelSearch")?.addEventListener("input", renderDeletedSpoolsList);
  $("btnReportProblem")?.addEventListener("click", openDiagnosticModal);
  $("btnReportProblemLogin")?.addEventListener("click", openDiagnosticModal);
  $("diagModalClose")?.addEventListener("click", closeDiagnosticModal);
  $("diagModalOverlay")?.addEventListener("click", e => { if (e.target === $("diagModalOverlay")) closeDiagnosticModal(); });
  $("btnDiagCopy")?.addEventListener("click", async () => {
    const txt = $("diagBody").value;
    try {
      await navigator.clipboard.writeText(txt);
      const btn = $("btnDiagCopy"); const orig = btn.textContent;
      btn.textContent = t("errReportCopied"); btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1400);
    } catch {
      // Fallback: select the textarea so the user can copy manually
      $("diagBody").focus(); $("diagBody").select();
    }
  });
  $("btnDiagClear")?.addEventListener("click", () => {
    _errorLog.length = 0;
    $("diagBody").value = buildDiagnosticReport();
    renderDiagBadge();
  });
  $("btnDiagDownload")?.addEventListener("click", () => {
    const txt = $("diagBody").value || buildDiagnosticReport();
    // Filename: tigertag-diagnostic-YYYY-MM-DDTHH-MM-SS.md (path-safe ISO timestamp)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    const blob = new Blob([txt], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tigertag-diagnostic-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // Pre-load app info as soon as possible so the first open is instant
  loadAppInfo();

  // Click-outside to close the "Spools not stored" side panel.
  // Registered once at startup — works even if the panel is recreated by
  // renderRackView snapshots (it queries by id at click time).
  document.addEventListener("mousedown", e => {
    const aside = document.getElementById("rpUnranked");
    if (!aside?.classList.contains("is-open")) return;
    // Click inside the panel itself — keep it open
    if (aside.contains(e.target)) return;
    // Whitelist: buttons that own/manage the panel state — let their
    // own handlers run instead of the click-outside closing behaviour.
    if (e.target.closest("#btnToggleUnranked")) return;  // header pill toggle
    if (e.target.closest("#btnViewRack")) return;        // Storage view button (toolbar)
    if (e.target.closest("#btnOpenRacks")) return;       // Storage button (sidebar)
    // Otherwise — close
    aside.classList.remove("is-open");
    localStorage.setItem("tigertag.unrackedPanelOpen", "false");
  });

  // Settings → About → "Copy" — copies a one-line summary to clipboard
  $("btnCopyAbout")?.addEventListener("click", async () => {
    const info = await loadAppInfo();
    const txt = `Tiger Studio Manager v${info.appVersion} · ${info.platform || "?"}${info.arch ? " " + info.arch : ""} · Electron ${info.electron} · Chrome ${info.chrome || "?"} · Node ${info.node || "?"}`;
    try {
      await navigator.clipboard.writeText(txt);
      const lbl = $("btnCopyAbout")?.querySelector("[data-i18n='aboutCopy']");
      if (lbl) {
        const orig = lbl.textContent;
        lbl.textContent = t("settingsCopied");
        setTimeout(() => { lbl.textContent = orig; }, 1400);
      }
    } catch {}
  });

  // ── Settings → About → Auto-update toggle ───────────────────────────
  // Persists in localStorage AND syncs to the main process (which gates
  // checkForUpdatesAndNotify on this preference). Default: ON.
  const _autoUpdateKey = "tigertag.autoUpdate.enabled";
  function readAutoUpdatePref() {
    return localStorage.getItem(_autoUpdateKey) !== "false";    // default true
  }
  function writeAutoUpdatePref(enabled) {
    localStorage.setItem(_autoUpdateKey, enabled ? "true" : "false");
    try { window.electronAPI?.setAutoUpdate?.(enabled); } catch (_) {}
  }
  // Initial state on first render: reflect the stored preference + push it
  // to main (so the file-on-disk preference matches the renderer's view).
  const _autoUpdateToggle = $("stgAutoUpdateToggle");
  if (_autoUpdateToggle) {
    const enabled = readAutoUpdatePref();
    _autoUpdateToggle.checked = enabled;
    try { window.electronAPI?.setAutoUpdate?.(enabled); } catch (_) {}
    _autoUpdateToggle.addEventListener("change", () => {
      writeAutoUpdatePref(_autoUpdateToggle.checked);
    });
  }

  // ── Settings → About → "Check for updates now" button ───────────────
  // Forces a check regardless of the auto-update preference. Status is
  // surfaced via update-status events handled below + an inline message.
  function showUpdateStatus(msg, kind) {
    const el = $("stgUpdateStatus");
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = kind || "info";   // "info" | "ok" | "warn" | "err"
    el.hidden = false;
    clearTimeout(showUpdateStatus._t);
    if (kind === "ok" || kind === "info") {
      showUpdateStatus._t = setTimeout(() => { el.hidden = true; }, 6000);
    }
  }
  $("btnCheckUpdate")?.addEventListener("click", async () => {
    const btn = $("btnCheckUpdate");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    showUpdateStatus(t("aboutCheckUpdateChecking") || "Checking for updates…", "info");
    try {
      const r = await window.electronAPI?.checkForUpdates?.();
      if (!r?.ok) {
        showUpdateStatus((t("aboutCheckUpdateErr") || "Could not check") + ": " + (r?.error || "?"), "err");
      }
      // Success cases (up-to-date / available / ready) are surfaced by the
      // 'update-status' event listener below — no extra UI here.
    } catch (e) {
      showUpdateStatus((t("aboutCheckUpdateErr") || "Could not check") + ": " + (e?.message || e), "err");
    } finally {
      setTimeout(() => { btn.disabled = false; }, 2000);
    }
  });

  // Forward the lifecycle events from main into the inline status line.
  // Existing 'update-ready' overlay (shown elsewhere) keeps its handling.
  if (window.electronAPI?.onUpdateStatus) {
    window.electronAPI.onUpdateStatus((info) => {
      const status = info?.status;
      if (status === "checking")    showUpdateStatus(t("aboutCheckUpdateChecking") || "Checking for updates…", "info");
      else if (status === "up-to-date") showUpdateStatus(t("aboutCheckUpdateUpToDate") || "You're on the latest version.", "ok");
      else if (status === "available")  showUpdateStatus((t("aboutCheckUpdateAvailable") || "New version available") + (info.version ? ` (v${info.version})` : "") + " — downloading…", "info");
      else if (status === "ready")      showUpdateStatus((t("aboutCheckUpdateReady") || "Update ready — restart to install") + (info.version ? ` (v${info.version})` : ""), "ok");
      else if (status === "error")      showUpdateStatus((t("aboutCheckUpdateErr") || "Could not check") + ": " + (info.error || "?"), "err");
    });
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDebug(); });

  // debug tab switching
  document.querySelectorAll(".dbg-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dbg-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $("dbgPaneApi").classList.toggle("hidden", tab !== "api");
      $("dbgPaneFs").classList.toggle("hidden",  tab !== "fs");
      $("dbgPaneDel")?.classList.toggle("hidden", tab !== "del");
      if (tab === "fs") fsExplRefresh();
      if (tab === "del") renderDeletedSpoolsList();
    });
  });

  /* ── Deleted spools list (debug) ──────────────────────────────────────────
     Lists every spool whose `deleted === true` (matches mobile semantics —
     `deleted_at` alone is ignored, treated as historical metadata).
     The Restore button writes `deleted: null` and clears `deleted_at` defensively. */
  function renderDeletedSpoolsList() {
    const list = $("dbgDelList");
    const cnt  = $("dbgDelCount");
    if (!list) return;
    if (!state.inventory) {
      list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:14px;text-align:center">${t("invLoading")}</div>`;
      if (cnt) cnt.textContent = "0";
      return;
    }
    // Iterate raw Firestore docs (NOT state.rows — dedup hides one half of twins).
    const q = ($("dbgDelSearch")?.value || "").trim().toLowerCase();
    const matches = (d, id) => {
      if (!q) return true;
      const r = state.rows.find(x => x.spoolId === id) || normalizeRow(id, d);
      return [r.uid, r.colorName, r.material, r.brand, r.series, r.sku, r.barcode]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q));
    };
    const entries = Object.entries(state.inventory)
      .filter(([id, d]) => d && d.deleted === true && matches(d, id))
      .sort(([, a], [, b]) => {
        const ta = (a.deleted_at?._seconds || a.deleted_at || 0);
        const tb = (b.deleted_at?._seconds || b.deleted_at || 0);
        return tb - ta; // most-recently deleted first
      });
    if (cnt) cnt.textContent = String(entries.length);
    if (!entries.length) {
      list.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:14px;text-align:center">${t("dbgDeletedEmpty")}</div>`;
      return;
    }
    list.innerHTML = entries.map(([id, d]) => {
      const r = state.rows.find(x => x.spoolId === id) || normalizeRow(id, d);
      const fillBg = colorBg(r);
      const titleLine = r.colorName !== "-" ? r.colorName : (r.material || r.uid || "—");
      const subLine   = [r.brand, r.material].filter(Boolean).join(" · ");
      const wAvail    = r.weightAvailable != null ? r.weightAvailable : "—";
      const wCap      = r.capacity || 1000;
      const delTs = d.deleted_at?._seconds
        ? new Date(d.deleted_at._seconds * 1000)
        : (typeof d.deleted_at === "number" ? new Date(d.deleted_at) : null);
      const delLabel = delTs ? delTs.toLocaleDateString() + " " + delTs.toLocaleTimeString() : "—";
      const twinNote = d.twin_tag_uid ? ` · twin=${d.twin_tag_uid}` : "";
      return `
        <div class="dbg-del-row" data-spool-id="${esc(id)}">
          <div class="dbg-del-puck" style="background:${fillBg}"></div>
          <div class="dbg-del-meta">
            <div class="dbg-del-name">${esc(titleLine)}</div>
            <div class="dbg-del-sub">${esc(subLine || "—")} · ${wAvail}g/${wCap}g</div>
            <div class="dbg-del-tech">uid=${esc(String(r.uid))} · deleted=${esc(delLabel)}${twinNote}</div>
          </div>
          <button class="ghost sm dbg-del-restore" data-action="restore" title="${t("dbgDeletedRestore")}">↺</button>
          <button class="ghost sm dbg-del-purge"   data-action="purge"   title="${t("dbgDeletedPurge")}">🗑</button>
        </div>`;
    }).join("");

    list.querySelectorAll(".dbg-del-restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-spool-id]");
        if (!row) return;
        const id = row.dataset.spoolId;
        btn.disabled = true; btn.textContent = "…";
        try { await restoreDeletedSpool(id); }
        catch (err) {
          reportError("debug.restoreSpool", err);
          btn.disabled = false; btn.textContent = "↺";
        }
      });
    });
    list.querySelectorAll(".dbg-del-purge").forEach(btn => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-spool-id]");
        if (!row) return;
        const id = row.dataset.spoolId;
        const d  = state.inventory[id];
        const r  = state.rows.find(x => x.spoolId === id) || (d ? normalizeRow(id, d) : null);
        const label = (r?.colorName !== "-" && r?.colorName) || r?.material || id;
        // Detect twin to show in confirm dialog
        const twinId = d?.twin_tag_uid && state.inventory[String(d.twin_tag_uid)] ? String(d.twin_tag_uid) : null;
        const msg = twinId
          ? t("dbgDeletedPurgeConfirmTwin", { name: label })
          : t("dbgDeletedPurgeConfirm",     { name: label });
        if (!confirm(msg)) return;
        btn.disabled = true; btn.textContent = "…";
        try { await purgeDeletedSpool(id); }
        catch (err) {
          reportError("debug.purgeSpool", err);
          btn.disabled = false; btn.textContent = "🗑";
        }
      });
    });
  }

  // Soft-delete a spool (and its twin if any). Uses the mobile-aligned
  // semantics: `deleted: true` is the only field that hides the spool.
  // The spool then appears in Settings → Debug → Deleted, restorable from there.
  async function markSpoolDeleted(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const r = state.rows.find(x => x.spoolId === spoolId);
    if (!r) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch = fbDb().batch();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const update = { deleted: true, deleted_at: ts, last_update: Date.now() };
    batch.update(invRef.doc(spoolId), update);
    // Mirror to twin so both halves stay in sync (just like the weight update flow)
    if (r.twinUid) {
      const twin = state.rows.find(x =>
        x.spoolId !== spoolId &&
        (String(x.uid) === String(r.twinUid) || String(x.spoolId) === String(r.twinUid))
      );
      if (twin) batch.update(invRef.doc(twin.spoolId), update);
    }
    await batch.commit();
    console.log(`[markSpoolDeleted] tombstoned ${spoolId}${r.twinUid ? " (+ twin)" : ""}`);
  }

  async function restoreDeletedSpool(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const batch = fbDb().batch();
    // Clear delete fields on the primary doc
    batch.update(invRef.doc(spoolId), { deleted: null, deleted_at: null, last_update: ts });
    // If linked twin exists in inventory and is also deleted, restore it too
    const primary = state.inventory[spoolId];
    const twinUid = primary?.twin_tag_uid;
    if (twinUid) {
      const twinId = String(twinUid);
      // The twin doc id may equal twin_tag_uid (the common case) — check existence
      if (state.inventory[twinId]) {
        const tw = state.inventory[twinId];
        if (tw.deleted === true) {
          batch.update(invRef.doc(twinId), { deleted: null, deleted_at: null, last_update: ts });
        }
      }
    }
    await batch.commit();
    console.log(`[restoreDeletedSpool] restored ${spoolId}${twinUid ? " (+ twin)" : ""}`);
    // The onSnapshot will re-render automatically; refresh the list explicitly
    setTimeout(renderDeletedSpoolsList, 350);
  }

  /* Permanently remove the spool doc from Firestore (and its twin if both
     are tombstoned). Irreversible — used by the 🗑 button in the Deleted tab. */
  async function purgeDeletedSpool(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch = fbDb().batch();
    batch.delete(invRef.doc(spoolId));
    let purgedTwin = false;
    const primary = state.inventory[spoolId];
    const twinUid = primary?.twin_tag_uid;
    if (twinUid) {
      const twinId = String(twinUid);
      // Only auto-purge twin if it ALSO carries a tombstone — avoid removing an
      // active spool just because its mate was deleted.
      if (state.inventory[twinId] && state.inventory[twinId].deleted === true) {
        batch.delete(invRef.doc(twinId));
        purgedTwin = true;
      }
    }
    await batch.commit();
    console.log(`[purgeDeletedSpool] hard-deleted ${spoolId}${purgedTwin ? " (+ twin)" : ""}`);
    setTimeout(renderDeletedSpoolsList, 350);
  }

  /* ── Firestore explorer ── */
  let _fseLastResult = null;

  // Known paths — {uid} replaced at runtime
  const FSE_QUICK = [
    { label: "user doc",   path: "users/{uid}" },
    { label: "prefs",      path: "users/{uid}/prefs/app" },
    { label: "inventory",  path: "users/{uid}/inventory",  col: true },
    { label: "printers",   path: "users/{uid}/printers",   col: true },
    { label: "tags",       path: "users/{uid}/tags",       col: true },
  ];

  function fseInit() {
    const uid = state.activeAccountId || "{uid}";
    // build quick-access chips
    $("fseChips").innerHTML = FSE_QUICK.map(q => {
      const p = q.path.replace("{uid}", uid);
      return `<button class="fse-chip" data-path="${esc(p)}">${esc(q.label)}</button>`;
    }).join("");
    // set default path to user doc
    $("fsePath").value = `users/${uid}`;
  }

  async function fseFetch() {
    const uid = state.activeAccountId;
    if (!uid) { fseSetResult(null, "Not signed in"); return; }
    const raw = $("fsePath").value.trim().replace("{uid}", uid);
    if (!raw) return;
    const parts = raw.split("/").filter(Boolean);
    fseSetResult(null, "Fetching…");
    try {
      let ref;
      if (parts.length % 2 === 0) {
        // even segments → document
        ref = fbDb().doc(raw);
        const snap = await ref.get();
        if (!snap.exists) { fseSetResult(null, `Document not found: ${raw}`); return; }
        _fseLastResult = { _path: raw, ...snap.data() };
        fseSetResult(_fseLastResult, `doc · ${raw}`);
      } else {
        // odd segments → collection
        ref = fbDb().collection(raw);
        const snap = await ref.limit(20).get();
        if (snap.empty) { fseSetResult(null, `Collection empty or not found: ${raw}`); return; }
        const result = {};
        snap.forEach(doc => { result[doc.id] = doc.data(); });
        _fseLastResult = result;
        fseSetResult(result, `collection · ${raw} (${snap.size} docs${snap.size === 20 ? ", limited to 20" : ""})`);
      }
    } catch (e) {
      fseSetResult(null, `Error: ${e.message}`);
    }
  }

  function fseSetResult(data, label) {
    $("fseLabel").textContent = label || "";
    $("fsExplPre").innerHTML = data != null
      ? highlight(data)
      : `<span style="color:var(--muted)">${esc(label || "—")}</span>`;
  }

  function fsExplRefresh() { fseInit(); }

  $("fseChips").addEventListener("click", e => {
    const chip = e.target.closest(".fse-chip[data-path]");
    if (!chip) return;
    $("fsePath").value = chip.dataset.path;
    fseFetch();
  });
  $("fseFetch").addEventListener("click", fseFetch);
  $("fsePath").addEventListener("keydown", e => { if (e.key === "Enter") fseFetch(); });
  $("fseCopy").addEventListener("click", () => {
    if (!_fseLastResult) return;
    navigator.clipboard.writeText(JSON.stringify(_fseLastResult, null, 2)).then(() => {
      const btn = $("fseCopy");
      const orig = btn.textContent;
      btn.textContent = "✓";
      setTimeout(() => btn.textContent = orig, 1800);
    });
  });

  /* ── community buttons ── */
  $("sbGithubBtn").addEventListener("click", () => window.open("https://github.com/TigerTag-Project/TigerTag_Studio_Manager/"));
  $("sbMakerWorldBtn").addEventListener("click", () => window.open("https://makerworld.com/fr/@TigerTag/upload"));
  $("sbDiscordBtn").addEventListener("click", () => window.open("https://discord.gg/3Qv5TSqnJH"));

  // Sign-in placeholder buttons
  $("btnSignInPlaceholder").addEventListener("click", openAddAccountModal);
  $("btnSignInPlaceholderGh").addEventListener("click", () => window.open("https://github.com/TigerTag-Project/TigerTag_Studio_Manager/"));
  $("btnSignInPlaceholderDiscord").addEventListener("click", () => window.open("https://discord.gg/3Qv5TSqnJH"));
  $("sbQrWrap").addEventListener("click", () => window.open("https://taap.it/DF1Aqt"));

  /* ── language select ── */
  function saveAccountLang(lang) {
    // 1. Local account object (localStorage)
    const accounts = getAccounts();
    const acc = accounts.find(a => a.id === getActiveId());
    if (acc) { acc.lang = lang; saveAccounts(accounts); }
    localStorage.setItem("tigertag.lang", lang);
    // 2. Firestore — users/{uid}/prefs/app { lang }  (synced to mobile app too)
    const user = fbAuth().currentUser;
    if (user) {
      fbDb().collection("users").doc(user.uid)
        .collection("prefs").doc("app")
        .set({ lang }, { merge: true })
        .catch(err => console.warn("[Firestore] saveAccountLang:", err.message));
    }
  }

  // Read language preference from Firestore and apply if different from local
  function applyDebugMode() {
    // Debug panel is now visible to all users (was admin-only gated by
    // state.debugEnabled). The panel exposes their OWN Firestore docs only,
    // limited by Security Rules — no escalation path.
    $("btnDebug").classList.remove("hidden");
  }

  /* ── Friends UI ───────────────────────────────────────────────────────── */

  // Quick-access friends list rendered directly under the "Friends" button
  // in the main sidebar. Each chip is clickable → switches the inventory
  // view to that friend (read-only). Hidden when there are no friends.
  // Highlights the currently-active friend with an "active" border.
  function renderSidebarFriends() {
    const el = $("sbFriendsList");
    if (!el) return;
    if (!state.friends || !state.friends.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.classList.remove("hidden");
    el.innerHTML = state.friends.map(f => {
      const initials = (f.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      const color = friendColor(f);
      const fg = readableTextOn(color);
      const isActive = state.friendView?.uid === f.uid;
      // `data-tooltip` powers the custom CSS bubble that shows the friend's
      // displayName when the sidebar is collapsed (avatar-only mode), since
      // the inline name span is then hidden. Native `title=` is also kept
      // as a fallback for accessibility / when the chip is keyboard-focused.
      return `<button class="sb-friend-chip${isActive ? " is-active" : ""}"
                      data-friend-uid="${esc(f.uid)}"
                      data-friend-name="${esc(f.displayName || f.uid)}"
                      data-friend-color="${esc(color)}"
                      data-tooltip="${esc(f.displayName || f.uid)}"
                      title="${esc(f.displayName || f.uid)}">
        <span class="sb-friend-avatar" style="background:${color};color:${fg}">${esc(initials)}</span>
        <span class="sb-friend-name">${esc(f.displayName || f.uid)}</span>
        ${isActive ? '<span class="sb-friend-active-dot" aria-hidden="true"></span>' : ""}
      </button>`;
    }).join("");
    el.querySelectorAll(".sb-friend-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const uid = btn.dataset.friendUid;
        const name = btn.dataset.friendName;
        const color = btn.dataset.friendColor;
        if (state.friendView?.uid === uid) {
          // Already viewing this friend → click again to go back to own view
          switchBackToOwnView();
        } else {
          switchToFriendView(uid, name, color);
        }
      });
      // Custom tooltip on hover, only shown when the sidebar is collapsed
      // (avatar-only mode). Uses a body-appended singleton bubble so the
      // tooltip escapes the sidebar's `overflow: hidden`.
      btn.addEventListener("mouseenter", () => showSbFriendTip(btn));
      btn.addEventListener("mouseleave", hideSbFriendTip);
      btn.addEventListener("focus",      () => showSbFriendTip(btn));
      btn.addEventListener("blur",       hideSbFriendTip);
    });
  }

  function ensureSbFriendTipEl() {
    let tip = document.getElementById("sbFriendTip");
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "sbFriendTip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    return tip;
  }
  function showSbFriendTip(chip) {
    if (!document.querySelector(".sidebar.collapsed")) return;
    const text = chip.dataset.tooltip || chip.dataset.friendName || "";
    if (!text) return;
    const tip = ensureSbFriendTipEl();
    tip.textContent = text;
    const rect = chip.getBoundingClientRect();
    // Position 10px to the right of the chip, vertically centered on it
    tip.style.left = (rect.right + 10) + "px";
    tip.style.top  = (rect.top + rect.height / 2 - 14) + "px";
    tip.classList.add("is-open");
  }
  function hideSbFriendTip() {
    const tip = document.getElementById("sbFriendTip");
    if (tip) tip.classList.remove("is-open");
  }

  function renderFriendsList() {
    const list = $("stgFriendsList");
    const count = $("stgFriendsCount");
    if (!list) return;
    if (count) count.textContent = state.friends.length;

    if (!state.friends.length) {
      list.innerHTML = `
        <div class="fp-empty">
          <div class="fp-empty-icon"><span class="icon icon-user icon-14"></span></div>
          <div class="fp-empty-title">${t("friendsEmpty")}</div>
          <div class="fp-empty-sub">${t("friendsEmptySub")}</div>
        </div>`;
      return;
    }

    const search = ($("fpSearch")?.value || "").trim().toLowerCase();
    const filtered = search
      ? state.friends.filter(f => (f.displayName || f.uid).toLowerCase().includes(search))
      : state.friends;

    if (!filtered.length) {
      list.innerHTML = `<div class="fp-empty fp-empty--mini">${t("noMatch")}</div>`;
      return;
    }

    list.innerHTML = filtered.map(f => {
      const initials = (f.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      const color = friendColor(f);
      const fg = readableTextOn(color);
      const date = f.addedAt ? timeAgo(f.addedAt.seconds ? f.addedAt.seconds * 1000 : f.addedAt) : "";
      return `<div class="fp-friend" data-uid="${esc(f.uid)}" data-name="${esc(f.displayName || f.uid)}" data-color="${esc(color)}">
        <div class="fp-friend-avatar" style="background:${color};color:${fg}">${initials}</div>
        <div class="fp-friend-main">
          <div class="fp-friend-name">${esc(f.displayName || f.uid)}</div>
          <div class="fp-friend-date">${date ? t("friendAddedOn", { date }) : ""}</div>
        </div>
        <div class="fp-friend-actions">
          <button class="fp-friend-btn fp-friend-view" data-action="view" title="${t('friendViewInv')}">
            <span class="icon icon-eye-on icon-13"></span>
          </button>
          <button class="fp-friend-btn fp-friend-remove" data-action="remove" title="${t('friendRemove')}">
            <span class="icon icon-trash icon-13"></span>
          </button>
        </div>
      </div>`;
    }).join("");

    // Click on the row body switches to that friend's inventory
    list.querySelectorAll(".fp-friend").forEach(row => {
      row.addEventListener("click", e => {
        if (e.target.closest("[data-action='remove']")) return;
        switchToFriendView(row.dataset.uid, row.dataset.name, row.dataset.color);
      });
    });
    list.querySelectorAll(".fp-friend-remove").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const row = btn.closest(".fp-friend");
        await removeFriend(row.dataset.uid);
        renderFriendsList();
      });
    });
    list.querySelectorAll(".fp-friend-view").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = btn.closest(".fp-friend");
        switchToFriendView(row.dataset.uid, row.dataset.name, row.dataset.color);
      });
    });
  }

  // Extract avatar color from a userProfiles document (single `color` hex field).
  function profileColor(data) {
    return data.color || null;
  }
  // Fallback color when no profile color is available.
  function friendColorFallback(uid) {
    return `hsl(${Math.abs(uid.split("").reduce((a,c) => a+c.charCodeAt(0), 0)) % 360}, 55%, 50%)`;
  }
  // Resolve the display color for a friend object (uses stored color, falls back to hash).
  function friendColor(f) {
    return f.color || friendColorFallback(f.uid);
  }

  // Compute a readable text color (black or white) for any CSS background
  // colour string. Uses a 1×1 canvas to coerce the input through the browser's
  // colour parser, then applies WCAG relative luminance. Returns "#1a1a1a"
  // for light backgrounds (white initials would be invisible) and "#fff" for
  // dark ones. Cached because the canvas hop is ~0.1 ms but we call it on
  // every render of the friends list.
  const _readableCache = new Map();
  function readableTextOn(bg) {
    if (!bg) return "#fff";
    const cached = _readableCache.get(bg);
    if (cached) return cached;
    let result = "#fff";
    try {
      const c = document.createElement("canvas");
      c.width = 1; c.height = 1;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#000";          // reset, in case `bg` is rejected
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      // sRGB relative luminance (WCAG). Threshold ~0.6 puts pure orange
      // (#ff7a18, lum ≈ 0.42) on white initials, and #ffb056 (lum ≈ 0.74)
      // and pure white on dark initials — the cutoff most users expect.
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      result = lum > 0.6 ? "#1a1a1a" : "#fff";
    } catch { /* fall back to white */ }
    _readableCache.set(bg, result);
    return result;
  }

  // Load friends list from Firestore, then sync displayName + avatar color from userProfiles
  // (userProfiles/{uid} is the live source of truth for public profile data).
  async function loadFriendsList() {
    const user = fbAuth().currentUser;
    if (!user) return;
    const uid = user.uid;
    try {
      const db = fbDb(uid);   // use named instance — safe even if active account changes during await
      const snap = await db.collection("users").doc(uid).collection("friends").get();
      const friends = snap.docs.map(d => ({ uid: d.id, ...d.data() }));

      // Fetch current public profiles in parallel
      const profileSnaps = await Promise.all(
        friends.map(f => db.collection("userProfiles").doc(f.uid).get().catch(() => null))
      );

      // Batch-update stale fields in our friends sub-collection (fire-and-forget)
      const batch = db.batch();
      let batchDirty = false;

      friends.forEach((f, i) => {
        const ps = profileSnaps[i];
        if (!ps || !ps.exists) return;
        const pd = ps.data();
        const liveDisplayName = pd.displayName || "";
        const liveColor       = profileColor(pd);   // "#rrggbb" or null
        const updates = {};

        if (liveDisplayName && liveDisplayName !== f.displayName) {
          f.displayName = liveDisplayName;
          updates.displayName = liveDisplayName;
        }
        if (liveColor && liveColor !== f.color) {
          f.color = liveColor;
          updates.color = liveColor;
        } else if (liveColor) {
          f.color = liveColor;   // always apply in-memory even if already stored
        }

        if (Object.keys(updates).length) {
          batch.update(
            db.collection("users").doc(uid).collection("friends").doc(f.uid),
            updates
          );
          batchDirty = true;
        }
      });

      if (batchDirty) batch.commit().catch(() => {});

      // Guard: only update UI if this is still the active account
      if (uid !== state.activeAccountId) return;

      state.friends = friends;
      renderFriendsList();
      // Refresh everywhere friends are shown
      renderAccountDropdown();
      if ($("profilesModalOverlay").classList.contains("open")) renderAccountList();
    } catch (e) { console.warn("[friends]", e.message); }
  }

  /* ── Racks (storage shelves) ───────────────────────────────────────────── */
  function subscribeRacks(uid) {
    unsubscribeRacks();
    // No orderBy — Firestore would silently filter out docs without the field.
    // We sort client-side instead by `order` (fallback createdAt) for stability.
    state.unsubRacks = fbDb(uid)
      .collection("users").doc(uid).collection("racks")
      .onSnapshot(snap => {
        if (uid !== state.activeAccountId) return;
        // Same defense-in-depth as the inventory listener: an in-flight
        // snapshot can land after we've entered friend-view; ignoring it
        // keeps the friend's (one-shot) racks visible without the owner's
        // racks bleeding back in.
        if (state.friendView) return;
        const racks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        racks.sort((a, b) => {
          const oa = a.order ?? 999, ob = b.order ?? 999;
          if (oa !== ob) return oa - ob;
          const ta = a.createdAt?.seconds || 0;
          const tb = b.createdAt?.seconds || 0;
          return ta - tb;
        });
        state.racks = racks;
        console.log(`[racks] snapshot: ${racks.length} rack(s)`, racks.map(r => r.name));
        renderRacksList();
      }, err => console.warn("[racks]", err.code, err.message));
  }
  function unsubscribeRacks() {
    if (state.unsubRacks) { state.unsubRacks(); state.unsubRacks = null; }
  }

  /* ── Scales (TigerScale heartbeat — see tigerscale-firestore-heartbeat-spec.md)
     Path: users/{uid}/scales/{mac}. Each doc carries a `last_seen` timestamp
     written by the ESP32 every 30s. Online if last_seen > now − 90s. */
  const SCALE_ONLINE_THRESHOLD_MS = 90 * 1000;
  function subscribeScales(uid) {
    unsubscribeScales();
    state.unsubScales = fbDb(uid)
      .collection("users").doc(uid).collection("scales")
      .onSnapshot(snap => {
        if (uid !== state.activeAccountId) return;
        state.scales = snap.docs.map(d => ({ mac: d.id, ...d.data() }));
        renderScaleHealth();
        renderScalesPanel();
      }, err => console.warn("[scales]", err.code, err.message));
  }
  function unsubscribeScales() {
    if (state.unsubScales) { state.unsubScales(); state.unsubScales = null; }
  }

  /* ── 3D Printers (per-brand subcollections) ─────────────────────────────
     Path: users/{uid}/printers/{brand}/devices/{deviceId}.
     There is no parent brand doc to enumerate, so we subscribe in parallel
     to one onSnapshot listener per known brand. State is rebuilt by the
     mergeBrandSnap callback so a snapshot for any brand updates only that
     brand's slice while preserving the others.
     See docs/03-data-model.md → users/{uid}/printers/{brand}/devices.       */
  const PRINTER_BRANDS = ["bambulab", "creality", "elegoo", "flashforge", "snapmaker"];

  function subscribePrinters(uid) {
    unsubscribePrinters();
    // Per-brand cache keyed by brand id; flattened into state.printers on every snapshot.
    const cache = Object.fromEntries(PRINTER_BRANDS.map(b => [b, []]));
    state._printerCache = cache;
    // Loading flag — flipped to false the FIRST time any brand listener
    // emits a snapshot (cached or live). Tracking per-brand "first
    // snapshot received" lets the empty state appear only once Firestore
    // has actually answered for every brand, instead of flickering as
    // brands trickle in. We also re-render once on flip so the spinner
    // fades to either the empty card or the printer grid.
    state.printersLoading = true;
    // Mirror the inventory pattern: trigger an immediate re-render so the
    // spinner appears the moment the subscription is fired, without
    // waiting for the first Firestore snapshot to round-trip. Otherwise
    // a fresh login lands on whatever stale content was in the host
    // (often the empty card from a previous session) until snapshots
    // populate, and the user never sees the loading state.
    if (state.viewMode === "printer") renderPrintersView();
    const firstSnapSeen = Object.fromEntries(PRINTER_BRANDS.map(b => [b, false]));
    state.unsubPrinters = PRINTER_BRANDS.map(brand => {
      return fbDb(uid)
        .collection("users").doc(uid)
        .collection("printers").doc(brand)
        .collection("devices")
        .onSnapshot(snap => {
          if (uid !== state.activeAccountId) return;
          if (state.friendView) return;
          // Mark this brand as "answered" — if all five have, drop the loading flag.
          if (!firstSnapSeen[brand]) {
            firstSnapSeen[brand] = true;
            if (Object.values(firstSnapSeen).every(Boolean)) {
              state.printersLoading = false;
            }
          }
          cache[brand] = snap.docs.map(d => {
            const data = d.data();
            // `updatedAt` is now written via serverTimestamp() — but legacy
            // docs from earlier versions may still hold a number (Unix ms).
            // Coerce to ms here once so timeAgo / fmtMs can stay simple.
            let updatedAtMs = data.updatedAt;
            if (updatedAtMs && typeof updatedAtMs === "object") {
              if (typeof updatedAtMs.toMillis === "function") updatedAtMs = updatedAtMs.toMillis();
              else if (updatedAtMs.seconds != null) updatedAtMs = updatedAtMs.seconds * 1000 + Math.round((updatedAtMs.nanoseconds || 0) / 1e6);
              else updatedAtMs = null;
            }
            return { id: d.id, brand, ...data, updatedAt: updatedAtMs };
          });
          // Flatten + sort by sortIndex (user-defined drag order), then by
          // printerName as a stable tie-breaker so unsorted items don't jitter.
          // sortIndex is now the primary signal — Active no longer pulls
          // cards to the top, the user owns the ordering.
          const all = [].concat(...PRINTER_BRANDS.map(b => cache[b]));
          all.sort((a, b) => {
            const sa = Number.isFinite(a.sortIndex) ? a.sortIndex : Number.MAX_SAFE_INTEGER;
            const sb = Number.isFinite(b.sortIndex) ? b.sortIndex : Number.MAX_SAFE_INTEGER;
            if (sa !== sb) return sa - sb;
            return String(a.printerName || "").localeCompare(String(b.printerName || ""));
          });
          state.printers = all;
          if (state.viewMode === "printer") renderPrintersView();
          // Live-update an open detail panel if it shows one of the changed docs
          if ($("printerPanel")?.classList.contains("open")) refreshOpenPrinterDetail();
        }, err => console.warn(`[printers/${brand}]`, err.code, err.message));
    });
  }

  function unsubscribePrinters() {
    if (Array.isArray(state.unsubPrinters)) {
      for (const fn of state.unsubPrinters) { try { fn(); } catch (_) {} }
    }
    state.unsubPrinters = [];
    state._printerCache = null;
    // Mirror the inventory model: when no subscription is active we're
    // not "loading", we just have nothing to show. The flag is flipped
    // back to true on the next subscribePrinters() call.
    state.printersLoading = false;
    // Close any open printer detail panel — its data belonged to the
    // outgoing account/session.
    if ($("printerPanel")?.classList.contains("open")) {
      try { closePrinterDetail(); } catch (_) {}
    }
  }

  /* ── Brand metadata for display (label + accent color + connection hint) ── */
  const PRINTER_BRAND_META = {
    bambulab:   { label: "Bambu Lab",  accent: "#1ba84e", connection: "MQTT (LAN)" },
    creality:   { label: "Creality",   accent: "#e22a2a", connection: "WebSocket / Klipper" },
    elegoo:     { label: "Elegoo",     accent: "#00a3e0", connection: "MQTT" },
    flashforge: { label: "FlashForge", accent: "#f39c12", connection: "HTTP" },
    snapmaker:  { label: "Snapmaker",  accent: "#9b59b6", connection: "WebSocket" }
  };

  /* ── Render the user's 3D printers in the main panel.
     Read-only listing — adding / editing / deleting printers happens in the
     mobile companion app. Sensitive fields (broker, password, ip, sn) are
     intentionally NEVER displayed; we project to the safe subset documented
     in docs/03-data-model.md → "If you only need to LIST printers".          */
  function renderPrintersView() {
    const host = $("invPrinterView");
    if (!host) return;

    // Friend view → print-friendly empty card (printers are owner-only via Firestore rules anyway)
    if (state.friendView) {
      host.innerHTML = `
        <div class="printers-empty-card">
          <span class="icon icon-printer icon-32"></span>
          <div class="printers-empty-title">${esc(t("printersFriendNATitle"))}</div>
          <div class="printers-empty-sub">${esc(t("printersFriendNASub"))}</div>
        </div>`;
      return;
    }

    // Loading — Firestore subscription is still warming up. We use the
    // same `.inv-loading` spinner the inventory view uses, just labelled
    // for printers. This avoids flashing the empty state while data
    // is on its way (cached snapshot can land in 50-100ms but a fresh
    // network round-trip can take several hundred ms).
    if (state.printersLoading && !state.printers.length) {
      host.innerHTML = `
        <div class="inv-loading printers-loading">
          <div class="inv-loading-spin"></div>
          <span>${esc(t("printersLoading") || t("invLoading"))}</span>
        </div>`;
      return;
    }

    if (!state.printers.length) {
      // Empty state — title + sub + 3 bullets explaining what printers
      // are for. Plus the same "Add a printer" call-to-action that
      // appears on the grid view, so a brand-new user has a one-click
      // path to their first printer right from the empty card.
      host.innerHTML = `
        <div class="printers-empty-card">
          <span class="icon icon-printer icon-32"></span>
          <div class="printers-empty-title">${esc(t("printersEmptyTitle"))}</div>
          <div class="printers-empty-sub">${esc(t("printersEmptySub"))}</div>
          <ul class="printers-empty-bullets">
            <li>${esc(t("printersEmptyBullet1"))}</li>
            <li>${esc(t("printersEmptyBullet2"))}</li>
            <li>${esc(t("printersEmptyBullet3"))}</li>
          </ul>
          <button type="button" class="adf-btn adf-btn--primary printers-empty-cta" id="printersEmptyAddBtn">
            <span class="icon icon-plus icon-13"></span>
            <span>${esc(t("printerAddTitle"))}</span>
          </button>
        </div>`;
      // Wire the CTA → same handler as the grid's "+" card.
      $("printersEmptyAddBtn")?.addEventListener("click", openPrinterBrandPicker);
      return;
    }

    // One flat grid — all brands mixed, ordered strictly by user-defined
    // sortIndex (set via drag & drop). Each card carries its brand pill so
    // multi-brand inventories remain visually distinguishable without
    // forcing brand sections that fight the user's preferred order.
    const cards = state.printers.map(p => {
      const meta      = PRINTER_BRAND_META[p.brand] || { label: p.brand, accent: "#888", connection: "" };
      const modelName = printerModelName(p.brand, p.printerModelId);
      const imgUrl    = printerImageUrlFor(p.brand, p.printerModelId);
      const safeName  = esc(p.printerName || "(unnamed)");
      const safeModel = esc(modelName);
      const updated   = p.updatedAt ? timeAgo(p.updatedAt) : "";
      // The thumbnail uses object-fit: contain so the printer photo always
      // shows in full. Falls back to the per-brand `no_printer.png` placeholder
      // (declared in every brand catalog as id "0") when modelId is missing.
      const fallback  = printerImageUrl(findPrinterModel(p.brand, "0"));
      const imgSrc    = imgUrl || fallback || "";
      // Trigger an HTTP ping for Snapmaker printers so the online dot
      // becomes accurate within ~2s of opening the printer view.
      if (p.brand === "snapmaker" && p.ip) snapPingPrinter(p);
      // Same for FlashForge — fires a 2.5s POST /detail probe.
      if (p.brand === "flashforge" && p.ip) ffgPingPrinter(p);
      const onlineBadge = p.brand === "flashforge"
        ? renderFfgOnlineBadge(p, "card")
        : renderSnapOnlineBadge(p, "card");
      return `
        <div class="printer-card${p.isActive ? " printer-card--active" : ""}"
             data-brand="${esc(p.brand)}" data-id="${esc(p.id)}"
             data-printer-key="${esc(`${p.brand}:${p.id}`)}"
             draggable="true">
          <div class="printer-card-drag" title="${esc(t("printerDragHint"))}" aria-hidden="true">
            <span class="printer-card-drag-dots"></span>
          </div>
          ${imgSrc ? `<div class="printer-card-thumb"><img src="${esc(imgSrc)}" alt="${esc(modelName)}" onerror="this.style.opacity='.15'"/></div>` : ""}
          <div class="printer-card-head">
            <span class="printer-brand-pill" style="--brand-accent:${meta.accent}">${esc(meta.label)}</span>
            ${p.isActive ? `<span class="printer-active-badge">${esc(t("printersActive"))}</span>` : ""}
          </div>
          <div class="printer-card-name">${safeName}</div>
          <div class="printer-card-model">${safeModel}</div>
          ${onlineBadge}
          <div class="printer-card-foot">
            <span class="printer-card-conn">${esc(meta.connection)}</span>
            ${updated ? `<span class="printer-card-updated">${esc(t("printersUpdated"))} · ${esc(updated)}</span>` : ""}
          </div>
        </div>`;
    }).join("");

    // Trailing "+" card so users can add a new printer directly from the
    // grid. The card itself isn't draggable / sortable — it's a fixed
    // affordance that always sits at the end of the flex flow.
    const addCard = `
      <button type="button" class="printer-card printer-card--add" id="printerAddCard">
        <span class="printer-add-plus"><span class="icon icon-plus icon-18"></span></span>
        <span class="printer-add-title">${esc(t("printerAddTitle"))}</span>
        <span class="printer-add-sub">${esc(t("printerAddSub"))}</span>
      </button>`;

    host.innerHTML = `
      <div class="printers-header">
        <div class="printers-header-text">
          <h3 class="printers-h3">${esc(t("printersTitle"))}</h3>
          <p class="printers-sub">${esc(t("printersSub", { n: state.printers.length }))}</p>
        </div>
      </div>
      <div class="printers-grid printers-grid--flex">${cards}${addCard}</div>`;

    // Wire click → open detail panel. Suppressed when a drag has just
    // happened so an accidental click at the end of a drop doesn't open
    // the detail panel for the dragged card.
    host.querySelectorAll(".printer-card:not(.printer-card--add)").forEach(el => {
      el.addEventListener("click", () => {
        if (_printerJustDragged) return;
        const brand = el.dataset.brand;
        const id    = el.dataset.id;
        if (brand && id) openPrinterDetail(brand, id);
      });
    });
    $("printerAddCard")?.addEventListener("click", openPrinterBrandPicker);

    wirePrinterDnd(host);
  }

  /* ── Printer drag & drop reordering ────────────────────────────────────
     Uses the native HTML5 DnD API on each card. On drop we persist the
     new order to Firestore by writing a fresh `sortIndex` (0, 1, 2, …)
     to every card's doc — a Firestore batch keeps the rewrite atomic
     even across the 5 brand subcollections. Each printer's brand is
     known from its `brand` property, which we set when ingesting the
     snapshot, so the path resolution is local.                            */
  let _printerJustDragged = false;
  let _printerDragId = null; // composite "brand:id" of the card being dragged

  function wirePrinterDnd(host) {
    const cards = Array.from(host.querySelectorAll(".printer-card"));
    cards.forEach(card => {
      card.addEventListener("dragstart", e => {
        _printerDragId = `${card.dataset.brand}:${card.dataset.id}`;
        // dataTransfer is required on some browsers for the drag image to render.
        try { e.dataTransfer.setData("text/plain", _printerDragId); } catch (_) {}
        try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
        card.classList.add("printer-card--dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("printer-card--dragging");
        host.querySelectorAll(".printer-card--drop-before, .printer-card--drop-after")
            .forEach(el => el.classList.remove("printer-card--drop-before", "printer-card--drop-after"));
        _printerDragId = null;
        // Suppress the click that fires right after a drop; reset on next tick
        _printerJustDragged = true;
        setTimeout(() => { _printerJustDragged = false; }, 50);
      });
      card.addEventListener("dragover", e => {
        if (!_printerDragId) return;
        const me = `${card.dataset.brand}:${card.dataset.id}`;
        if (me === _printerDragId) return; // can't drop on self
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
        // Choose before/after based on cursor position relative to the card center.
        const rect = card.getBoundingClientRect();
        const isVertical = rect.height > rect.width;
        const before = isVertical
          ? (e.clientY < rect.top + rect.height / 2)
          : (e.clientX < rect.left + rect.width / 2);
        card.classList.toggle("printer-card--drop-before", before);
        card.classList.toggle("printer-card--drop-after", !before);
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("printer-card--drop-before", "printer-card--drop-after");
      });
      card.addEventListener("drop", e => {
        if (!_printerDragId) return;
        const me = `${card.dataset.brand}:${card.dataset.id}`;
        if (me === _printerDragId) return;
        e.preventDefault();
        const before = card.classList.contains("printer-card--drop-before");
        card.classList.remove("printer-card--drop-before", "printer-card--drop-after");
        applyPrinterReorder(_printerDragId, me, before);
      });
    });
  }

  // Reorder state.printers by moving `dragId` next to `targetId`, then
  // persist the new sortIndex 0..N-1 to Firestore.
  function applyPrinterReorder(dragId, targetId, before) {
    const all = state.printers.slice();
    const find = id => all.findIndex(p => `${p.brand}:${p.id}` === id);
    const di = find(dragId);
    if (di < 0) return;
    const [moved] = all.splice(di, 1);
    let ti = find(targetId);
    if (ti < 0) return; // shouldn't happen
    if (!before) ti += 1;
    all.splice(ti, 0, moved);
    // Apply new sortIndex 0..N-1 in-memory so the next render is instant.
    all.forEach((p, idx) => { p.sortIndex = idx; });
    state.printers = all;
    renderPrintersView();
    persistPrinterSortIndices(all);
  }

  async function persistPrinterSortIndices(orderedPrinters) {
    const uid = state.activeAccountId;
    if (!uid) return;
    try {
      const db = fbDb(uid);
      const batch = db.batch();
      const ts = firebase.firestore.FieldValue.serverTimestamp();
      orderedPrinters.forEach((p, idx) => {
        const ref = db.collection("users").doc(uid)
                      .collection("printers").doc(p.brand)
                      .collection("devices").doc(p.id);
        // serverTimestamp ensures `updatedAt` is monotonic across the
        // 5 brand subcollections even when several clients write at once.
        batch.update(ref, { sortIndex: idx, updatedAt: ts });
      });
      await batch.commit();
    } catch (e) {
      // The next snapshot will re-establish the persisted order; we just
      // log so the user sees something went wrong without breaking the UI.
      console.warn("[printers] persist sortIndex failed:", e?.code, e?.message);
    }
  }

  /* ── Printer detail side panel ─────────────────────────────────────────
     Slide-in panel mirroring the inventory detail panel. Shows everything
     the user has on file for one printer, with sensitive credentials
     (password, MQTT access code, account secrets) masked behind an
     explicit Show toggle. Sensitive fields are still readable by the
     owner — the masking is purely a shoulder-surfing / screen-share
     defense, NOT a security boundary (Firestore rules are).               */
  let _activePrinter = null; // currently-open printer { brand, id, ...data }

  function openPrinterDetail(brand, id) {
    const printer = state.printers.find(p => p.brand === brand && p.id === id);
    if (!printer) return;
    _activePrinter = printer;
    renderPrinterDetail();
    $("printerPanel").classList.add("open");
    $("printerOverlay").classList.add("open");
    // Snapmaker U1 talks Moonraker over a local WebSocket — connect when
    // the sidebar opens so we can stream live temps + filament + job state.
    if (printer.brand === "snapmaker" && printer.ip) {
      snapConnect(printer);
    }
    // FlashForge — open the 2s HTTP polling loop on side-card open. The
    // poller stays alive until the side-card closes (closePrinterDetail).
    if (printer.brand === "flashforge" && printer.ip) {
      ffgConnect(printer);
    }
  }
  function closePrinterDetail() {
    // If the filament-edit bottom-sheet is open over this side-panel,
    // close it FIRST so the user doesn't end up with an orphaned
    // sheet floating over the rest of the app. Triggered when the
    // user clicks the dim area to the left of the panel — without
    // this, the panel slid out but the sheet stayed pinned to the
    // (now empty) right edge.
    if ($("snapFilEditSheet")?.classList.contains("open")) {
      try { closeSnapFilamentEdit(); } catch {}
    }
    $("printerPanel").classList.remove("open");
    $("printerOverlay").classList.remove("open");
    // Tear down the Snapmaker live connection if any was active for this
    // printer — keeps long-lived sockets from leaking when the sidebar
    // closes or when the user switches printers.
    if (_activePrinter?.brand === "snapmaker") {
      snapDisconnect(snapKey(_activePrinter));
    }
    // FlashForge — same lifecycle: stop the polling loop on close.
    if (_activePrinter?.brand === "flashforge") {
      ffgDisconnect(ffgKey(_activePrinter));
    }
    _activePrinter = null;
  }
  $("printerPanelClose")?.addEventListener("click", closePrinterDetail);
  $("printerOverlay")?.addEventListener("click", closePrinterDetail);
  // Escape key — closes the printer detail side-panel when it's open.
  // Replaces the role previously played by the visible ✕ button (now
  // removed). Backdrop click + Esc are the two close affordances.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("printerPanel")?.classList.contains("open")) {
      closePrinterDetail();
    }
  });
  // Gear button — opens the Printers Settings modal pre-filled with the
  // current printer's data so the user can edit fields and confirm.
  $("printerEditBtn")?.addEventListener("click", () => {
    if (!_activePrinter) return;
    openPrinterAddForm(_activePrinter.brand, _activePrinter);
  });

  // Re-render the detail panel against the live state.printers (so a
  // Firestore snapshot that updates the open printer is reflected without
  // closing the panel). Called on every snapshot when the panel is open.
  function refreshOpenPrinterDetail() {
    if (!_activePrinter) return;
    const fresh = state.printers.find(p => p.brand === _activePrinter.brand && p.id === _activePrinter.id);
    if (!fresh) { closePrinterDetail(); return; } // doc was deleted
    _activePrinter = fresh;
    renderPrinterDetail();
  }

  /* ══════════════════════════════════════════════════════════════════════
     Snapmaker Live integration (Moonraker over WebSocket)
     ══════════════════════════════════════════════════════════════════════
     Ported from the Flutter `SnapmakerWebSocketPage` (snapmaker_websocket_page.dart).
     Snapmaker U1 runs a Klipper / Moonraker stack on the printer; we open a
     WebSocket to ws://{ip}:7125/websocket and subscribe to printer objects
     to stream live temperatures, the filament loaded in each of up to 4
     extruders, and the active print job state.
     Phase 1 (this turn): read-only display + auto reconnect + camera embed.
     Phase 2 (later): manual filament edit, NFC scan, thumbnail metadata.
     ══════════════════════════════════════════════════════════════════════ */

  // Per-printer live state. Keyed by `${brand}:${id}` (same composite key
  // we use elsewhere). Value carries the WebSocket, latest snapshot, and
  // reconnect bookkeeping. Stays in module scope (not in `state`) since
  // it's transient — never persisted.
  const _snapConns = new Map();

  // Lightweight reachability cache, populated by snapPingPrinter (HTTP
  // GET to /server/info on the Moonraker port). Used to drive the
  // "Online / Offline" indicator in the printer grid + side card hero
  // even when no WebSocket session is open. Refreshed every 30 s.
  const _snapPings = new Map(); // key -> { online: bool|null, lastChecked: number }

  function snapKey(p) { return `${p.brand}:${p.id}`; }

  // Authoritative "is this Snapmaker reachable?" reading.
  // 1. If a live WebSocket exists, use its status (most accurate).
  // 2. Otherwise fall back to the last HTTP ping result.
  // 3. Returns `null` when we have no signal yet (renders as a "checking" dot).
  function snapIsOnline(printer) {
    if (printer?.brand !== "snapmaker") return null;
    const k = snapKey(printer);
    const conn = _snapConns.get(k);
    if (conn) return conn.status === "connected";
    const ping = _snapPings.get(k);
    return ping ? ping.online : null;
  }

  async function snapPingPrinter(printer) {
    if (!printer || printer.brand !== "snapmaker" || !printer.ip) return;
    const k = snapKey(printer);
    const cached = _snapPings.get(k);
    const now = Date.now();
    // 30 s cache — avoid pinging the same printer on every render.
    if (cached && now - cached.lastChecked < 30_000) return;
    _snapPings.set(k, { online: cached?.online ?? null, lastChecked: now });
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`http://${printer.ip}:7125/server/info`, {
        method: "GET",
        signal: ctrl.signal,
        cache: "no-store"
      });
      clearTimeout(tm);
      _snapPings.set(k, { online: res.ok, lastChecked: now });
    } catch (_) {
      _snapPings.set(k, { online: false, lastChecked: now });
    }
    // Patch the affected card / side-card without rebuilding everything.
    snapRefreshOnlineUI(k);
  }

  function snapPingAllPrinters() {
    for (const p of state.printers) {
      if (p.brand === "snapmaker" && p.ip) snapPingPrinter(p);
    }
  }
  // Background refresh — kicks in once the user has signed in and
  // state.printers is populated. We only ping while at least one
  // Snapmaker is in the list, otherwise it's a no-op.
  setInterval(snapPingAllPrinters, 30_000);

  // Surgical DOM update — replaces just the status dot + label in the
  // affected card and (if open) the side-card hero. Avoids re-rendering
  // the whole grid on every ping resolution.
  function snapRefreshOnlineUI(key) {
    document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
      const p = state.printers.find(x => snapKey(x) === key);
      el.outerHTML = renderSnapOnlineBadge(p, "card");
    });
    if (_activePrinter && snapKey(_activePrinter) === key) {
      const host = $("ppOnlineRow");
      if (host) host.outerHTML = renderSnapOnlineBadge(_activePrinter, "side");
    }
  }

  // Single source of truth for the badge HTML — used in both the grid
  // card and the side-card. `where` toggles a class for slightly
  // different styling between the two locations.
  function renderSnapOnlineBadge(printer, where) {
    if (!printer || printer.brand !== "snapmaker") return "";
    const online = snapIsOnline(printer);
    const cls = online === true ? "is-online" : (online === false ? "is-offline" : "is-checking");
    const lbl = online === true ? t("snapStatusOnline")
              : online === false ? t("snapStatusOffline")
              : t("snapStatusConnecting");
    const id  = where === "side" ? ` id="ppOnlineRow"` : "";
    return `<span class="printer-online printer-online--${esc(where)} ${cls}"${id}>
              <span class="printer-online-dot"></span>
              <span class="printer-online-lbl">${esc(lbl)}</span>
            </span>`;
  }

  // Open or refresh the connection for a printer. Idempotent — calling
  // again on the same printer is a no-op while the socket is OPEN.
  function snapConnect(printer) {
    const key = snapKey(printer);
    const existing = _snapConns.get(key);
    if (existing && existing.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
      // Already connected/connecting — if the ip changed, tear down first.
      if (existing.ip === printer.ip) return;
      snapDisconnect(key);
    }
    const conn = {
      ip: printer.ip,
      key,
      ws: null,
      status: "connecting", // "connecting" | "connected" | "offline" | "error"
      lastError: null,
      retry: 0,
      retryTimer: null,
      // Latest parsed data — kept flat for cheap reads in the renderer.
      data: {
        temps: {},          // { e1_temp, e1_target, e2_temp, ... bed_temp, bed_target }
        filaments: [],      // [{ color: "#RRGGBB", vendor, type, subType, official }] × up to 4
        printState: null,   // "standby" | "printing" | "paused" | "complete" | "error"
        printFilename: null,
        printDuration: 0,
        progress: 0,        // 0..1
        currentLayer: 0,
        totalLayer: 0,
        printPreviewUrl: null,  // slicer thumbnail (set by snapFetchMetadata)
        printEstimated: null    // estimated_time in seconds (from metadata)
      }
    };
    _snapConns.set(key, conn);
    snapOpenSocket(conn);
  }

  function snapOpenSocket(conn) {
    if (!conn.ip) { conn.status = "error"; conn.lastError = "no IP"; return; }
    const url = `ws://${conn.ip}:7125/websocket`;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) {
      console.warn("[snap] WS construct failed:", e?.message);
      conn.status = "error";
      conn.lastError = String(e?.message || e);
      snapNotifyChange(conn);
      snapScheduleReconnect(conn);
      return;
    }
    conn.ws = ws;
    conn.status = "connecting";
    snapNotifyChange(conn);

    // Wrap send so every outbound payload is captured for the log view.
    const sendLogged = (obj) => {
      const json = JSON.stringify(obj);
      snapLogPush(conn, "→", json);
      ws.send(json);
    };

    ws.addEventListener("open", () => {
      conn.status = "connected";
      conn.lastError = null;
      conn.retry = 0;
      // Subscribe to all the printer objects we care about. The 4 extruder
      // names match the Snapmaker U1 4-tool firmware naming convention.
      sendLogged({
        jsonrpc: "2.0",
        id: 1,
        method: "printer.objects.subscribe",
        params: { objects: {
          print_task_config: null,
          print_stats: null,
          virtual_sdcard: null,
          display_status: null,
          extruder:  ["temperature", "target"],
          extruder1: ["temperature", "target"],
          extruder2: ["temperature", "target"],
          extruder3: ["temperature", "target"],
          heater_bed:["temperature", "target"]
        }}
      });
      // Initial snapshot — `subscribe` returns the current state synchronously
      // but we send a query too in case the firmware version doesn't.
      sendLogged({
        jsonrpc: "2.0", id: 1001,
        method: "printer.objects.query",
        params: { objects: {
          print_stats: null, virtual_sdcard: null, display_status: null,
          extruder: null, extruder1: null, extruder2: null, extruder3: null,
          heater_bed: null
        }}
      });
      // Status changed (connecting → connected) — the hero camera depends
      // on this, so we ask for a full re-render not just the live block.
      snapNotifyChange(conn, /*statusChanged*/ true);
    });

    ws.addEventListener("message", ev => {
      // Capture every inbound frame for the log first — so even non-status
      // notifications (logs / RPC results we don't otherwise inspect) are
      // visible to the developer.
      snapLogPush(conn, "←", ev.data);

      let obj; try { obj = JSON.parse(ev.data); } catch { return; }
      let status = null;
      if (obj.result && obj.result.status) status = obj.result.status;
      else if ((obj.method === "notify_status_update" || obj.method === "notify_status_changed")
               && Array.isArray(obj.params) && obj.params[0]) {
        status = obj.params[0];
      }
      if (status && typeof status === "object") snapMergeStatus(conn, status);
      // Always notify so the log row appears even when the payload didn't
      // carry a status update (RPC results, etc.).
      snapNotifyChange(conn);
    });

    ws.addEventListener("close", () => {
      conn.status = "offline";
      snapNotifyChange(conn, /*statusChanged*/ true);
      snapScheduleReconnect(conn);
    });

    ws.addEventListener("error", () => {
      // The 'close' handler will fire next; just record the error here.
      conn.lastError = "websocket error";
    });
  }

  function snapScheduleReconnect(conn) {
    if (conn.retryTimer) return;
    if (!_snapConns.has(conn.key)) return; // disposed
    // Capped exponential backoff: 2s, 4s, 8s, 16s, then 30s.
    conn.retry = Math.min(conn.retry + 1, 5);
    const delay = Math.min(2000 * (1 << (conn.retry - 1)), 30000);
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      // The user might have closed the panel in the meantime.
      if (!_snapConns.has(conn.key)) return;
      snapOpenSocket(conn);
    }, delay);
  }

  function snapDisconnect(key) {
    const conn = _snapConns.get(key);
    if (!conn) return;
    if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
    if (conn.ws) {
      try { conn.ws.close(); } catch (_) {}
      conn.ws = null;
    }
    _snapConns.delete(key);
  }

  // Merge a Moonraker `status` payload into our flat `data` shape.
  function snapMergeStatus(conn, status) {
    const d = conn.data;

    // Live temps: extruder*, heater_bed
    const tempPair = (objName, prefix) => {
      const obj = status[objName];
      if (!obj || typeof obj !== "object") return;
      if (typeof obj.temperature === "number") d.temps[`${prefix}_temp`]   = obj.temperature;
      if (typeof obj.target === "number")      d.temps[`${prefix}_target`] = obj.target;
    };
    tempPair("extruder",   "e1");
    tempPair("extruder1",  "e2");
    tempPair("extruder2",  "e3");
    tempPair("extruder3",  "e4");
    tempPair("heater_bed", "bed");

    // Filament info — `print_task_config` carries arrays of length 4.
    const cfg = status.print_task_config;
    if (cfg && typeof cfg === "object") {
      const colors  = Array.isArray(cfg.filament_color_rgba) ? cfg.filament_color_rgba : null;
      const vendors = Array.isArray(cfg.filament_vendor)     ? cfg.filament_vendor     : null;
      const types   = Array.isArray(cfg.filament_type)       ? cfg.filament_type       : null;
      const subs    = Array.isArray(cfg.filament_sub_type)   ? cfg.filament_sub_type   : null;
      const offs    = Array.isArray(cfg.filament_official)   ? cfg.filament_official   : null;
      // Only overwrite if at least one array landed — `notify_status_update`
      // for a single field would otherwise nuke the others.
      if (colors || vendors || types || subs || offs) {
        const merged = d.filaments.length === 4 ? d.filaments.slice() : [{},{},{},{}];
        for (let i = 0; i < 4; i++) {
          merged[i] = { ...(merged[i] || {}) };
          if (colors  && colors[i]  != null) merged[i].color    = snapParseRgbaHex(String(colors[i]));
          if (vendors && vendors[i] != null) merged[i].vendor   = String(vendors[i]);
          if (types   && types[i]   != null) merged[i].type     = String(types[i]);
          if (subs    && subs[i]    != null) merged[i].subType  = String(subs[i]);
          if (offs    && offs[i]    != null) merged[i].official = !!offs[i];
        }
        d.filaments = merged;
      }
    }

    // Print job state
    const ps = status.print_stats;
    if (ps && typeof ps === "object") {
      if (typeof ps.state === "string")          d.printState = ps.state;
      if (typeof ps.filename === "string")       d.printFilename = ps.filename;
      if (typeof ps.print_duration === "number") d.printDuration = ps.print_duration;
      // Layer counters live under `print_stats.info` — Moonraker schema.
      if (ps.info && typeof ps.info === "object") {
        if (typeof ps.info.current_layer === "number") d.currentLayer = ps.info.current_layer;
        if (typeof ps.info.total_layer   === "number") d.totalLayer   = ps.info.total_layer;
      }
      // Trigger an HTTP metadata fetch for the slicer-rendered thumbnail.
      // Only does work when the filename actually changes.
      const rel = snapFilenameRel(d.printFilename);
      if (rel) snapFetchMetadata(conn, rel);
    }
    const ds = status.display_status;
    if (ds && typeof ds === "object" && typeof ds.progress === "number") {
      d.progress = ds.progress;
    }
    const vsd = status.virtual_sdcard;
    if (vsd && typeof vsd === "object" && typeof vsd.progress === "number" && !d.progress) {
      d.progress = vsd.progress;
    }
  }

  /* ── Snapmaker manual filament edit — bottom sheet ───────────────
     Click on a colour square (or its edit icon) → opens a modal
     pre-filled with the current filament data. Confirming sends the
     SET_PRINT_FILAMENT_CONFIG g-code via the existing WebSocket so
     the printer's `print_task_config` updates and the new values
     stream back through `notify_status_update`.                       */
  // 24 colour presets shown in the "Select Color" screen, ordered to
  // match the mobile companion app's palette (5 per row, neutrals → cool
  // → green → warm → red/pink → purple). The 25th slot is a "custom"
  // chip that opens the native colour picker.
  const SNAP_FIL_COLOR_PRESETS = [
    "#000000", "#808080", "#CDCDCD", "#FFFFFF", "#135E7E",
    "#B6C3CB", "#4AB1F0", "#2641E9", "#2CDCA6", "#157F5F",
    "#1CB01C", "#C2E58C", "#FFE600", "#FF9933", "#6E4519",
    "#B58137", "#F0E6D6", "#D4C8AA", "#ED1C24", "#EC5A85",
    "#FF00FF", "#C8A4D6", "#8526D3", "#4B1F97"
  ];
  // Vendor → materials map — iso to the mobile companion. The mobile
  // ships with these 8 brands and the Generic 10-material catalogue;
  // each brand falls back to the Generic list when it has no specific
  // products (matches the Flutter "vendorToLabels.putIfAbsent + union
  // fallback" pattern).
  const SNAP_FIL_VENDOR_MATERIALS = {
    "Generic":   ["PLA", "PETG", "ABS", "TPU", "ABS-AF", "ABS-CF", "ASA", "ASA-CF", "ASA-GF", "Biopolymer"],
    "JamgHe":    [],
    "Landu":     [],
    "R3D":       [],
    "Rosa3D":    [],
    "Snapmaker": [],
    "Sunlu":     [],
    "eSun":      []
  };
  // Backwards compat — the chip-based code paths still reference these.
  const SNAP_FIL_BRANDS    = Object.keys(SNAP_FIL_VENDOR_MATERIALS);
  const SNAP_FIL_MATERIALS = SNAP_FIL_VENDOR_MATERIALS["Generic"];

  // Sort materials with priority — PLA / PETG / ABS / TPU come first
  // when they appear EXACTLY (variants like "ABS-AF" or "PLA Matte"
  // fall to the alphabetical section, matching the mobile app's order).
  const SNAP_FIL_PRIORITY = ["PLA", "PETG", "ABS", "TPU"];
  function snapSortMaterials(list) {
    const upper    = list.map(s => s.toUpperCase());
    const used     = new Set();
    const priority = [];
    for (const p of SNAP_FIL_PRIORITY) {
      const idx = upper.findIndex((u, i) => !used.has(i) && u === p);
      if (idx >= 0) { priority.push(list[idx]); used.add(idx); }
    }
    const rest = list.filter((_, i) => !used.has(i))
                     .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return [...priority, ...rest];
  }
  let _snapFilEdit = null; // { brand, deviceId, extruderIndex, conn }
  let _sfeSelectedBrand = "";    // last chip-or-text value picked
  let _sfeSelectedMaterial = ""; // last chip-or-text value picked

  // Convert "#RRGGBB" or "#RRGGBBAA" to a Klipper-friendly 8-char
  // lowercase RGBA hex string. We default alpha to ff (full opacity).
  function snapColorToRgbaHex(hex) {
    let v = (hex || "").trim();
    if (v.startsWith("#")) v = v.slice(1);
    if (v.length === 6) v += "ff";
    return v.toLowerCase().slice(0, 8);
  }

  // Sanitise free-text inputs so the resulting g-code line stays
  // parseable on the Klipper side (no embedded spaces, no quotes).
  function snapSanitiseGcodeArg(s) {
    return String(s || "").trim().replace(/\s+/g, "-").replace(/["'`]/g, "");
  }

  // Send a single g-code line via the printer's existing WebSocket.
  // Logs the outbound frame so it's visible in the request log too.
  function snapSendGcode(conn, script) {
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) return false;
    const msg = {
      jsonrpc: "2.0", id: 201,
      method: "printer.gcode.script",
      params: { script }
    };
    const json = JSON.stringify(msg);
    snapLogPush(conn, "→", json);
    conn.ws.send(json);
    return true;
  }

  // Render the LEFT column: list of vendors. Selected one is highlighted.
  function snapFilRenderVendorList(selected) {
    return SNAP_FIL_BRANDS.map(v => {
      const meta = PRINTER_BRAND_META[v.toLowerCase().replace(/\s+/g, "")];
      const accentStyle = meta ? `style="--brand-accent:${meta.accent}"` : "";
      const isSel = v.toLowerCase() === (selected || "").toLowerCase();
      return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}${meta ? " sfe-fil-row--brand" : ""}"
                      data-val="${esc(v)}" ${accentStyle}>${esc(v)}</button>`;
    }).join("");
  }
  // Render the RIGHT column: materials for the chosen vendor. Falls back
  // to the Generic catalogue when the vendor has no specific products.
  function snapFilRenderMaterialList(vendor, selectedMat) {
    const list  = (SNAP_FIL_VENDOR_MATERIALS[vendor]?.length
                   ? SNAP_FIL_VENDOR_MATERIALS[vendor]
                   : SNAP_FIL_VENDOR_MATERIALS["Generic"]);
    const sorted = snapSortMaterials(list);
    return sorted.map(m => {
      const isSel = m.toLowerCase() === (selectedMat || "").toLowerCase();
      return `<button type="button" class="sfe-fil-row${isSel ? " is-selected" : ""}" data-val="${esc(m)}">
                <span class="sfe-fil-row-text">${esc(m)}</span>
                ${isSel ? `<span class="sfe-fil-row-check">✓</span>` : ""}
              </button>`;
    }).join("");
  }

  function openSnapFilamentEdit(printer, extruderIndex) {
    const conn = _snapConns.get(snapKey(printer));
    // The modal opens whatever the WS state — opening it should always
    // feel responsive on click. If the connection is down the Send
    // button will surface the error at submit time.
    const fil = (conn?.data?.filaments?.[extruderIndex]) || {};
    // RFID-locked filaments (`fil.official === true`) still open the
    // sheet, but in READ-ONLY mode: SAME layout / order / presentation
    // as the editable sheet, controls just disabled. The user reads
    // what the printer reported but can't mutate it.
    const readonly = !!fil.official;
    const sheetEl = $("snapFilEditSheet");
    if (sheetEl) sheetEl.classList.toggle("sfe-sheet--readonly", readonly);
    // Title swaps between "Edit filament" and "Read-only filament".
    const titleEl = $("snapFilEditTitle");
    if (titleEl) {
      const newKey = readonly ? "snapFilEditTitleReadonly" : "snapFilEditTitle";
      titleEl.textContent = t(newKey);
      titleEl.dataset.i18n = newKey; // keep i18n applier in sync if locale changes
    }
    // Native disabled flips — same controls, just inert. We re-apply
    // every open since the sheet is reused for every extruder click.
    const subEl   = $("sfeSubtype");
    const applyEl = $("snapFilEditSave");
    if (subEl)   subEl.disabled   = readonly;
    if (applyEl) applyEl.disabled = readonly;
    _snapFilEdit = { brand: printer.brand, deviceId: printer.id, extruderIndex, key: snapKey(printer), readonly };
    _sfeSelectedBrand    = fil.vendor  || "";
    _sfeSelectedMaterial = fil.type    || "";

    // Pre-fill form values
    const colorInp = $("sfeColorInput");
    const vendorInp= $("sfeVendor");
    const matInp   = $("sfeMaterial");
    const subInp   = $("sfeSubtype");
    if (colorInp) colorInp.value = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color)) ? fil.color.slice(0, 7) : "#FF5722";
    // Custom-text inputs: only show a value when the current vendor/material
    // is NOT in the predefined chip lists (otherwise the chip + the input
    // would echo the same value, which is noisy).
    if (vendorInp) vendorInp.value = SNAP_FIL_BRANDS.some(b => b.toLowerCase() === _sfeSelectedBrand.toLowerCase()) ? "" : (fil.vendor || "");
    if (matInp)    matInp.value    = SNAP_FIL_MATERIALS.some(m => m.toLowerCase() === _sfeSelectedMaterial.toLowerCase()) ? "" : (fil.type || "");

    // Sub-type select — populated from the id_aspect catalog so we
    // always send a documented value to the printer. Filter out the
    // "-" / "None" placeholders. Sort alphabetically but pin "Basic"
    // to the top since it's the default + most common.
    if (subInp && subInp.tagName === "SELECT") {
      const aspects = (state.db.aspect || [])
        .filter(a => a && a.label && a.label !== "-" && a.label.toLowerCase() !== "none")
        .map(a => a.label);
      aspects.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      const basicIdx = aspects.findIndex(l => l.toLowerCase() === "basic");
      if (basicIdx > 0) { aspects.splice(basicIdx, 1); aspects.unshift("Basic"); }
      // Add the current value as a custom option if it doesn't match any
      // aspect — preserves user-typed legacy values without silently
      // dropping them.
      const cur = String(fil.subType || "").trim();
      const isKnown = !!cur && aspects.some(a => a.toLowerCase() === cur.toLowerCase());
      const opts = [];
      if (cur && !isKnown) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} (custom)</option>`);
      for (const label of aspects) {
        const isSel = isKnown ? cur.toLowerCase() === label.toLowerCase()
                              : label === "Basic";
        opts.push(`<option value="${esc(label)}"${isSel ? " selected" : ""}>${esc(label)}</option>`);
      }
      subInp.innerHTML = opts.join("");
    }

    // Header sub on the summary screen
    // Subtitle deliberately blank — the user already sees which
    // printer + extruder they tapped from in the side card behind the
    // sheet, no need to repeat it here.
    $("snapFilEditSub").textContent = "";
    $("sfeError").hidden = true;

    // Render the colour grid (24 presets + 1 custom). The native picker
    // The custom slot has its own inline <input type="color"> rendered
    // by sfeRenderColorGrid — we just feed it the initial colour.
    const initialColor = (fil.color && /^#[0-9a-f]{6}/i.test(fil.color)) ? fil.color.slice(0, 7) : "#FF5722";
    sfeRenderColorGrid(initialColor);

    // Two-column filament picker. Pre-select the vendor that matches
    // the current filament (or the first one if nothing matches).
    const vendorList = $("sfeVendorList");
    const matList    = $("sfeMaterialList");
    if (vendorList) {
      const vendorMatch = SNAP_FIL_BRANDS.find(b => b.toLowerCase() === _sfeSelectedBrand.toLowerCase())
                       || SNAP_FIL_BRANDS[0];
      _sfeSelectedBrand = vendorMatch;
      vendorList.innerHTML = snapFilRenderVendorList(vendorMatch);
    }
    if (matList) {
      matList.innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
    }

    // Always start with the sub-pickers closed so only the summary shows.
    sfeCloseFilamentSheet();
    sfeCloseColorSheet();
    sfeUpdateSummary();

    // Show the sheet
    $("snapFilEditSheet").classList.add("open");
    $("snapFilEditSheet").setAttribute("aria-hidden", "false");
    $("snapFilEditBackdrop").classList.add("open");
  }

  // Both sub-pickers (Filament + Colour) are now standalone sheets that
  // STACK on top of the summary sheet — the summary stays visible
  // behind so the user keeps their context. Each has its own slide-up
  // animation triggered by the .open class.
  function sfeOpenFilamentSheet() {
    $("sfeFilamentSheet")?.classList.add("open");
    $("sfeFilamentSheet")?.setAttribute("aria-hidden", "false");
  }
  function sfeCloseFilamentSheet() {
    $("sfeFilamentSheet")?.classList.remove("open");
    $("sfeFilamentSheet")?.setAttribute("aria-hidden", "true");
  }
  function sfeOpenColorSheet() {
    $("sfeColorSheet")?.classList.add("open");
    $("sfeColorSheet")?.setAttribute("aria-hidden", "false");
  }
  function sfeCloseColorSheet() {
    $("sfeColorSheet")?.classList.remove("open");
    $("sfeColorSheet")?.setAttribute("aria-hidden", "true");
  }

  // Refresh the summary screen — Line 1 (filament summary text), Line 2
  // (colour dot). Called whenever a sub-screen commits a new value.
  function sfeUpdateSummary() {
    const v   = _sfeSelectedBrand    || "—";
    const m   = _sfeSelectedMaterial || "—";
    const sub = $("sfeSubtype")?.value?.trim() || "";
    const summary = sub ? `${v} ${m} ${sub}` : `${v} ${m}`;
    const valEl = $("sfeFilSummaryVal");
    if (valEl) valEl.textContent = summary;
    const dot = $("sfeColorSummaryDot");
    if (dot) dot.style.background = $("sfeColorInput")?.value || "#888";
  }

  // Render the colour grid: 24 presets + a 25th "custom" slot. The
  // custom slot is a wrapper containing a transparent `<input
  // type="color">` overlaid on top — the wrapper shows the current
  // colour + edit icon, the input receives the click and anchors the
  // OS-native picker right where it lives. Without this overlay trick
  // the picker pops up in the top-left of the window because a
  // `display:none` input has no visual anchor.
  function sfeRenderColorGrid(currentColor) {
    const grid = $("sfeColorGrid");
    if (!grid) return;
    const cur = (currentColor || "").toLowerCase();
    const presetCells = SNAP_FIL_COLOR_PRESETS.map(c => {
      const isSel = c.toLowerCase() === cur;
      return `<button type="button" class="sfe-color-cell${isSel ? " is-selected" : ""}"
                      data-color="${esc(c)}"
                      style="background:${esc(c)}"
                      title="${esc(c)}"></button>`;
    }).join("");
    const safeColor = currentColor && /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#888888";
    const customCell = `
      <div class="sfe-color-cell sfe-color-cell--custom" id="sfeColorCustomBtn"
           style="background:${esc(safeColor)}"
           title="${esc(t("snapFilEditCustomColor") || "Custom")}">
        <span class="icon icon-edit icon-13"></span>
        <input type="color" class="sfe-color-cell-native" id="sfeColorPickerInline"
               value="${esc(safeColor)}" aria-label="Custom color"/>
      </div>`;
    grid.innerHTML = presetCells + customCell;
  }

  function closeSnapFilamentEdit() {
    $("snapFilEditSheet")?.classList.remove("open");
    $("snapFilEditSheet")?.setAttribute("aria-hidden", "true");
    $("snapFilEditBackdrop")?.classList.remove("open");
    // Both stacked sub-sheets follow the summary down so nothing is
    // left dangling when the whole edit flow is closed.
    sfeCloseFilamentSheet();
    sfeCloseColorSheet();
    _snapFilEdit = null;
  }
  // ✕ on the SUMMARY closes the whole flow (summary + any open picker).
  // ✕ on a picker only closes that picker (handled separately below).
  $("snapFilEditClose")?.addEventListener("click", closeSnapFilamentEdit);
  $("snapFilEditBackdrop")?.addEventListener("click", closeSnapFilamentEdit);
  $("sfeColorClose")?.addEventListener("click", () => {
    sfeUpdateSummary();
    sfeCloseColorSheet();
  });

  // ── Summary → sub-sheet navigation. Each sub-picker is its own sheet
  // that stacks on top of the summary; the summary stays visible behind. ─
  $("sfeOpenFilament")?.addEventListener("click", () => {
    // Read-only mode (RFID-locked filament): the summary rows are
    // still visible but the user can't dive into sub-pickers — the
    // chevron is hidden but the underlying button still listens, so
    // we guard here so clicks don't pop open the picker silently.
    if (_snapFilEdit?.readonly) return;
    sfeOpenFilamentSheet();
    // Auto-scroll the selected vendor into view in the left column.
    setTimeout(() => {
      const sel = $("sfeVendorList")?.querySelector(".is-selected");
      if (sel) sel.scrollIntoView({ block: "center", behavior: "auto" });
    }, 0);
  });
  $("sfeOpenColor")?.addEventListener("click", () => {
    if (_snapFilEdit?.readonly) return; // read-only: no colour picker
    sfeOpenColorSheet();
  });

  // Back buttons on the stacked sub-sheets — close the sheet, leave
  // the summary visible behind, and refresh its preview values.
  $("sfeFilamentBack")?.addEventListener("click", () => {
    sfeUpdateSummary();
    sfeCloseFilamentSheet();
  });
  $("sfeColorBack")?.addEventListener("click", () => {
    sfeUpdateSummary();
    sfeCloseColorSheet();
  });
  // Filament close (X on the picker header) — same behaviour as Back
  // (both keep the summary alive, only kill the picker).
  $("sfeFilamentClose")?.addEventListener("click", () => {
    sfeUpdateSummary();
    sfeCloseFilamentSheet();
  });

  // Sub-type changes update the summary line live. `change` covers
  // <select> dropdowns; `input` covers any future free-text fallback.
  $("sfeSubtype")?.addEventListener("change", sfeUpdateSummary);
  $("sfeSubtype")?.addEventListener("input",  sfeUpdateSummary);

  // ── Filament screen — vendor/material clicks ──────────────────────
  $("sfeVendorList")?.addEventListener("click", e => {
    const row = e.target.closest(".sfe-fil-row");
    if (!row) return;
    _sfeSelectedBrand = row.dataset.val || "";
    $("sfeVendorList").querySelectorAll(".sfe-fil-row").forEach(r =>
      r.classList.toggle("is-selected", r === row));
    const matList = $("sfeMaterialList");
    if (matList) matList.innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
    const v = $("sfeVendor"); if (v) v.value = "";
  });
  // Tapping a material commits the (vendor, material) pair and goes
  // back to the summary screen — same flow as the mobile app. Picking
  // a new filament also wipes the sub-type input: the previous
  // sub-type was specific to the old filament and is meaningless for
  // the new one (e.g. "Speed Matt" stops making sense once you switch
  // from Rosa3D ASA to Bambu Lab PETG).
  $("sfeMaterialList")?.addEventListener("click", e => {
    const row = e.target.closest(".sfe-fil-row");
    if (!row) return;
    _sfeSelectedMaterial = row.dataset.val || "";
    const m = $("sfeMaterial"); if (m) m.value = "";
    // Reset the sub-type to "Basic" when picking a new filament — the
    // previous sub-type was specific to the old filament. Falls back
    // to the first option if "Basic" isn't there for some reason.
    const sub = $("sfeSubtype");
    if (sub && sub.tagName === "SELECT") {
      const basicOpt = Array.from(sub.options).find(o => o.value.toLowerCase() === "basic");
      if (basicOpt) sub.value = basicOpt.value;
      else if (sub.options.length) sub.selectedIndex = 0;
    } else if (sub) {
      sub.value = "";
    }
    // Re-render with the green check, then close the picker — the
    // summary sheet underneath shows the new "Brand Material" line.
    $("sfeMaterialList").innerHTML = snapFilRenderMaterialList(_sfeSelectedBrand, _sfeSelectedMaterial);
    setTimeout(() => {
      sfeUpdateSummary();
      sfeCloseFilamentSheet();
    }, 180);
  });

  // ── Color screen — preset cell click + custom slot inline input ──
  // The custom slot has its native <input type="color"> overlaid on top
  // (transparent), so a click on the slot opens the OS picker anchored
  // to the slot itself. We listen to `input` (live drag) and `change`
  // (final pick) via delegation since the grid is re-rendered on each
  // colour change.
  $("sfeColorGrid")?.addEventListener("click", e => {
    // Don't intercept clicks bubbling from the inline picker — let the
    // native input handle them (it's covered by the wrapper anyway).
    if (e.target.closest("#sfeColorPickerInline")) return;
    const cell = e.target.closest(".sfe-color-cell:not(.sfe-color-cell--custom)");
    if (!cell) return;
    const c = cell.dataset.color;
    if (!c) return;
    $("sfeColorInput").value = c;
    sfeRenderColorGrid(c);
    setTimeout(() => {
      sfeUpdateSummary();
      sfeCloseColorSheet();
    }, 150);
  });
  // Live preview while the user drags the OS picker — updates the
  // hidden input + repaints the custom slot so it reflects the chosen
  // hue in real time. Delegated since the grid re-renders.
  $("sfeColorGrid")?.addEventListener("input", e => {
    if (!e.target.matches?.("#sfeColorPickerInline")) return;
    const c = e.target.value;
    $("sfeColorInput").value = c;
    // Update just the wrapper background — re-rendering the whole grid
    // here would close the OS picker mid-drag.
    const wrap = e.target.closest(".sfe-color-cell--custom");
    if (wrap) wrap.style.background = c;
  });
  // Final commit (the user closed the OS picker) — re-render the grid
  // so the new colour shows as "selected" if it matches a preset, then
  // bounce back to the summary.
  $("sfeColorGrid")?.addEventListener("change", e => {
    if (!e.target.matches?.("#sfeColorPickerInline")) return;
    const c = e.target.value;
    $("sfeColorInput").value = c;
    sfeRenderColorGrid(c);
    setTimeout(() => {
      sfeUpdateSummary();
      sfeCloseColorSheet();
    }, 100);
  });

  // Send button → build the SET_PRINT_FILAMENT_CONFIG line and push it
  // to the printer. Format ported from the Flutter mobile app.
  $("snapFilEditSave")?.addEventListener("click", async () => {
    if (!_snapFilEdit) return;
    const conn = _snapConns.get(_snapFilEdit.key);
    if (!conn) return;
    const errEl = $("sfeError");
    errEl.hidden = true;

    // Vendor + material come either from a chip (last clicked) or from
    // the custom-text input — whichever the user touched most recently.
    const vendor   = snapSanitiseGcodeArg($("sfeVendor").value || _sfeSelectedBrand)    || "Generic";
    const material = snapSanitiseGcodeArg($("sfeMaterial").value || _sfeSelectedMaterial) || "PLA";
    const subtype  = snapSanitiseGcodeArg($("sfeSubtype").value);
    const rgba     = snapColorToRgbaHex($("sfeColorInput").value);

    // Snapmaker firmware requires every named arg to be present in the
    // command line — omitting `FILAMENT_SUBTYPE` causes it to silently
    // ignore the whole call. We always emit the key, with an empty
    // value when the user didn't provide a sub-type.
    const parts = [
      "SET_PRINT_FILAMENT_CONFIG",
      `CONFIG_EXTRUDER=${_snapFilEdit.extruderIndex}`,
      `VENDOR=${vendor}`,
      `FILAMENT_TYPE=${material}`,
      `FILAMENT_SUBTYPE=${subtype}`,
      `FILAMENT_COLOR_RGBA=${rgba}`
    ];
    const script = parts.join(" ");

    // Mirror the outgoing g-code to DevTools so the user can verify the
    // exact line that was pushed to Klipper without scrolling the log.
    console.log("[snap] → gcode:", script);

    const btn = $("snapFilEditSave");
    btn.classList.add("loading");
    btn.disabled = true;
    try {
      const ok = snapSendGcode(conn, script);
      if (!ok) throw new Error("websocket not open");
      // Close immediately; the printer's notify_status_update will arrive
      // moments later and refresh the colour square / vendor labels.
      closeSnapFilamentEdit();
    } catch (e) {
      console.warn("[snap] filament edit send failed:", e?.message);
      errEl.textContent = t("snapFilEditError");
      errEl.hidden = false;
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  });

  /* ── Moonraker file path / thumbnail helpers ──────────────────────
     Klipper exposes the active job's filename as something like
     "/printer_data/gcodes/folder/Lame ryobi.gcode" — we have to peel it
     down to "folder/Lame ryobi.gcode" before we can pass it to the
     metadata endpoint, and again to build thumbnail URLs.              */
  function snapNormalizePath(path) {
    const out = [];
    for (const raw of String(path || "").split("/")) {
      const part = raw.trim();
      if (!part || part === ".") continue;
      if (part === "..") { if (out.length) out.pop(); continue; }
      out.push(part);
    }
    return out.join("/");
  }
  function snapJoinPath(a, b) {
    const left  = (a || "").trim();
    const right = (b || "").trim();
    if (!left)  return snapNormalizePath(right);
    if (!right) return snapNormalizePath(left);
    return snapNormalizePath(`${left}/${right}`);
  }
  function snapFilenameRel(absPath) {
    let s = String(absPath || "").trim();
    if (!s) return "";
    if (s.startsWith("/")) {
      const i = s.indexOf("/gcodes/");
      if (i >= 0) s = s.slice(i + "/gcodes/".length);
      else {
        const i2 = s.indexOf("/printer_data/gcodes/");
        if (i2 >= 0) s = s.slice(i2 + "/printer_data/gcodes/".length);
      }
    } else if (s.startsWith("gcodes/")) {
      s = s.slice("gcodes/".length);
    }
    return snapNormalizePath(s);
  }
  function snapParentFolder(filename) {
    const c = snapNormalizePath(filename);
    const i = c.lastIndexOf("/");
    return i <= 0 ? "" : c.substring(0, i);
  }
  function snapFileUrl(ip, relativePath) {
    const cleaned = snapNormalizePath(relativePath);
    const parts = cleaned.split("/").filter(Boolean).map(encodeURIComponent);
    return `http://${ip}:7125/server/files/gcodes/${parts.join("/")}`;
  }
  function snapBestThumb(metadata) {
    const arr = metadata?.thumbnails;
    if (!Array.isArray(arr) || !arr.length) return null;
    let best = null, bestScore = -1;
    for (const t of arr) {
      if (!t || typeof t !== "object") continue;
      const w = +t.width || 0, h = +t.height || 0, sz = +t.size || 0;
      const score = (w > 0 && h > 0) ? (w * h) : sz;
      if (score >= bestScore) { bestScore = score; best = t; }
    }
    return best;
  }
  function snapThumbUrl(ip, filename, metadata) {
    const t = snapBestThumb(metadata);
    if (!t) return null;
    const rel = String(t.relative_path || t.thumbnail_path || "").trim();
    if (!rel) return null;
    const folder = snapParentFolder(filename);
    return snapFileUrl(ip, snapJoinPath(folder, rel));
  }

  // GET http://{ip}:7125/server/files/metadata?filename=...
  // Stores the slicer thumbnail URL + estimated print time on the
  // connection so the job card can render them. Idempotent — guarded by
  // `_lastMetaFile` so we don't refetch on every WS frame.
  async function snapFetchMetadata(conn, relFilename) {
    if (!relFilename || !conn.ip) return;
    if (conn.data._lastMetaFile === relFilename) return;
    conn.data._lastMetaFile = relFilename;
    const url = `http://${conn.ip}:7125/server/files/metadata?filename=${encodeURIComponent(relFilename)}`;
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) return;
      const json = await res.json();
      const meta = (json && json.result) ? json.result : json;
      if (!meta || typeof meta !== "object") return;
      conn.data.printPreviewUrl = snapThumbUrl(conn.ip, relFilename, meta) || null;
      conn.data.printEstimated  = (typeof meta.estimated_time === "number") ? meta.estimated_time : null;
      snapNotifyChange(conn);
    } catch (_) {
      // Network failure is non-fatal — the card falls back to the
      // printer's catalog image and skips the estimated-time display.
    }
  }

  // Convert a Klipper RGBA-hex string ("#RRGGBBAA" or "RRGGBB") to a
  // browser-friendly "#RRGGBB" string, dropping the alpha.
  function snapParseRgbaHex(s) {
    let v = (s || "").trim();
    if (!v) return null;
    if (v.startsWith("#")) v = v.slice(1);
    if (v.length === 8) v = v.slice(0, 6); // drop alpha
    if (v.length !== 6) return null;
    return "#" + v.toUpperCase();
  }

  // Whenever the live data changes we update the side card if it's
  // still showing this printer.
  //   • Default path: cheap re-render of `#snapLive` (data updates only).
  //   • statusChanged=true: full re-render of the side card via
  //     renderPrinterDetail — needed because the hero camera iframe is
  //     conditional on the connection being open.
  let _snapRenderRaf = null;
  let _snapRenderStatusFlag = false;
  function snapNotifyChange(conn, statusChanged = false) {
    if (!_activePrinter) return;
    if (snapKey(_activePrinter) !== conn.key) return;
    if (statusChanged) _snapRenderStatusFlag = true;
    if (_snapRenderRaf) return; // coalesce bursts
    _snapRenderRaf = requestAnimationFrame(() => {
      _snapRenderRaf = null;
      const fullRerender = _snapRenderStatusFlag;
      _snapRenderStatusFlag = false;
      if (fullRerender) {
        renderPrinterDetail();
      } else {
        // Live data block
        const liveHost = $("snapLive");
        if (liveHost) liveHost.innerHTML = renderSnapmakerLiveInner(_activePrinter);
        // Request-log block — the log no longer has a nested scroll
        // (the panel body scrolls instead), so a plain innerHTML swap
        // is enough. Older entries stay visible above; new ones append
        // at the top of the list because we sort newest-first.
        const logHost = $("snapLog");
        if (logHost) logHost.innerHTML = renderSnapmakerLogInner(_activePrinter);
        const countEl = $("snapLogCount");
        if (countEl) {
          const c = _snapConns.get(snapKey(_activePrinter))?.log?.length || 0;
          countEl.textContent = String(c);
        }
      }
    });
  }

  // Format helpers for the live block
  function snapFmtTemp(v) { return (typeof v === "number" && isFinite(v)) ? `${Math.round(v)}` : "—"; }
  function snapFmtTempPair(cur, tgt) {
    return `${snapFmtTemp(cur)}/${snapFmtTemp(tgt)}°C`;
  }
  function snapFmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
  }
  // Pick black or white text for a coloured background using sRGB luma —
  // matches the contrast convention used elsewhere in the app.
  function snapTextColor(hex) {
    if (!hex || hex.length < 7) return "#fff";
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.55 ? "#000" : "#fff";
  }
  // Inline SVGs for the small temp icons — kept as renderer constants so
  // they pick up `currentColor` from the parent without extra CSS wiring.
  const SNAP_ICON_NOZZLE = `<svg class="snap-temp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v6l-3 4-3-4z"/><path d="M9 17q1 2 0 4"/><path d="M12 17q1 2 0 4"/><path d="M15 17q1 2 0 4"/></svg>`;
  const SNAP_ICON_BED    = `<svg class="snap-temp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="16" x2="21" y2="16"/><path d="M7 12q1-3 0-5"/><path d="M12 12q1-3 0-5"/><path d="M17 12q1-3 0-5"/></svg>`;
  const SNAP_ICON_CLOCK  = `<svg class="snap-job-time-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`;

  // Returns the inner HTML for the Snapmaker live container.
  // Layout (matches the TigerTag mobile companion app):
  //   1. Connection header (LED + status + IP)
  //   2. Camera (full-width, on top — first signal of "yes the printer is there")
  //   3. Print-job card (only when actively printing)
  //   4. Temperature row — compact pills "26/0°C" for each E + bed
  //   5. Filament grid — big coloured squares with material name centered,
  //      vendor + sub-type below
  function renderSnapmakerLiveInner(p) {
    const conn = _snapConns.get(snapKey(p));
    if (!conn) {
      return `
        <div class="snap-empty">
          <span class="icon icon-cloud icon-18"></span>
          <span>${esc(t("snapNoConnection"))}</span>
        </div>`;
    }
    const d = conn.data;

    // ── Connection header removed — the Online/Offline badge now lives
    // in the panel-title (next to the brand+model pills). See
    // renderPrinterDetail() for that markup. We keep the function
    // structure so partial re-renders only patch the data blocks below.

    // ── Camera was here previously — now lives in the hero (replaces the
    // static product photo when the printer is connected). See
    // renderPrinterDetail() for the swap logic.

    // ── 3. Print-job card ────────────────────────────────────────────
    // Only rendered when the WebSocket is actually connected — otherwise
    // we'd be showing a frozen snapshot (potentially with stale "printing"
    // state from before the link dropped) which is more confusing than
    // helpful. While disconnected the panel hero already carries the
    // Online/Offline badge, so the user has the connection signal they
    // need without this card.
    const isConnected = conn.status === "connected";
    let jobHtml = "";
    if (isConnected) {
      const jobState  = d.printState || "standby";
      const isActive  = !["standby", "complete", "cancelled"].includes(jobState);
      const pct       = isActive ? Math.round(((d.progress || 0) * 100)) : 0;
      const leafName  = isActive && d.printFilename
                      ? snapFilenameRel(d.printFilename).split("/").pop()
                      : "";
      // Thumbnail: prefer the slicer preview from /server/files/metadata.
      // Fallback to the printer's catalog image so the card never looks
      // empty even before metadata has loaded.
      const fallbackImg = printerImageUrlFor(p.brand, p.printerModelId)
                       || printerImageUrl(findPrinterModel(p.brand, "0"));
      const thumbUrl  = (isActive && d.printPreviewUrl) ? d.printPreviewUrl : (fallbackImg || "");
      const layerText = isActive && (d.currentLayer || d.totalLayer)
                      ? `${d.currentLayer || 0}/${d.totalLayer || 0}` : "";
      const durationText = isActive ? snapFmtDuration(d.printDuration) : "0m";
      const stateLabel = t("snapState_" + jobState) || jobState;
      const nameLine = leafName
        ? `<div class="snap-job-name" title="${esc(leafName)}">${esc(leafName)}</div>`
        : `<div class="snap-job-name snap-job-name--idle">${esc(t("snapJobNoActive") || "—")}</div>`;
      jobHtml = `
        <div class="snap-job snap-job--${esc(jobState)}">
          <div class="snap-job-thumb"${thumbUrl ? ` style="background-image:url('${esc(thumbUrl)}')"` : ""}></div>
          <div class="snap-job-info">
            ${nameLine}
            <div class="snap-job-stats">
              <span class="snap-job-pct">${pct}%</span>
              <span class="snap-job-time">${SNAP_ICON_CLOCK} <span>${esc(durationText)}</span></span>
            </div>
            <div class="snap-job-bar"><span style="width:${pct}%"></span></div>
            <div class="snap-job-foot">
              <span class="snap-job-state snap-job-state--${esc(jobState)}">${esc(stateLabel)}</span>
              ${layerText ? `<span class="snap-job-layers">${esc(layerText)}</span>` : ""}
            </div>
          </div>
        </div>`;
    }

    // ── 4. Temperature row — one pill per active extruder + bed ─────
    // "Active" = the firmware reported either a current or a target temp
    // for this tool. We always include the bed if it reports anything.
    const tempPills = [];
    for (let i = 1; i <= 4; i++) {
      const cur = d.temps[`e${i}_temp`];
      const tgt = d.temps[`e${i}_target`];
      if (typeof cur !== "number" && typeof tgt !== "number") continue;
      const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
      tempPills.push(`
        <div class="snap-temp${heating ? " snap-temp--heating" : ""}">
          ${SNAP_ICON_NOZZLE}
          <span class="snap-temp-val">${esc(snapFmtTempPair(cur, tgt))}</span>
        </div>`);
    }
    if (typeof d.temps.bed_temp === "number" || typeof d.temps.bed_target === "number") {
      const cur = d.temps.bed_temp, tgt = d.temps.bed_target;
      const heating = (typeof tgt === "number" && tgt > 0 && typeof cur === "number" && cur < tgt - 1);
      tempPills.push(`
        <div class="snap-temp snap-temp--bed${heating ? " snap-temp--heating" : ""}">
          ${SNAP_ICON_BED}
          <span class="snap-temp-val">${esc(snapFmtTempPair(cur, tgt))}</span>
        </div>`);
    }
    const tempsHtml = tempPills.length
      ? `<section class="snap-block">
           <h4 class="snap-block-title">${esc(t("snapTemperatureTitle"))}</h4>
           <div class="snap-temps">${tempPills.join("")}</div>
         </section>`
      : "";

    // ── 5. Filament grid — big coloured squares ─────────────────────
    // We render a square for every extruder slot that has either a
    // filament definition OR a reported temp (so a slot with no filament
    // loaded still appears, with an empty/dashed square).
    const filCards = [];
    for (let i = 1; i <= 4; i++) {
      const fil  = d.filaments[i - 1] || {};
      const cur  = d.temps[`e${i}_temp`];
      const tgt  = d.temps[`e${i}_target`];
      const has  = !!(fil.color || fil.vendor || fil.type || fil.subType
                    || typeof cur === "number" || typeof tgt === "number");
      if (!has) continue;
      const color = fil.color || null;
      const fg    = color ? snapTextColor(color) : "var(--text)";
      // Inside the coloured square: the BASE material (type) only —
      // never the subtype. e.g. "PLA", "PETG", "ABS".
      const squareLabel = fil.type || t("snapNoFilament");
      // Below the square: brand on the first line, full identity
      // ("Type Subtype") on the second — same hierarchy a user reads
      // from a real spool label. Falls back gracefully when subtype
      // isn't reported (older firmware).
      const typeAndSub = fil.type
        ? (fil.subType ? `${fil.type} ${fil.subType}` : fil.type)
        : (fil.subType || "—");
      // The whole card is the click-target. Editable slots open the
      // sheet in mutate mode; RFID-locked slots open the SAME sheet
      // in read-only mode (no chevrons / no subtype select / no
      // Apply button). The `data-snap-fil-edit` attribute is set on
      // ALL filament cards so the closest() walk in the click
      // delegation catches every inner click — readonly state is
      // resolved inside openSnapFilamentEdit by reading fil.official.
      const editable = !fil.official;
      filCards.push(`
        <div class="snap-fil snap-fil--editable${editable ? "" : " snap-fil--locked"}"
             data-snap-fil-edit="1"
             data-extruder-idx="${i - 1}"
             title="${editable ? esc(t("snapFilEditableTip")) : esc(t("snapFilLockedTip"))}">
          <div class="snap-fil-tag">E${i}</div>
          <div class="snap-fil-square${color ? "" : " snap-fil-square--empty"}"
               style="${color ? `background:${esc(color)};color:${esc(fg)};border-color:${esc(color)};` : ""}">
            <span class="snap-fil-main">${esc(squareLabel)}</span>
          </div>
          <div class="snap-fil-meta">
            <span class="snap-fil-status icon ${fil.official ? "icon-eye-on snap-fil-status--locked" : "icon-edit"} icon-13"
                  aria-hidden="true"></span>
            <div class="snap-fil-vendor">${esc(fil.vendor || "—")}</div>
            <div class="snap-fil-sub">${esc(typeAndSub)}</div>
          </div>
        </div>`);
    }
    const filamentsHtml = filCards.length
      ? `<section class="snap-block">
           <h4 class="snap-block-title">${esc(t("snapFilamentTitle"))}</h4>
           <div class="snap-fil-grid">${filCards.join("")}</div>
         </section>`
      : "";

    return `
      ${jobHtml}
      ${tempsHtml}
      ${filamentsHtml}`;
  }

  /* ── Request log — what we send / what the printer answers ──────────
     Stored on `conn.log` as an array of { dir: "→"|"←", ts, summary, raw }.
     The UI is a collapsible section at the bottom of the live block.
     Each line is clickable to copy the raw JSON to the clipboard.       */
  // Visible-buffer cap. Older entries fall off so we never grow without
  // bound — 100 frames is enough to debug a request flow without bloating
  // memory on long-running sessions.
  const SNAP_LOG_MAX = 100;
  function snapLogPush(conn, dir, raw) {
    // When the user has frozen the log via the Pause toggle, drop new
    // frames so what's on screen stays stable for inspection.
    if (conn.logPaused) return;
    if (!conn.log) conn.log = [];
    let summary = "";
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (obj?.method) summary = obj.method;
      else if (obj?.result && typeof obj.result === "object") {
        const keys = obj.result.status ? Object.keys(obj.result.status) : Object.keys(obj.result);
        summary = "result · " + keys.slice(0, 4).join(", ");
      } else summary = "(no method)";
      if (typeof obj?.id !== "undefined") summary += `  id:${obj.id}`;
    } catch { summary = "(non-json)"; }
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
    conn.log.push({ dir, ts, summary, raw: rawStr });
    if (conn.log.length > SNAP_LOG_MAX) conn.log.splice(0, conn.log.length - SNAP_LOG_MAX);
  }

  // Inner contents of the log container — replaced on every re-render.
  // Rows are click-to-expand: each shows a one-line summary; on click,
  // the full pretty-printed JSON appears inline with its own copy
  // button. Pausing the stream (via the toolbar) freezes the log so the
  // user can inspect a long frame at their own pace.
  // Send a hand-crafted JSON-RPC frame from the paste textarea straight
  // through the WebSocket. Useful for testing custom Moonraker calls
  // without leaving the UI. The pasted payload is forwarded VERBATIM —
  // we don't wrap it in a JSON-RPC envelope, the user is expected to
  // provide a complete `{ jsonrpc, id, method, params }` object.
  function snapSendCustomJson() {
    const ta  = $("snapLogPasteInput");
    const err = $("snapLogPasteError");
    if (!ta || !err) return;
    err.hidden = true;

    const conn = _activePrinter ? _snapConns.get(snapKey(_activePrinter)) : null;
    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) {
      err.textContent = t("snapPasteNotConnected") || "Printer not connected.";
      err.hidden = false;
      return;
    }

    let obj;
    try { obj = JSON.parse(ta.value); }
    catch (e) {
      err.textContent = (t("snapPasteInvalidJson") || "Invalid JSON:") + " " + (e?.message || e);
      err.hidden = false;
      return;
    }

    const json = JSON.stringify(obj);
    snapLogPush(conn, "→", json);
    try {
      conn.ws.send(json);
    } catch (e) {
      err.textContent = (t("snapPasteSendError") || "Send failed:") + " " + (e?.message || e);
      err.hidden = false;
      return;
    }
    // Re-render the log so the new outbound frame appears at the top.
    const host = $("snapLog");
    if (host) host.innerHTML = renderSnapmakerLogInner(_activePrinter);
    const countEl = $("snapLogCount");
    if (countEl) countEl.textContent = String(conn.log?.length || 0);
    // Visual confirmation on the Send button.
    const btn = $("snapLogPasteSendBtn");
    if (btn) {
      btn.classList.add("snap-log-paste-send--ok");
      setTimeout(() => btn.classList.remove("snap-log-paste-send--ok"), 700);
    }
  }

  function renderSnapmakerLogInner(p) {
    const conn = _snapConns.get(snapKey(p));
    const log = conn?.log || [];
    if (!log.length) {
      return `<div class="snap-log-empty">${esc(t("snapLogEmpty"))}</div>`;
    }
    const rows = log.slice().reverse().map((e, i) => {
      let pretty = e.raw;
      try { pretty = JSON.stringify(JSON.parse(e.raw), null, 2); } catch (_) {}
      // We index from the END (newest first) because that's the visible
      // order. The expanded flag lives on the entry object so it persists
      // across partial re-renders (when paused, no re-render happens; when
      // streaming, expansions reset — that's the trade-off).
      const expanded = !!e.expanded;
      return `
        <div class="snap-log-row snap-log-row--${e.dir === "→" ? "out" : "in"}${expanded ? " snap-log-row--expanded" : ""}"
             data-log-idx="${log.length - 1 - i}">
          <button type="button" class="snap-log-row-head" data-row-toggle="1">
            <span class="snap-log-dir">${esc(e.dir)}</span>
            <span class="snap-log-ts">${esc(e.ts)}</span>
            <span class="snap-log-summary">${esc(e.summary)}</span>
            <span class="snap-log-row-chev icon icon-chevron-r icon-13"></span>
          </button>
          <div class="snap-log-detail"${expanded ? "" : " hidden"}>
            <button type="button" class="snap-log-detail-copy" data-copy="${esc(pretty)}" title="${esc(t("copyLabel"))}">
              <span class="icon icon-copy icon-13"></span>
              <span>${esc(t("copyLabel"))}</span>
            </button>
            <pre class="snap-log-detail-pre">${esc(pretty)}</pre>
          </div>
        </div>`;
    }).join("");
    return `<div class="snap-log">${rows}</div>`;
  }

  function renderPrinterDetail() {
    const p = _activePrinter;
    if (!p) return;
    const meta = PRINTER_BRAND_META[p.brand] || { label: p.brand, accent: "#888", connection: "" };

    // Title shown in the panel header. Brand + model pills are injected
    // next to it (was previously inside the hero — moved up so the user
    // doesn't see the printer name twice).
    $("printerPanelTitle").textContent = p.printerName || t("printerPanelTitle");

    // Resolve catalog metadata for the model. The legacy `featuresHtml`
    // (camera / multi-extruder / etc. pills under the photo) was
    // removed — it took vertical space without conveying anything the
    // user couldn't already see in the live blocks below the hero.
    const modelName    = printerModelName(p.brand, p.printerModelId);
    const heroImgUrl   = printerImageUrlFor(p.brand, p.printerModelId)
                      || printerImageUrl(findPrinterModel(p.brand, "0"));

    // Body — read-only summary. Identity / Connection / Credentials are
    // edited through the gear button which opens the Printers Settings
    // modal in edit mode. The remaining hero is purely informational and
    // the Raw data section is kept as a debug aid.
    // For Snapmaker we want the camera to span the FULL width of the side
    // card (edge-to-edge, no rounded frame). It sits ABOVE the hero block
    // so it reads as the headline media. When the WS isn't connected we
    // fall back to the static product photo INSIDE the hero (existing).
    const snapConn = (p.brand === "snapmaker") ? _snapConns.get(snapKey(p)) : null;
    const showCam  = !!(snapConn && snapConn.status === "connected" && snapConn.ip);

    // The TigerTag mobile app uses the WebRTC player page exposed by
    // Snapmaker / Crowsnest — same approach we take here. The iframe
    // loads the printer's own player HTML (`/webcam/webrtc`) which knows
    // how to negotiate the stream. MJPEG via `/?action=stream` returned
    // a black frame on Snapmaker U1, so WebRTC is the working path.
    const camBannerHtml = showCam
      ? `<div class="pp-cam-full">
           <iframe class="snap-camera-frame" src="${esc(`http://${snapConn.ip}/webcam/webrtc`)}"
                   sandbox="allow-scripts allow-same-origin"
                   loading="lazy" referrerpolicy="no-referrer"
                   allow="autoplay"></iframe>
         </div>`
      : "";

    // Hero photo — only when the camera is NOT taking over.
    const heroImgHtml = (!showCam && heroImgUrl)
      ? `<div class="pp-hero-img"><img src="${esc(heroImgUrl)}" alt="${esc(modelName)}" onerror="this.style.opacity='.15'"/></div>`
      : "";

    // Snapmaker live data block (no wrapping section — direct child of
    // the panel body, snap-head + temps + filaments inline). Re-rendered
    // partially via #snapLive on every WS frame.
    const snapLiveHtml = (p.brand === "snapmaker")
      ? `<div id="snapLive" class="snap-live-host">${renderSnapmakerLiveInner(p)}</div>`
      : "";

    // Snapmaker WS request log — sibling collapsible section at the
    // bottom, same visual style as the Raw data section. Re-rendered
    // partially via #snapLog on every WS frame.
    const isPaused = !!(snapConn?.logPaused);
    const snapLogHtml = (p.brand === "snapmaker")
      ? `<section class="pp-section pp-section--collapsible snap-log-section" data-collapsed="true">
           <button class="pp-section-head pp-section-head--btn" type="button">
             <span>${esc(t("snapLogTitle"))}
                   <span class="snap-log-count" id="snapLogCount">${(snapConn?.log?.length) || 0}</span>
                   ${isPaused ? `<span class="snap-log-paused-tag" id="snapLogPausedTag">${esc(t("snapLogPaused"))}</span>` : ""}
             </span>
             <span class="pp-chev icon icon-chevron-r icon-14"></span>
           </button>
           <div class="pp-section-body">
             <div class="snap-log-toolbar">
               <button type="button" class="snap-log-btn snap-log-btn--pause${isPaused ? " is-paused" : ""}" id="snapLogPauseBtn"
                       data-paused="${isPaused ? "true" : "false"}">
                 <span class="icon ${isPaused ? "icon-play" : "icon-pause"} icon-13"></span>
                 <span class="label">${esc(t(isPaused ? "snapLogResume" : "snapLogPause"))}</span>
               </button>
               <button type="button" class="snap-log-btn" id="snapLogClearBtn">
                 <span class="icon icon-trash icon-13"></span>
                 <span>${esc(t("snapLogClear"))}</span>
               </button>
             </div>

             <!-- Custom JSON paste zone — for hand-crafted Moonraker calls. -->
             <details class="snap-log-paste">
               <summary>${esc(t("snapPasteTitle"))}</summary>
               <textarea class="snap-log-paste-input" id="snapLogPasteInput"
                         spellcheck="false" autocapitalize="off" autocomplete="off"
                         placeholder='{
  "jsonrpc": "2.0",
  "id": 999,
  "method": "printer.objects.query",
  "params": { "objects": { "extruder": ["temperature", "target"] } }
}'></textarea>
               <div class="snap-log-paste-row">
                 <span class="snap-log-paste-error" id="snapLogPasteError" hidden></span>
                 <button type="button" class="snap-log-btn snap-log-paste-send" id="snapLogPasteSendBtn">
                   <span class="icon icon-play icon-13"></span>
                   <span>${esc(t("snapPasteSend"))}</span>
                 </button>
               </div>
             </details>

             <div id="snapLog">${renderSnapmakerLogInner(p)}</div>
           </div>
         </section>`
      : "";

    // Pills (next to the printer name on the title row): brand + model.
    // The online/offline status badge is rendered SEPARATELY on its
    // own row beneath the title — see #printerPanelStatus below.
    const titlePillsHtml = `
      <span class="pp-brand-pill pp-brand-pill--sm" style="--brand-accent:${meta.accent}">${esc(meta.label)}</span>
      ${modelName && modelName !== "—" ? `<span class="pp-model-pill pp-model-pill--sm">${esc(modelName)}</span>` : ""}
    `;
    $("printerPanelPills").innerHTML = titlePillsHtml;
    // Status row UNDER the title — Snapmaker (WebSocket) + FlashForge (HTTP
    // poll) both provide reachability info. Other brands fall through to
    // an empty string so the row collapses to zero height.
    const statusEl = $("printerPanelStatus");
    if (statusEl) {
      statusEl.innerHTML = (p.brand === "flashforge")
        ? renderFfgOnlineBadge(p, "side")
        : renderSnapOnlineBadge(p, "side");
    }

    // Online status now lives in the panel header (next to the pills),
    // not under the camera. Trigger a fresh ping anyway so the badge
    // updates as soon as the side card opens.
    if (p.brand === "snapmaker" && p.ip) snapPingPrinter(p);
    if (p.brand === "flashforge" && p.ip) ffgPingPrinter(p);

    $("printerPanelBody").innerHTML = `
      ${camBannerHtml}
      <div class="pp-hero">
        ${p.isActive ? `<span class="pp-active">${esc(t("printersActive"))}</span>` : ""}
        ${heroImgHtml}
      </div>

      ${snapLiveHtml}

      ${state.debugEnabled ? `
      <section class="pp-section pp-section--collapsible" data-collapsed="true">
        <button class="pp-section-head pp-section-head--btn" type="button">
          <span>${esc(t("printerSecRaw"))}</span>
          <span class="pp-chev icon icon-chevron-r icon-14"></span>
        </button>
        <div class="pp-section-body">
          <div class="pp-raw-wrap">
            <button class="pp-raw-copy pp-copy" data-copy-raw="1" title="${esc(t("copyLabel"))}">
              <span class="icon icon-copy icon-13"></span>
              <span>${esc(t("copyLabel"))}</span>
            </button>
            <pre class="pp-raw">${esc(JSON.stringify(p, null, 2))}</pre>
          </div>
        </div>
      </section>

      ${snapLogHtml}` : ""}`;

    // Wire interactions
    const body = $("printerPanelBody");
    body.querySelectorAll(".pp-eye").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const wrap = btn.closest(".pp-row-val");
        const sec  = wrap?.querySelector(".pp-secret");
        if (!sec) return;
        const revealed = sec.dataset.revealed === "true";
        if (revealed) {
          sec.dataset.revealed = "false";
          const val = sec.dataset.secret || "";
          sec.textContent = "•".repeat(Math.min(12, val.length));
          btn.title = t("printerSecretShow");
        } else {
          sec.dataset.revealed = "true";
          sec.textContent = sec.dataset.secret || "";
          btn.title = t("printerSecretHide");
        }
      });
    });
    body.querySelectorAll(".pp-copy").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        // Two flavors: per-row copy (data-copy="value") and the raw-JSON
        // copy in the collapsible Raw data section (data-copy-raw="1").
        // Reading the JSON from _activePrinter rather than a frozen
        // dataset string keeps the copy in sync with live snapshots.
        let v = "";
        if (btn.dataset.copyRaw === "1") {
          v = _activePrinter ? JSON.stringify(_activePrinter, null, 2) : "";
        } else {
          v = btn.dataset.copy || "";
        }
        if (!v) return;
        try {
          navigator.clipboard.writeText(v);
          btn.classList.add("pp-copy--ok");
          setTimeout(() => btn.classList.remove("pp-copy--ok"), 900);
        } catch (_) {}
      });
    });
    body.querySelectorAll(".pp-section--collapsible .pp-section-head--btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const sec = btn.closest(".pp-section");
        const collapsed = sec.dataset.collapsed === "true";
        sec.dataset.collapsed = collapsed ? "false" : "true";
      });
    });

    // Snapmaker log interactions — delegated on the panel body so partial
    // re-renders of #snapLog don't lose the wiring. (The collapsible
    // section header itself is wired by the standard pass above — adding
    // it here would double-toggle and the section would never visibly open.)
    if (!body.dataset.snapDelegated) {
      body.dataset.snapDelegated = "1";
      body.addEventListener("click", e => {
        // Filament edit — color square or edit icon (only when editable).
        const filEditTrigger = e.target.closest("[data-snap-fil-edit]");
        if (filEditTrigger) {
          const card = filEditTrigger.closest(".snap-fil");
          const idx = parseInt(card?.dataset?.extruderIdx ?? "-1", 10);
          if (idx >= 0 && _activePrinter) openSnapFilamentEdit(_activePrinter, idx);
          return;
        }
        // Pause / Resume — surgical update. We deliberately AVOID a full
        // renderPrinterDetail() here because that resets the section's
        // `data-collapsed` attribute to its template default, which
        // would close the Request Log section right under the user.
        if (e.target.closest("#snapLogPauseBtn")) {
          e.preventDefault();
          e.stopPropagation();
          if (!_activePrinter) return;
          const conn = _snapConns.get(snapKey(_activePrinter));
          if (!conn) return;
          conn.logPaused = !conn.logPaused;
          const btn  = $("snapLogPauseBtn");
          const icon = btn?.querySelector(".icon");
          const lbl  = btn?.querySelector(".label");
          if (btn) {
            btn.classList.toggle("is-paused", conn.logPaused);
            btn.dataset.paused = String(conn.logPaused);
          }
          if (icon) {
            icon.classList.toggle("icon-pause", !conn.logPaused);
            icon.classList.toggle("icon-play",   conn.logPaused);
          }
          if (lbl) lbl.textContent = t(conn.logPaused ? "snapLogResume" : "snapLogPause");
          // PAUSED tag next to the count — create / remove on the fly.
          let tag = $("snapLogPausedTag");
          if (conn.logPaused && !tag) {
            const headSpan = btn?.closest(".snap-log-section")
                                ?.querySelector(".pp-section-head--btn > span");
            if (headSpan) {
              tag = document.createElement("span");
              tag.id = "snapLogPausedTag";
              tag.className = "snap-log-paused-tag";
              tag.textContent = t("snapLogPaused");
              headSpan.appendChild(tag);
            }
          } else if (!conn.logPaused && tag) {
            tag.remove();
          }
          return;
        }
        // Clear — wipe the visible buffer in place.
        if (e.target.closest("#snapLogClearBtn")) {
          e.preventDefault();
          e.stopPropagation();
          if (!_activePrinter) return;
          const conn = _snapConns.get(snapKey(_activePrinter));
          if (!conn) return;
          conn.log = [];
          const host = $("snapLog");
          if (host) host.innerHTML = renderSnapmakerLogInner(_activePrinter);
          const countEl = $("snapLogCount");
          if (countEl) countEl.textContent = "0";
          return;
        }
        // Send custom JSON — paste zone in the log section.
        if (e.target.closest("#snapLogPasteSendBtn")) {
          e.preventDefault();
          e.stopPropagation();
          snapSendCustomJson();
          return;
        }
        // Copy button inside an expanded row — copies the pretty JSON.
        const copyBtn = e.target.closest(".snap-log-detail-copy");
        if (copyBtn) {
          e.stopPropagation();
          const v = copyBtn.dataset.copy || "";
          if (!v) return;
          try {
            navigator.clipboard.writeText(v);
            copyBtn.classList.add("snap-log-detail-copy--ok");
            setTimeout(() => copyBtn.classList.remove("snap-log-detail-copy--ok"), 700);
          } catch (_) {}
          return;
        }
        // Row head click — toggle expansion. We persist the flag on the
        // log entry object so it survives the next partial re-render
        // (typical when paused — no new pushes mean the rows array is
        // stable and the index → entry mapping holds).
        const head = e.target.closest("[data-row-toggle]");
        if (head) {
          const rowEl = head.closest(".snap-log-row");
          if (!rowEl || !_activePrinter) return;
          const conn = _snapConns.get(snapKey(_activePrinter));
          const idx = parseInt(rowEl.dataset.logIdx || "-1", 10);
          if (conn?.log?.[idx]) conn.log[idx].expanded = !conn.log[idx].expanded;
          // DOM swap — toggle the hidden attribute + the row's class
          rowEl.classList.toggle("snap-log-row--expanded");
          const detail = rowEl.querySelector(".snap-log-detail");
          if (detail) detail.toggleAttribute("hidden");
        }
      });
    }

    // Inline-edit wiring for every [data-edit-field] node — connection rows,
    // credentials, and the hero printerName.
    body.querySelectorAll("[data-edit-field]").forEach(el => {
      // Click on a child .pp-eye / .pp-copy / .pp-pencil should NOT enter
      // edit mode (the pencil is a visual hint; the row itself is the
      // hit target). The eye/copy buttons stop propagation themselves.
      el.addEventListener("click", e => {
        // Ignore clicks that originated on a button inside the cell —
        // those have their own behaviour (eye toggle, copy).
        if (e.target.closest(".pp-eye, .pp-copy")) return;
        startInlineEdit(el);
      });
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startInlineEdit(el);
        }
      });
    });
  }

  // Replace the cell content with an <input>. Enter/blur saves, Escape cancels.
  function startInlineEdit(cellEl) {
    if (cellEl.classList.contains("pp-row-val--editing")) return;
    if (!_activePrinter) return;
    const field    = cellEl.dataset.editField;
    const isSecret = cellEl.dataset.editSecret === "1";
    const raw      = cellEl.dataset.editRaw || "";
    if (!field) return;

    cellEl.classList.add("pp-row-val--editing");

    // Stash original DOM so we can restore on cancel without re-rendering
    const originalHtml = cellEl.innerHTML;

    const input = document.createElement("input");
    input.type = "text"; // password fields stay text — the row already had a reveal toggle, which we drop while editing
    input.className = "pp-edit-input";
    input.value = raw;
    input.setAttribute("aria-label", t("printerEditHint"));
    input.spellcheck = false;
    input.autocomplete = "off";
    input.autocapitalize = "off";

    cellEl.innerHTML = "";
    cellEl.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const cancel = () => {
      if (committed) return;
      committed = true;
      cellEl.innerHTML = originalHtml;
      cellEl.classList.remove("pp-row-val--editing");
    };
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newVal = input.value.trim();
      if (newVal === raw) {
        // Nothing changed — just restore.
        cellEl.innerHTML = originalHtml;
        cellEl.classList.remove("pp-row-val--editing");
        return;
      }
      cellEl.classList.add("pp-row-val--saving");
      cellEl.innerHTML = `<span class="pp-edit-spin"></span><span>${esc(t("printerEditSaving"))}</span>`;
      try {
        await savePrinterField(_activePrinter.brand, _activePrinter.id, field, newVal);
        // The Firestore snapshot will trigger refreshOpenPrinterDetail() and
        // re-render the row with the new value. We just clean up the
        // intermediate state.
        cellEl.classList.remove("pp-row-val--editing", "pp-row-val--saving");
      } catch (e) {
        console.warn("[printers] save failed:", e?.code, e?.message);
        cellEl.classList.remove("pp-row-val--saving");
        cellEl.innerHTML = `<span class="pp-edit-error">${esc(t("printerEditError"))}</span>`;
        // After 1.4 s revert to the original so the user can try again.
        setTimeout(() => {
          cellEl.innerHTML = originalHtml;
          cellEl.classList.remove("pp-row-val--editing");
        }, 1400);
      }
    };

    input.addEventListener("keydown", e => {
      if (e.key === "Enter")  { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
  }

  // Single Firestore write path. Always stamps `updatedAt` with a
  // server-side timestamp so cross-client ordering stays monotonic.
  async function savePrinterField(brand, deviceId, fieldName, newValue) {
    const uid = state.activeAccountId;
    if (!uid) throw new Error("no active account");
    const db  = fbDb(uid);
    const ref = db.collection("users").doc(uid)
                  .collection("printers").doc(brand)
                  .collection("devices").doc(deviceId);
    await ref.update({
      [fieldName]: newValue,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     FlashForge HTTP integration (cleartext POST polling)
     ══════════════════════════════════════════════════════════════════════
     Ported from the Flutter `FlashforgeHttpPage`. FlashForge AD5X / 5M
     and similar models expose an HTTP endpoint on port 8898:
       POST http://<ip>:8898/detail   → live status (read)
       POST http://<ip>:8898/control  → commands (write — filament change)
     Both calls take the same auth body { serialNumber, checkCode } where
     `checkCode` is the network-access password configured on the printer.
     Polling cadence: every 2s (matches the mobile companion app).
     Error contract:
       code === -2 OR message contains "network error"           → offline
       code ===  1 AND message contains "sn is different"        → bad SN (toast)
       code ===  1 AND message contains "access code is different" → bad password (toast)
     The integration mirrors the Snapmaker pattern (snap*) — same shape,
     same UI conventions, but HTTP-polled instead of WebSocket-streamed.
     ══════════════════════════════════════════════════════════════════════ */

  // Per-printer live state, keyed by `${brand}:${id}` (parallels _snapConns).
  // Module-scope (not in `state`) since it's transient — never persisted.
  const _ffgConns = new Map();
  // Reachability cache for the Online/Offline badge on the printer grid card,
  // refreshed every 30s (mirror _snapPings).
  const _ffgPings = new Map(); // key -> { online: bool|null, lastChecked: number }

  function ffgKey(p) { return `${p.brand}:${p.id}`; }

  // Authoritative "is this FlashForge reachable?" reading.
  // 1. Active poller status wins.  2. HTTP ping cache as fallback.
  // 3. Returns null when no signal yet (renders as "checking" dot).
  function ffgIsOnline(printer) {
    if (printer?.brand !== "flashforge") return null;
    const k = ffgKey(printer);
    const conn = _ffgConns.get(k);
    if (conn) return conn.status === "connected";
    const ping = _ffgPings.get(k);
    return ping ? ping.online : null;
  }

  // The Flutter UI accepts both bare IPs ("192.168.1.52") and full URLs
  // ("http://192.168.1.52:8898" / with custom port). We mirror that here so
  // power users can override the default 8898 port via the printer's IP field.
  function ffgBaseUrl(ipField) {
    const raw = String(ipField || "").trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
    return `http://${raw}:8898`;
  }

  function ffgAuthBody(printer) {
    // Both fields land on the printer doc when the user adds a FlashForge
    // (see PRINTER_ADD_SCHEMA.flashforge above). Falsy values still get
    // sent — the printer answers with the helpful "sn is different" /
    // "access code is different" payloads we surface as toasts.
    return {
      serialNumber: String(printer.serialNumber || "").trim(),
      checkCode:    String(printer.password || "").trim()
    };
  }

  // Quick reachability check used to drive the Online/Offline badge on the
  // printer grid card BEFORE the full polling loop opens. Cached for 30s.
  async function ffgPingPrinter(printer) {
    if (!printer || printer.brand !== "flashforge") return;
    const base = ffgBaseUrl(printer.ip);
    if (!base) return;
    const k = ffgKey(printer);
    const cached = _ffgPings.get(k);
    const now = Date.now();
    if (cached && now - cached.lastChecked < 30_000) return;
    _ffgPings.set(k, { online: cached?.online ?? null, lastChecked: now });
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${base}/detail`, {
        method: "POST",
        signal: ctrl.signal,
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "*/*" },
        body: JSON.stringify(ffgAuthBody(printer))
      });
      clearTimeout(tm);
      // Even an authentication failure (code:1, "sn is different") implies
      // the printer is reachable — only network errors / non-OK status
      // count as "offline".
      let online = res.ok;
      if (online) {
        try {
          const j = await res.json();
          if (j && (j.code === -2 || /network error/i.test(String(j.message || "")))) {
            online = false;
          }
        } catch (_) { /* non-JSON → still treat as reachable since status was ok */ }
      }
      _ffgPings.set(k, { online, lastChecked: now });
    } catch (_) {
      _ffgPings.set(k, { online: false, lastChecked: now });
    }
    ffgRefreshOnlineUI(k);
  }

  function ffgPingAllPrinters() {
    for (const p of state.printers) {
      if (p.brand === "flashforge" && p.ip) ffgPingPrinter(p);
    }
  }
  setInterval(ffgPingAllPrinters, 30_000);

  // Surgical DOM update — replaces just the status dot/label in the grid
  // card and (if open) the side-card hero. Mirrors snapRefreshOnlineUI.
  function ffgRefreshOnlineUI(key) {
    document.querySelectorAll(`[data-printer-key="${key}"] .printer-online`).forEach(el => {
      const p = state.printers.find(x => ffgKey(x) === key);
      el.outerHTML = renderFfgOnlineBadge(p, "card");
    });
    if (_activePrinter && ffgKey(_activePrinter) === key) {
      const host = $("ppOnlineRow");
      if (host) host.outerHTML = renderFfgOnlineBadge(_activePrinter, "side");
    }
  }

  // Single source of truth for the FlashForge online badge HTML — used in
  // both the grid card and the side-card. Reuses the same `.printer-online`
  // classes as Snapmaker so styling stays consistent.
  function renderFfgOnlineBadge(printer, where) {
    if (!printer || printer.brand !== "flashforge") return "";
    const online = ffgIsOnline(printer);
    const cls = online === true ? "is-online" : (online === false ? "is-offline" : "is-checking");
    const lbl = online === true ? t("snapStatusOnline")
              : online === false ? t("snapStatusOffline")
              : t("snapStatusConnecting");
    const id  = where === "side" ? ` id="ppOnlineRow"` : "";
    return `<span class="printer-online printer-online--${esc(where)} ${cls}"${id}>
              <span class="printer-online-dot"></span>
              <span class="printer-online-lbl">${esc(lbl)}</span>
            </span>`;
  }

  // Open or refresh the polling loop for a printer. Idempotent — calling
  // again on the same printer with the same IP is a no-op.
  function ffgConnect(printer) {
    const key = ffgKey(printer);
    const existing = _ffgConns.get(key);
    if (existing && existing.intervalId && existing.ip === printer.ip) {
      // Already polling the same target — refresh the printer ref so
      // renames / credential edits reach the next poll without a tear-down.
      existing.printer = printer;
      return;
    }
    if (existing) ffgDisconnect(key);
    const conn = {
      key,
      ip: printer.ip,
      printer,                  // kept in sync with the live Firestore doc
      status: "connecting",     // "connecting" | "connected" | "offline" | "error"
      lastError: null,
      lastPollAt: 0,
      retry: 0,
      retryTimer: null,
      intervalId: null,
      // Flat shape — same field structure as the Snapmaker conn so the
      // renderer can reuse format helpers across both brands.
      data: {
        temps: {},              // { e1_temp, e1_target, bed_temp, bed_target, chamber_temp }
        filaments: [],          // up to 4 entries: { color, vendor, type, subType, official, slotId }
        printState: null,       // "printing" | "idle" | "ready" | "complete" | …
        printFilename: null,
        printDuration: 0,
        progress: 0,             // 0..1 (normalised from 0..100 if needed)
        currentLayer: 0,
        totalLayer: 0,
        printPreviewUrl: null,
        printEstimated: null,    // estimated time remaining, seconds
        camera: { url: null, enabled: false },
        snMismatch: false,
        // Last raw /detail response — used by the request log (when added).
        lastDetail: null
      },
      log: []
    };
    _ffgConns.set(key, conn);
    // First poll right away so the side-card lights up without waiting 2s.
    ffgPollOnce(conn);
    conn.intervalId = setInterval(() => ffgPollOnce(conn), 2000);
    ffgNotifyChange(conn, /*statusChanged*/ true);
  }

  function ffgDisconnect(key) {
    const conn = _ffgConns.get(key);
    if (!conn) return;
    if (conn.intervalId) { clearInterval(conn.intervalId); conn.intervalId = null; }
    if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }
    _ffgConns.delete(key);
  }

  // Capped exponential backoff — used when the printer becomes unreachable
  // mid-session. We pause the steady 2s polling loop and retry on growing
  // delays (2s → 4s → 8s → 16s → 30s) until a poll succeeds, at which
  // point ffgPollOnce restores the steady cadence.
  function ffgScheduleReconnect(conn) {
    if (conn.retryTimer) return;
    if (!_ffgConns.has(conn.key)) return; // disposed
    if (conn.intervalId) { clearInterval(conn.intervalId); conn.intervalId = null; }
    conn.retry = Math.min(conn.retry + 1, 5);
    const delay = Math.min(2000 * (1 << (conn.retry - 1)), 30000);
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = null;
      if (!_ffgConns.has(conn.key)) return;
      ffgPollOnce(conn);
      // Restore steady polling — ffgPollOnce will move us back into
      // backoff if the next call also fails.
      if (!conn.intervalId && _ffgConns.has(conn.key)) {
        conn.intervalId = setInterval(() => ffgPollOnce(conn), 2000);
      }
    }, delay);
  }

  async function ffgPollOnce(conn) {
    if (!conn || !_ffgConns.has(conn.key)) return;
    const printer = conn.printer;
    const base = ffgBaseUrl(printer?.ip);
    if (!base) {
      conn.status = "error";
      conn.lastError = "no IP";
      ffgNotifyChange(conn, true);
      return;
    }
    conn.lastPollAt = Date.now();
    let resp;
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/detail`, {
        method: "POST",
        signal: ctrl.signal,
        cache: "no-store",
        headers: { "Content-Type": "application/json", "Accept": "*/*" },
        body: JSON.stringify(ffgAuthBody(printer))
      });
      clearTimeout(tm);
      // Non-JSON / non-200 → treat as offline (mirrors the Flutter
      // catch-all branch that returns code:-1 + "Invalid JSON").
      try { resp = await res.json(); }
      catch (_) {
        resp = { code: -1, message: "Invalid JSON", httpStatus: res.status };
      }
    } catch (e) {
      resp = { code: -2, message: `Network error: ${e?.message || e}` };
    }
    // Stash for the request log + debug overlay.
    conn.data.lastDetail = resp;
    ffgMergeStatus(conn, resp);
  }

  // Stub — full implementation lands in F2 (status parser).
  // Phase 1 only flips connected/offline so the badge reflects reachability.
  function ffgMergeStatus(conn, resp) {
    if (!conn) return;
    const code = resp?.code;
    const msg  = String(resp?.message || "").toLowerCase();
    if (code === -2 || /network error/.test(msg)) {
      conn.status = "offline";
      ffgNotifyChange(conn, true);
      ffgScheduleReconnect(conn);
      return;
    }
    if (code === 0 || resp?.detail) {
      conn.status = "connected";
      conn.retry = 0;
      ffgNotifyChange(conn, true);
    }
  }

  // Coalesce burst of poll-driven updates into a single rAF re-render.
  // Mirror of snapNotifyChange — full re-render on status change so the
  // hero camera + badge can swap, otherwise just the data block.
  let _ffgRenderRaf = null;
  let _ffgRenderStatusFlag = false;
  function ffgNotifyChange(conn, statusChanged = false) {
    if (!_activePrinter) return;
    if (ffgKey(_activePrinter) !== conn.key) return;
    if (statusChanged) _ffgRenderStatusFlag = true;
    if (_ffgRenderRaf) return;
    _ffgRenderRaf = requestAnimationFrame(() => {
      _ffgRenderRaf = null;
      const fullRerender = _ffgRenderStatusFlag;
      _ffgRenderStatusFlag = false;
      if (fullRerender) {
        renderPrinterDetail();
      } else {
        const liveHost = $("ffgLive");
        if (liveHost && typeof renderFlashforgeLiveInner === "function") {
          liveHost.innerHTML = renderFlashforgeLiveInner(_activePrinter);
        }
      }
    });
  }

  /* ── End FlashForge HTTP integration ─────────────────────────── */

  /* ── Add a printer — two-step flow ─────────────────────────────────────
     Step 1 — brand picker: a small modal listing the 5 supported brands
     with their connection method, so the user picks the right type.
     Step 2 — form: a per-brand form with the documented field set
     (printerName + printerModelId always; brand-specific ip / sn /
     account / serialNumber / password / mqttPassword as needed).
     On submit we create a Firestore doc under
       users/{uid}/printers/{brand}/devices/{auto-id}
     with serverTimestamp updatedAt and a sortIndex equal to the current
     printer count (so the new card lands at the end).                     */
  // Per-brand form definition. Each schema is grouped into named sections
  // so the rendered form reads like a guided wizard rather than a flat
  // list of inputs. The `helperKey` block at the top is brand-specific
  // pre-flight guidance (where to find the credentials, how to enable LAN
  // mode, etc.) — this is what makes each modal feel native to the brand
  // even though they share a layout.
  //
  // Field options:
  //   • `secret: true`   → password input + eye toggle
  //   • `mono: true`     → monospace input (IPs, SNs, codes)
  //   • `hintKey`        → small grey hint under the input
  //   • `optional: true` → renders the "(optional)" suffix instead of "*"
  const PRINTER_ADD_SCHEMA = {
    bambulab: {
      docsUrl: "https://wiki.bambulab.com/en/x1/manual/lan-mode",
      sections: [
        { titleKey: "printerSecConnection", fields: [
          { key: "broker", labelKey: "printerLblIP", hintKey: "printerHintBambuIP", placeholder: "192.168.1.42", mono: true, required: true }
        ]},
        { titleKey: "printerSecCredentials", fields: [
          { key: "password",     labelKey: "printerLblAccessCode", hintKey: "printerHintBambuCode",   placeholder: "12345678",     mono: true, required: true, secret: true },
          { key: "serialNumber", labelKey: "printerLblSerial",     hintKey: "printerHintBambuSerial", placeholder: "01S00C123456", mono: true, required: true }
        ]}
      ]
    },
    creality: {
      docsUrl: "https://wiki.creality.com/",
      sections: [
        { titleKey: "printerSecConnection", fields: [
          { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintCrealityIP", placeholder: "192.168.1.50", mono: true, required: true }
        ]},
        // "Root" is a fixed brand-side username on Creality K-series — it is
        // never translated. The labelText override bypasses i18n. It sits
        // before the password by design (matches Creality's own UI order).
        { titleKey: "printerSecCredentials", fields: [
          { key: "account",  labelText: "Root",              hintKey: "printerHintCrealityAccount",  placeholder: "Root",     mono: true, required: true },
          { key: "password", labelKey: "printerLblPassword", hintKey: "printerHintCrealityPassword", placeholder: "••••••••", mono: true, required: true, secret: true }
        ]}
      ]
    },
    elegoo: {
      docsUrl: null,
      sections: [
        { titleKey: "printerSecConnection", fields: [
          { key: "ip", labelKey: "printerLblIP",     hintKey: "printerHintElegooIP",     placeholder: "192.168.1.51", mono: true, required: true },
          { key: "sn", labelKey: "printerLblSerial", hintKey: "printerHintElegooSerial", placeholder: "0CCN201XXXX",  mono: true, required: true }
        ]},
        { titleKey: "printerSecCredentialsOptional", fields: [
          { key: "mqttPassword", labelKey: "printerLblMqttPassword", hintKey: "printerHintElegooMqtt", placeholder: "—", mono: true, required: false, secret: true, optional: true }
        ]}
      ]
    },
    flashforge: {
      docsUrl: null,
      sections: [
        { titleKey: "printerSecConnection", fields: [
          { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintFFGIP", placeholder: "192.168.1.52", mono: true, required: true }
        ]},
        { titleKey: "printerSecCredentials", fields: [
          { key: "serialNumber", labelKey: "printerLblSerial",   hintKey: "printerHintFFGSerial",   placeholder: "FF-AD5X-XXXX", mono: true, required: true },
          { key: "password",     labelKey: "printerLblPassword", hintKey: "printerHintFFGPassword", placeholder: "••••••••",     mono: true, required: true, secret: true }
        ]}
      ]
    },
    snapmaker: {
      docsUrl: null,
      sections: [
        { titleKey: "printerSecConnection", fields: [
          { key: "ip", labelKey: "printerLblIP", hintKey: "printerHintSnapIP", placeholder: "192.168.1.53", mono: true, required: true }
        ]}
      ]
    }
  };

  // Brand-specific helper banner shown above the form. The label is the
  // i18n key for a short title; bullets is the array of step keys.
  // Together they tell the user where to find each credential before
  // they start typing.
  const PRINTER_ADD_HELPER = {
    bambulab:   { titleKey: "printerHelperBambuTitle",   bulletsKey: "printerHelperBambuBullets" },
    creality:   { titleKey: "printerHelperCrealityTitle",bulletsKey: "printerHelperCrealityBullets" },
    elegoo:     { titleKey: "printerHelperElegooTitle",  bulletsKey: "printerHelperElegooBullets" },
    flashforge: { titleKey: "printerHelperFFGTitle",     bulletsKey: "printerHelperFFGBullets" },
    snapmaker:  { titleKey: "printerHelperSnapTitle",    bulletsKey: "printerHelperSnapBullets" }
  };

  let _printerAddBrand = null;        // brand selected in step 1, used by step 2
  let _printerEditContext = null;     // { brand, deviceId } when editing an existing printer (gear button)
  // Pending discovery payload captured by the Snapmaker scan / manual probe,
  // waiting to be written onto the Firestore device doc when the user
  // hits "Add". Cleared on close so a subsequent add (re-opened blank)
  // doesn't accidentally inherit the previous run's data.
  let _printerAddDiscovery = null;

  function openPrinterBrandPicker() {
    const list = $("printerBrandPickerList");
    if (!list) return;
    // One card per brand — visual cue (color dot) + label + connection hint.
    list.innerHTML = PRINTER_BRANDS.map(brand => {
      const meta = PRINTER_BRAND_META[brand];
      return `
        <button type="button" class="pba-brand" data-brand="${esc(brand)}">
          <span class="pba-brand-dot" style="background:${meta.accent}"></span>
          <span class="pba-brand-text">
            <span class="pba-brand-label">${esc(meta.label)}</span>
            <span class="pba-brand-conn">${esc(meta.connection)}</span>
          </span>
          <span class="icon icon-chevron-r icon-14 pba-brand-chev"></span>
        </button>`;
    }).join("");
    list.querySelectorAll(".pba-brand").forEach(btn => {
      btn.addEventListener("click", () => {
        const brand = btn.dataset.brand;
        closePrinterBrandPicker();
        // Snapmaker has a dedicated discovery flow that opens the scan
        // modal directly: it auto-scans the LAN AND exposes an inline
        // "Add by IP" field for users whose printer is on a non-broadcast
        // path (cross-VLAN, etc). Other brands jump straight to the
        // empty add form.
        if (brand === "snapmaker") {
          openSnapmakerScan();
        } else {
          openPrinterAddForm(brand);
        }
      });
    });
    $("printerBrandPickerOverlay").classList.add("open");
  }
  function closePrinterBrandPicker() {
    $("printerBrandPickerOverlay")?.classList.remove("open");
  }
  $("printerBrandPickerClose")?.addEventListener("click", closePrinterBrandPicker);
  $("printerBrandPickerOverlay")?.addEventListener("click", e => {
    if (e.target.id === "printerBrandPickerOverlay") closePrinterBrandPicker();
  });

  /* ── Snapmaker discovery flow ────────────────────────────────────────────
     Snapmaker U-series ships with a Klipper + Moonraker stack on every
     printer; the Moonraker REST API on port 7125 advertises the machine
     model, hostname and firmware versions through `/printer/info` and
     `/server/info`. Hitting those endpoints across the local /24 subnets
     lets us auto-discover printers AND pre-fill the add form with what we
     learn (machine_model → printerName, ip → ip).

     The flow is split into 3 modals:
        choice  → user picks Scan or Manual
        scan    → live results as we iterate the LAN
        manual  → user types one IP, we probe just that one
     Each path lands on the standard openPrinterAddForm() with a `prefill`
     option so the user only confirms / tweaks fields before saving.       */

  // moonraker port — same as Flutter app; fixed at the firmware level.
  const SNAP_MOONRAKER_PORT = 7125;
  // ~340 ms per host matches the Flutter scanner — long enough that a
  // sleeping Snapmaker can wake its stack and answer, short enough that
  // 254 dead hosts don't drag the scan past ~4 seconds.
  const SNAP_PROBE_TIMEOUT_MS = 350;
  // Parallelism per /24 prefix. Different defaults per subnet source:
  //
  //   LOCAL (own LAN, no firewall in front of probes)
  //     → 24 simultaneous fetches, scans a /24 in ~3-5s.
  //
  //   EXTRA (user-declared subnets, typically reached via inter-VLAN
  //   routing through a firewall that may flag burst traffic as port-
  //   scan attack)
  //     → 4 simultaneous fetches with a small inter-batch pause, scans
  //       a /24 in ~25s. Tested on a UniFi/OPNsense-class router with
  //       IDS/IPS active: batch=24 was silently dropped (0 hits in 2s),
  //       batch=4 successfully discovered the printer.
  const SNAP_SCAN_BATCH_LOCAL = 24;
  const SNAP_SCAN_BATCH_EXTRA = 4;
  // Inter-batch pause (only on EXTRA subnets) — gives the firewall's
  // rate-limiter time to forget the previous burst.
  const SNAP_SCAN_BATCH_GAP_MS_EXTRA = 80;
  // If an EXTRA subnet completes with 0 hits in < this much wall-clock
  // time, almost certainly the firewall dropped our SYNs. We surface a
  // hint pointing at Manual Add. Tuned just above the unblocked best-
  // case (a healthy /24 with batch=4 takes ~25s) to avoid false alarms.
  const SNAP_FIREWALL_BLOCK_HINT_MS = 4000;
  // No hardcoded subnet defaults. We rely entirely on os.networkInterfaces()
  // (via the `net:get-local-subnets` IPC) to enumerate the user's ACTUAL
  // active /24 prefixes — covering Wi-Fi, Ethernet, VPN, phone hotspot,
  // anything bound to a non-internal IPv4 NIC. Pre-baking common prefixes
  // like 192.168.1 / 192.168.40 was biased toward one workflow and just
  // wasted ~250 dead-host probes for everyone else (10.x, 172.16.x,
  // 192.168.50.x, etc.). When the printer is reachable from this machine
  // its subnet is already in the list; when it isn't, no fixed default
  // could fix that anyway.

  // Returned by snapProbeIp() / pushed into the scan results list.
  // Mirrors the Flutter SnapmakerScanCandidate, minus the qualityScore (we
  // don't sort by score in the UI — first-found is good enough for a LAN scan).
  let _snapScanAbort = null;     // AbortController for the in-flight scan
  let _snapManualAbort = null;   // AbortController for the manual probe

  /* ── User-declared extra subnets ──────────────────────────────────────
     For multi-VLAN networks where the Mac can REACH a subnet via routing
     but doesn't have an interface on it. os.networkInterfaces() and the
     WebRTC trick both report only the subnets the Mac is *directly* on,
     so without this list any printer behind a VLAN router is invisible
     to the auto-scan.

     Stored as a JSON array of "a.b.c" prefixes in localStorage, keyed
     globally (not per-account) since it describes the user's network
     topology, which is the same regardless of which TigerTag account
     they're signed into.                                                */
  const SNAP_EXTRA_SUBNETS_KEY = "tigertag.snapScanExtraSubnets";

  function snapLoadExtraSubnets() {
    try {
      const raw = localStorage.getItem(SNAP_EXTRA_SUBNETS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // Defensive: a corrupt/legacy value shouldn't take the scan down.
      // Filter out anything that doesn't look like an "a.b.c" prefix.
      return Array.isArray(parsed)
        ? parsed.filter(p => typeof p === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p))
        : [];
    } catch { return []; }
  }
  function snapSaveExtraSubnets(list) {
    try {
      localStorage.setItem(SNAP_EXTRA_SUBNETS_KEY, JSON.stringify(list));
    } catch {}
  }
  // Validate a typed IPv4 address. Accepts "a.b.c.d" with each octet
  // 0-255 and rejects unroutable / multicast / loopback ranges. Returns
  // the canonicalised IP string on success, null on failure. Used by
  // the inline "Add by IP" field in the scan modal.
  function snapValidateIp(s) {
    const m = String(s || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    if (a === 0 || a === 127 || a === 169 || a >= 224) return null;
    return `${a}.${b}.${c}.${d}`;
  }
  // Validate a user-typed prefix. Accepts "a.b.c" with each octet 0-255,
  // and rejects unroutable / multicast / loopback ranges.
  function snapValidatePrefix(s) {
    const m = String(s || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], c = +m[3];
    if (a > 255 || b > 255 || c > 255) return null;
    if (a === 0 || a === 127 || a === 169 || a >= 224) return null;
    return `${a}.${b}.${c}`;
  }
  function snapRenderExtraSubnetsUI() {
    const chipsEl = $("snapExtraSubnetsChips");
    const countEl = $("snapExtraSubnetsCount");
    if (!chipsEl) return;
    const list = snapLoadExtraSubnets();
    if (countEl) countEl.textContent = String(list.length);
    chipsEl.innerHTML = list.map(p => `
      <span class="snap-extra-subnets-chip">
        <span class="snap-extra-subnets-chip-text">${esc(p)}.x</span>
        <button type="button" class="snap-extra-subnets-chip-x" data-prefix="${esc(p)}" title="${esc(t("snapScanExtraSubnetsRemove") || "Remove")}">✕</button>
      </span>
    `).join("");
    // Wire each remove button — saves + re-renders + leaves the
    // <details> element open so the user keeps their place.
    chipsEl.querySelectorAll(".snap-extra-subnets-chip-x").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        const p = btn.dataset.prefix;
        const next = snapLoadExtraSubnets().filter(x => x !== p);
        snapSaveExtraSubnets(next);
        snapRenderExtraSubnetsUI();
      });
    });
  }
  function snapAddExtraSubnetFromInput() {
    const input = $("snapExtraSubnetsInput");
    const errEl = $("snapExtraSubnetsErr");
    if (!input) return;
    const v = snapValidatePrefix(input.value);
    if (!v) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = t("snapScanExtraSubnetsBadFormat")
                          || "Use format a.b.c (e.g. 192.168.40)";
      }
      input.focus();
      return;
    }
    if (errEl) errEl.hidden = true;
    const list = snapLoadExtraSubnets();
    if (!list.includes(v)) list.push(v);
    snapSaveExtraSubnets(list);
    input.value = "";
    snapRenderExtraSubnetsUI();
    input.focus();
  }

  /* ── Debug scan journal ──────────────────────────────────────────────
     A live, in-modal log of everything the scanner does — only visible
     when state.debugEnabled is true. Useful for the user to confirm
     which subnets are being walked, what /printer/info actually answers,
     and why a host did or didn't qualify. Lines are appended in order;
     clicking a line copies its raw JSON to the clipboard.              */
  // Cap so a long-running scan can't blow up the DOM. 600 entries covers
  // 2 full /24 sweeps with a comfortable safety margin.
  const SNAP_SCAN_LOG_MAX = 600;
  let _snapScanLog = [];   // [{ ts, kind, summary, raw }]
  // Last-scan environment captured at snapScanLan() entry — surfaced via
  // Export so a bug report includes which subnets were used, not just
  // the per-host probe results.
  let _snapScanLastEnv = null; // { startedAt, prefixes, ipcSource, webrtcSource, userExtras }

  // Whether the journal SECTION is shown to the user. The scan log is
  // a debug-only diagnostic UI; in non-debug mode the panel is hidden
  // but the underlying log array is STILL maintained (see push() below)
  // so a user who toggles Debug ON after a scan can immediately inspect
  // what happened. This decouples scan BEHAVIOUR from debug mode —
  // there is exactly one scan workflow, the only thing that varies is
  // whether the journal panel is visible.
  function snapScanLogVisible() {
    return !!state.debugEnabled;
  }
  function snapScanLogPush(kind, summary, raw) {
    // ALWAYS record to the in-memory log, regardless of debug state.
    // Earlier this function returned early when debug was off, which
    // meant the log array was empty in non-debug runs but ALSO meant
    // that any side-effect downstream of the push (none today, but a
    // good defensive guarantee) wouldn't fire. The UI gate is enforced
    // exclusively by snapScanLogRender().
    const ts = new Date().toLocaleTimeString([], { hour12: false }) + "." +
               String(new Date().getMilliseconds()).padStart(3, "0");
    _snapScanLog.push({ ts, kind, summary, raw: raw == null ? null : raw });
    if (_snapScanLog.length > SNAP_SCAN_LOG_MAX) {
      _snapScanLog.splice(0, _snapScanLog.length - SNAP_SCAN_LOG_MAX);
    }
    snapScanLogRender();
  }
  function snapScanLogClear() {
    _snapScanLog = [];
    snapScanLogRender();
  }

  // Build a self-contained JSON dump of the current scan log + the
  // environment that produced it (subnets, app version, browser UA,
  // timestamp). The result is small enough to paste straight into a
  // chat / GitHub issue. Includes raw printer payloads when present so
  // a remote diagnosis doesn't need to ask for follow-ups.
  async function snapScanLogBuildExport() {
    let appInfo = null;
    try { appInfo = await window.electronAPI?.getAppInfo?.(); } catch {}
    return {
      meta: {
        kind: "tigertag-snapmaker-scan-log",
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: appInfo?.appVersion || null,
        platform:   appInfo?.platform || null,
        electron:   appInfo?.electron || null,
        userAgent:  navigator.userAgent || null,
        language:   state.lang || null,
      },
      environment: _snapScanLastEnv,
      log: _snapScanLog.map(e => ({
        ts: e.ts, kind: e.kind, summary: e.summary, raw: e.raw
      })),
    };
  }
  // User-triggered Export action — copies the JSON dump to clipboard
  // and flashes the button green for 700ms so the user gets feedback.
  // Falls back to a textarea + manual select-all if the Clipboard API
  // is unavailable (eg. very old Electron / non-secure context).
  async function snapScanLogExport() {
    const btn = $("snapScanLogExport");
    const dump = await snapScanLogBuildExport();
    const text = JSON.stringify(dump, null, 2);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback: hidden textarea + execCommand. Old but reliable.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
    if (btn) {
      // Flip ONLY the inner label span — the button now contains an
      // SVG icon and a text span, so a textContent flip on the button
      // itself would wipe the icon. We target the [data-i18n] span by
      // name so the icon stays untouched during the feedback flash.
      const labelEl = btn.querySelector("[data-i18n]");
      const orig    = labelEl ? labelEl.textContent : btn.textContent;
      const next    = ok
        ? (t("snapScanLogExported") || "Copied!")
        : (t("snapScanLogExportFailed") || "Copy failed");
      if (labelEl) labelEl.textContent = next; else btn.textContent = next;
      btn.classList.add(ok ? "snap-scan-log-btn--ok" : "snap-scan-log-btn--err");
      setTimeout(() => {
        if (labelEl) labelEl.textContent = orig; else btn.textContent = orig;
        btn.classList.remove("snap-scan-log-btn--ok", "snap-scan-log-btn--err");
      }, 1100);
    }
  }
  function snapScanLogRender() {
    const sec   = $("snapScanLog");
    const body  = $("snapScanLogBody");
    const count = $("snapScanLogCount");
    if (!sec) return;
    // Hide the whole panel when debug is off.
    if (!snapScanLogVisible()) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    if (count) count.textContent = String(_snapScanLog.length);
    if (!body || body.hidden) return;
    // Render incrementally if possible — same DOM elements stay in place
    // so the user's scroll position is preserved when new lines arrive.
    const want = _snapScanLog.length;
    const have = body.children.length;
    if (have > want) {
      // Log was cleared: tear down + re-render.
      body.innerHTML = "";
    }
    for (let i = body.children.length; i < want; i++) {
      const e = _snapScanLog[i];
      const row = document.createElement("button");
      row.type = "button";
      row.className = `snap-scan-log-row snap-scan-log-row--${esc(e.kind)}`;
      row.title = t("snapScanLogCopy") || "Click to copy raw JSON";
      row.innerHTML = `
        <span class="snap-scan-log-ts">${esc(e.ts)}</span>
        <span class="snap-scan-log-kind">${esc(e.kind)}</span>
        <span class="snap-scan-log-summary">${esc(e.summary)}</span>`;
      if (e.raw != null) {
        row.addEventListener("click", () => {
          const text = typeof e.raw === "string" ? e.raw : JSON.stringify(e.raw, null, 2);
          navigator.clipboard?.writeText(text).catch(() => {});
          row.classList.add("snap-scan-log-row--copied");
          setTimeout(() => row.classList.remove("snap-scan-log-row--copied"), 700);
        });
      } else {
        row.disabled = true;
      }
      body.appendChild(row);
    }
    // Auto-scroll to bottom so the latest line is always visible.
    body.scrollTop = body.scrollHeight;
  }

  // Aborts whatever scan is currently running (if any). Safe to call
  // multiple times; a second call on an already-aborted controller is a
  // no-op. Used both when the user cancels and when they restart.
  function snapAbortScan() {
    try { _snapScanAbort?.abort(); } catch {}
    _snapScanAbort = null;
  }

  // Flatten Moonraker JSON-RPC envelopes by lifting nested `result/detail/
  // params/data/msg` payloads onto the top level. Mirrors the Flutter
  // scanner so the same field-name lookup works whichever wrapper this
  // particular firmware version chose. Non-destructive (top-level keys
  // win on conflict). Returns the same map when no nesting was found.
  function snapFlattenJson(map) {
    if (!map || typeof map !== "object") return {};
    const out = { ...map };
    for (const key of ["result", "detail", "params", "data", "msg"]) {
      const nested = map[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const k of Object.keys(nested)) {
          // Top-level keys take precedence over nested ones — same
          // semantics as Dart's `{...serverFlat, ...printerFlat}` merge.
          if (!(k in out)) out[k] = nested[k];
        }
      }
    }
    return out;
  }
  // First-non-empty string lookup. Trims and rejects "null"/"" so a
  // firmware quirk that writes `"null"` as a literal doesn't leak through.
  function snapFirstStr(map, keys) {
    for (const k of keys) {
      const v = map?.[k];
      if (v == null) continue;
      const s = String(v).trim();
      if (s && s !== "null") return s;
    }
    return null;
  }

  // Hits Moonraker on `http://{ip}:7125/printer/info` + `/server/info`.
  // If EITHER endpoint returns at least one recognisable identity field,
  // returns a candidate; otherwise null.
  //
  // This is intentionally lenient — a generic Moonraker host will be
  // listed alongside real Snapmakers (e.g. a Voron, a Bambu running a
  // Klipper mod). The Flutter app does the same; we accept that small
  // amount of noise because some Snapmaker firmwares don't populate
  // `machine_model` on /printer/info, so a strict filter would silently
  // drop the very printers the user is looking for. The user picks the
  // right one from the result list.
  async function snapProbeIp(ip, signal) {
    if (!ip) return null;
    const base = `http://${ip}:${SNAP_MOONRAKER_PORT}`;
    // Per-request timeout — separate from the scan-level abort signal so
    // we time out a hung host without killing the whole scan.
    const localCtl = new AbortController();
    const localTimer = setTimeout(() => localCtl.abort(), SNAP_PROBE_TIMEOUT_MS);
    // Combine the caller's signal with our local timeout: abort if either fires.
    const onParentAbort = () => localCtl.abort();
    if (signal) {
      if (signal.aborted) localCtl.abort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
    }
    // Pull JSON if 2xx, flatten the JSON-RPC envelope, return null on any
    // failure. Per-endpoint so one slow URL doesn't poison the other.
    // We track the *unflattened* response too so the debug log can show
    // exactly what the printer answered, not our derived view.
    const fetchJson = async (url) => {
      try {
        const r = await fetch(url, { signal: localCtl.signal, cache: "no-store" });
        if (!r.ok) return { flat: null, raw: null, status: r.status };
        const j = await r.json().catch(() => null);
        return { flat: j ? snapFlattenJson(j) : null, raw: j, status: r.status };
      } catch (e) {
        // Distinguish abort (timeout) from connection refused / no route
        // — useful in the log when triaging why a real printer was missed.
        return { flat: null, raw: null, status: 0, err: e?.name || "error" };
      }
    };
    try {
      const [pi, si, mi] = await Promise.all([
        fetchJson(`${base}/printer/info`),
        fetchJson(`${base}/server/info`),
        // /machine/system_info — the gold-standard identification source.
        // Returns `product_info.machine_type` (e.g. "Snapmaker U1"),
        // `product_info.device_name` (the user-set nickname),
        // `product_info.serial_number`, `product_info.nozzle_diameter[]`.
        // Available on all Snapmakers running stock firmware. Some
        // generic Moonraker hosts (Voron, Bambu-Klipper) don't expose
        // it, so the absence of this route is a useful signal too.
        fetchJson(`${base}/machine/system_info`),
      ]);
      const printerFlat = pi.flat;
      const serverFlat  = si.flat;
      const sysFlat     = mi.flat;
      // If no endpoint replied at all, the host isn't running Moonraker.
      if (!printerFlat && !serverFlat && !sysFlat) return null;
      // Pull the rich product_info out of /machine/system_info if present.
      // Stock Snapmaker firmware nests it as result.system_info.product_info
      // (one level deeper than the standard JSON-RPC `result` envelope
      // that snapFlattenJson already unwrapped). We dive one more level
      // by hand because `system_info` and `product_info` aren't generic
      // wrapper keys we can blindly flatten across all responses.
      const sysRoot     = sysFlat?.system_info || sysFlat || {};
      const productInfo = sysRoot.product_info || {};
      // Fuse all sources into one lookup map. Priority (highest wins):
      //   /machine/system_info.product_info  →  most authoritative
      //   /printer/info                      →  klipper-side info
      //   /server/info                       →  moonraker meta
      // Spread order = lowest priority first; later keys overwrite.
      const combined = {
        ...(serverFlat  || {}),
        ...(printerFlat || {}),
        ...productInfo,
      };
      // Field extraction priority — `machine_type` (from system_info) is
      // now the canonical model field, since /printer/info on Snapmaker
      // doesn't populate `machine_model` at all.
      const machineModel    = snapFirstStr(combined, ["machine_type", "machine_model", "machineModel", "model", "printer_model"]);
      // device_name is the user-given nickname (e.g. "U1-showroom"). We
      // pull it BEFORE hostName so the form pre-fill picks the friendly
      // name, falling back to hostname only if device_name is missing.
      const deviceName      = snapFirstStr(productInfo, ["device_name"]);
      const hostName        = snapFirstStr(combined, ["hostname", "host_name", "device_name", "name"]);
      const softwareVersion = snapFirstStr(combined, ["firmware_version", "software_version", "softwareVersion", "version"]);
      const klippyState     = snapFirstStr(combined, ["klippy_state", "state"]);
      const moonrakerVersion= snapFirstStr(combined, ["moonraker_version", "moonrakerVersion"]);
      const serialNumber    = snapFirstStr(productInfo, ["serial_number", "serialNumber"]);
      let   apiVersion      = snapFirstStr(combined, ["api_version_string", "apiVersion"]);
      if (!apiVersion && Array.isArray(combined.api_version)) {
        apiVersion = combined.api_version.join(".");
      }
      // Number of extruders — derived from nozzle_diameter[] length when
      // present. Useful later for pre-checking the form (a U1 has 4, a
      // J1 has 2, etc). 0 means "unknown — skip pre-fill".
      const nozzleCount = Array.isArray(productInfo.nozzle_diameter)
        ? productInfo.nozzle_diameter.length : 0;

      // The brand check — ANY value of machine_type that contains
      // "Snapmaker" (case-insensitive) is treated as a confirmed
      // Snapmaker. Covers U1, U2, J1, A350, A250, Artisan, future
      // models, factory firmwares with extra qualifiers ("Snapmaker
      // U1 Pro"), etc. Anything else (Voron, Bambu-Klipper, generic
      // Moonraker host) keeps the lenient identity check below.
      const isSnapmaker = !!machineModel &&
                          machineModel.toLowerCase().includes("snapmaker");

      // Accept the candidate as soon as ANY identity field is set —
      // matches Flutter's `hasIdentity` rule. This is the "chope
      // d'autres imprimantes" trade-off the user is OK with.
      const hasIdentity = !!(hostName || machineModel || softwareVersion ||
                             klippyState || moonrakerVersion || apiVersion);
      if (!hasIdentity) {
        snapScanLogPush("ambiguous", `${ip} — Moonraker replied without identity fields`,
          { printerInfo: pi.raw, serverInfo: si.raw, systemInfo: mi.raw });
        return null;
      }
      // Quality score. A confirmed-Snapmaker hit (machine_type contains
      // "Snapmaker") jumps straight to the top tier so the right
      // candidate clusters above noise from generic Moonraker hosts.
      const qualityScore =
          (isSnapmaker     ? 8 : 0) +   // confirmed brand match — biggest weight
          (deviceName      ? 3 : 0) +   // user nickname → high signal
          (machineModel    ? 4 : 0) +
          (hostName        ? 2 : 0) +   // hostname is weakest of the three name fields
          (softwareVersion ? 2 : 0) +
          (klippyState     ? 1 : 0) +
          (moonrakerVersion? 1 : 0) +
          (apiVersion      ? 1 : 0) +
          (serialNumber    ? 1 : 0);
      const summary = `${ip} · ${machineModel || deviceName || hostName || "(no model)"}${isSnapmaker ? " ✓" : ""} · score ${qualityScore}`;
      snapScanLogPush("hit", summary, {
        printerInfo: pi.raw,
        serverInfo:  si.raw,
        systemInfo:  mi.raw,
        derived: {
          isSnapmaker, machineModel, deviceName, hostName,
          softwareVersion, klippyState, moonrakerVersion, apiVersion,
          serialNumber, nozzleCount, qualityScore
        }
      });
      return {
        ip, isSnapmaker, machineModel, deviceName, hostName,
        softwareVersion, klippyState, moonrakerVersion, apiVersion,
        serialNumber, nozzleCount, qualityScore,
        source: "http",
        // Full raw payloads — same convention as the mDNS path. Carried
        // through the prefill into submitPrinterAdd, which writes the
        // bundle under `discovery` on the Firestore device doc.
        raw: {
          mdns: null, // populated by mDNS+HTTP merge in snapScanLan when both fired for the same IP
          http: {
            printerInfo: pi.raw || null,
            serverInfo:  si.raw || null,
            systemInfo:  mi.raw || null,
          },
        },
      };
    } catch {
      return null;
    } finally {
      clearTimeout(localTimer);
      if (signal) signal.removeEventListener?.("abort", onParentAbort);
    }
  }

  // Iterate every active /24 prefix in parallel batches. Calls onCandidate
  // for each printer found and onProgress on every IP probed (success or
  // not) so the UI can update its progress bar live.
  // WebRTC-based fallback for discovering the local IPv4 address. The
  // browser/renderer trick: open an RTCPeerConnection with a dummy data
  // channel, gather ICE candidates, and parse the host IP out of each
  // candidate string. This works even when:
  //   - Electron is running an old main.js without the net:get-local-subnets
  //     IPC handler registered (no restart since we shipped that handler)
  //   - The preload script is older than the renderer (preload IPC bridge
  //     `getLocalSubnets` isn't on window.electronAPI yet)
  //   - A VPN or unusual NIC config makes os.networkInterfaces() report
  //     something different from the active route
  // Returns an array of /24 prefixes ("a.b.c") it could observe.
  async function snapDiscoverSubnetsViaWebRTC() {
    if (typeof RTCPeerConnection === "undefined") return [];
    const found = new Set();
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("snap-discover");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Gather candidates for ~600ms — long enough to enumerate every
      // active route, short enough not to hold up the scan launch.
      await new Promise(resolve => {
        const tm = setTimeout(resolve, 600);
        pc.onicecandidate = (e) => {
          if (!e.candidate) { clearTimeout(tm); resolve(); return; }
          // Candidate strings look like:
          //   "candidate:1 1 UDP 1686052607 192.168.20.131 51632 typ host ..."
          // We pull the IPv4 between two spaces. mDNS `.local` candidates
          // are skipped (they hide the real IP behind a hash).
          const s = String(e.candidate.candidate || "");
          const m = s.match(/(?:^|\s)((?:\d{1,3}\.){3}\d{1,3})(?=\s)/);
          if (!m) return;
          const ip = m[1];
          const parts = ip.split(".");
          const a = +parts[0];
          if (a === 0 || a === 127 || a === 169 || a >= 224) return;
          found.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        };
      });
    } catch {} finally {
      try { pc?.close(); } catch {}
    }
    return Array.from(found);
  }

  // Build a Snapmaker candidate object (same shape as snapProbeIp returns)
  // straight from a mDNS service answer. The TXT record from Snapmaker
  // firmware contains EVERYTHING needed to pre-fill the form (ip,
  // machine_type, device_name, sn, version) so we don't even probe
  // HTTP — the candidate appears in the result list as soon as the
  // mDNS query returns. Filters out non-Snapmaker matches just in case
  // someone else publishes _snapmaker._tcp on the LAN (extremely rare).
  function snapCandidateFromMdns(svc) {
    if (!svc) return null;
    const txt = svc.txt || {};
    // The TXT record fields are documented in u1-moonraker/components/
    // zeroconf.py: machine_type, device_name, sn, version, ip,
    // link_mode, region, userid.
    const machineModel    = (txt.machine_type || "").trim() || null;
    const deviceName      = (txt.device_name  || "").trim() || null;
    const serialNumber    = (txt.sn           || "").trim() || null;
    const softwareVersion = (txt.version      || "").trim() || null;
    // Pick an IP — the TXT.ip field is what the firmware itself reports;
    // svc.addresses[] is what mDNS resolved on the wire. They almost
    // always agree, but the wire address is more authoritative on
    // multi-homed hosts so we prefer it when present.
    let ip = null;
    if (Array.isArray(svc.addresses)) {
      ip = svc.addresses.find(a => /^(\d{1,3}\.){3}\d{1,3}$/.test(a)) || null;
    }
    if (!ip && txt.ip) ip = String(txt.ip).trim();
    if (!ip) return null;
    // Strict brand check — we filter to "machine_type contains Snapmaker"
    // so a non-Snapmaker stray on _snapmaker._tcp can't sneak in. In
    // practice this can't happen (the service-type itself is unique to
    // Snapmaker firmware) but defence-in-depth is cheap.
    const isSnapmaker = !!machineModel &&
                        machineModel.toLowerCase().includes("snapmaker");
    if (!isSnapmaker) return null;
    // Quality score — mDNS hits MAX out the score because the TXT
    // record is the most authoritative possible source.
    const qualityScore = 8 /* isSnapmaker */
                       + (deviceName      ? 3 : 0)
                       + (machineModel    ? 4 : 0)
                       + (softwareVersion ? 2 : 0)
                       + (serialNumber    ? 1 : 0)
                       + 1 /* mDNS bonus — confirms the LAN-broadcast identity */;
    return {
      ip, isSnapmaker, machineModel, deviceName,
      hostName: svc.host || null,
      softwareVersion, klippyState: null,
      moonrakerVersion: null, apiVersion: null,
      serialNumber, nozzleCount: 0,
      qualityScore,
      // Mark the source so the UI/journal can distinguish mDNS-found
      // from probe-found candidates.
      source: "mdns",
      // Full raw payload — kept verbatim so the Add flow can persist
      // EVERYTHING the printer told us about itself onto the Firestore
      // device doc (under `discovery`). Useful later for debug,
      // model-detection improvements, or surfacing fields we don't
      // currently render in the UI without an extra round-trip.
      raw: {
        mdns: {
          name: svc.name || null,
          host: svc.host || null,
          port: svc.port || null,
          fqdn: svc.fqdn || null,
          addresses: Array.isArray(svc.addresses) ? svc.addresses.slice() : [],
          txt: svc.txt ? { ...svc.txt } : {},
        },
        http: null, // mDNS-only candidate — HTTP probe data is added by the merge in snapScanLan
      },
    };
  }

  async function snapScanLan({ onCandidate, onProgress, signal } = {}) {
    // Capture an environment snapshot for the Export button — gets
    // populated as we discover sources below, so a copy-to-clipboard
    // includes EVERY layer we tried, not just per-host results.
    _snapScanLastEnv = {
      startedAt: new Date().toISOString(),
      mdnsHits: null,
      ipcSubnets: null,
      webrtcSubnets: null,
      userExtras: null,
      prefixes: null,
      probeTimeoutMs: SNAP_PROBE_TIMEOUT_MS,
      batchSizeLocal: SNAP_SCAN_BATCH_LOCAL,
      batchSizeExtra: SNAP_SCAN_BATCH_EXTRA,
      port: SNAP_MOONRAKER_PORT,
    };

    // Track which IPs we've already surfaced so the port-scan phase
    // doesn't re-probe what mDNS already found (would be a duplicate
    // candidate in the UI, AND wastes a network round-trip).
    const seenIps = new Set();
    let hits = 0;

    // ── Phase 0: mDNS browse (instant on healthy LANs) ─────────────
    // Snapmaker firmware advertises `_snapmaker._tcp.local.` with a
    // TXT record carrying everything we need. When the network has a
    // working multicast path (single VLAN, or VLAN with mDNS reflector)
    // this returns the printer in ≤ 2 sec with ZERO probes. When mDNS
    // is filtered (typical multi-VLAN without reflector), we just get
    // an empty list and fall through to the port-scan phase.
    try {
      const mdnsRes = await window.electronAPI?.mdnsBrowseSnapmaker?.();
      const cands = Array.isArray(mdnsRes?.candidates) ? mdnsRes.candidates : [];
      if (_snapScanLastEnv) _snapScanLastEnv.mdnsHits = cands.length;
      if (mdnsRes?.ok === false) {
        snapScanLogPush("error",
          `mDNS browse failed: ${mdnsRes.error || "unknown"} — falling back to port-scan only`,
          { source: "mdns", error: mdnsRes.error });
      } else {
        snapScanLogPush("info",
          `mDNS browse → ${cands.length} _snapmaker._tcp instance${cands.length === 1 ? "" : "s"}`,
          { source: "mdns", raw: cands });
      }
      for (const svc of cands) {
        const c = snapCandidateFromMdns(svc);
        if (!c) continue;
        if (seenIps.has(c.ip)) continue;
        seenIps.add(c.ip);
        hits++;
        snapScanLogPush("hit",
          `mDNS · ${c.ip} · ${c.machineModel} · score ${c.qualityScore} (no HTTP probe)`,
          { source: "mdns", service: svc, derived: c });
        onCandidate?.(c);
      }
    } catch (e) {
      snapScanLogPush("error", `mDNS browse threw: ${e?.message || e}`, null);
    }

    // ── Phase 1: enumerate subnets to port-scan ─────────────────────
    // Each subnet is tagged with its source so we can pick the right
    // batch size + know whether an empty result means "firewall block"
    // (extras) or just "no Snapmakers on this NIC" (locals).
    /** @type {Array<{ prefix: string, source: "local"|"extra" }>} */
    const queue = [];
    const seenPrefixes = new Set();
    const pushPrefix = (p, source) => {
      if (!p || seenPrefixes.has(p)) return;
      seenPrefixes.add(p);
      queue.push({ prefix: p, source });
    };

    // 1a. main-process os.networkInterfaces() via IPC.
    let ipcWorked = false;
    try {
      const got = await window.electronAPI?.getLocalSubnets?.();
      if (Array.isArray(got)) {
        ipcWorked = true;
        if (_snapScanLastEnv) _snapScanLastEnv.ipcSubnets = got;
        got.forEach(p => pushPrefix(p, "local"));
        snapScanLogPush("info",
          `IPC getLocalSubnets → [${got.join(", ") || "(empty)"}]`,
          { source: "ipc", subnets: got });
      } else {
        snapScanLogPush("info",
          `IPC getLocalSubnets unavailable (returned ${typeof got}) — falling back to WebRTC discovery. Restart Electron to enable the native IPC bridge.`,
          null);
      }
    } catch (e) {
      snapScanLogPush("error", `getLocalSubnets failed: ${e?.message || e}`, null);
    }
    // 1b. WebRTC ICE-candidate IPs (cheap fallback when the IPC bridge
    //     isn't loaded yet, OR for setups with weird routing tables).
    try {
      const webrtc = await snapDiscoverSubnetsViaWebRTC();
      if (_snapScanLastEnv) _snapScanLastEnv.webrtcSubnets = webrtc;
      const fresh = webrtc.filter(p => !seenPrefixes.has(p));
      if (fresh.length || (!ipcWorked && webrtc.length)) {
        snapScanLogPush("info",
          `WebRTC discovery → [${webrtc.join(", ")}]${fresh.length ? ` (added: ${fresh.join(", ")})` : " (already known)"}`,
          { source: "webrtc", subnets: webrtc, added: fresh });
      } else if (!ipcWorked) {
        snapScanLogPush("info", "WebRTC discovery returned no candidates", null);
      }
      fresh.forEach(p => pushPrefix(p, "local"));
    } catch (e) {
      snapScanLogPush("error", `WebRTC discovery failed: ${e?.message || e}`, null);
    }
    // 1c. User-declared extras — tagged as "extra" so we use the
    //     gentle batch size that survives anti-scan firewalls.
    const extras = snapLoadExtraSubnets();
    if (_snapScanLastEnv) _snapScanLastEnv.userExtras = extras;
    if (extras.length) {
      const fresh = extras.filter(p => !seenPrefixes.has(p));
      snapScanLogPush("info",
        `User extras → [${extras.join(", ")}]${fresh.length ? ` (added: ${fresh.join(", ")})` : " (already known)"}`,
        { source: "user", subnets: extras, added: fresh });
      fresh.forEach(p => pushPrefix(p, "extra"));
    }

    if (_snapScanLastEnv) _snapScanLastEnv.prefixes = queue.slice();
    snapScanLogPush("info",
      `Port-scan starting — ${queue.length} subnet${queue.length === 1 ? "" : "s"}: ${queue.map(q => q.prefix + "(" + q.source + ")").join(", ") || "(none)"}`,
      { queue, batchLocal: SNAP_SCAN_BATCH_LOCAL, batchExtra: SNAP_SCAN_BATCH_EXTRA });

    // ── Phase 2: port-scan ─────────────────────────────────────────
    // We track per-subnet stats so we can flag suspected firewall
    // blocks AFTER the scan completes (not during, to avoid false
    // alarms while the subnet is still mid-walk).
    const total = queue.length * 254;
    let done = 0;
    onProgress?.({ done, total, prefixes: queue.map(q => q.prefix) });

    const scanStart = performance.now();
    /** @type {Array<{ prefix:string, source:string, hits:number, elapsedMs:number, suspicious:boolean }>} */
    const subnetStats = [];

    for (const { prefix, source } of queue) {
      if (signal?.aborted) {
        snapScanLogPush("info", "Scan aborted by user", null);
        return;
      }
      const isExtra  = source === "extra";
      const batch    = isExtra ? SNAP_SCAN_BATCH_EXTRA : SNAP_SCAN_BATCH_LOCAL;
      const gapMs    = isExtra ? SNAP_SCAN_BATCH_GAP_MS_EXTRA : 0;
      snapScanLogPush("info",
        `Scanning ${prefix}.1–254 (source=${source}, batch=${batch}${gapMs ? `, gap=${gapMs}ms` : ""})`,
        null);
      const subnetStart = performance.now();
      let subnetHits = 0;
      for (let start = 1; start <= 254; start += batch) {
        if (signal?.aborted) {
          snapScanLogPush("info", "Scan aborted by user", null);
          return;
        }
        const end = Math.min(start + batch - 1, 254);
        const ips = [];
        for (let i = start; i <= end; i++) {
          const ip = `${prefix}.${i}`;
          // Skip IPs we already surfaced via mDNS — avoids duplicates
          // and saves a probe each (over a /24, that's up to a couple
          // of seconds shaved off when mDNS was effective).
          if (seenIps.has(ip)) { done++; continue; }
          ips.push(ip);
        }
        const results = await Promise.all(ips.map(ip =>
          snapProbeIp(ip, signal).catch(() => null)
        ));
        for (const r of results) {
          done++;
          if (!r) continue;
          // Filter — only Snapmakers reach the UI. Other Moonraker
          // hosts (Voron, Bambu-Klipper, Creality K1, etc.) get logged
          // in debug as "ambiguous" so the user sees them when they
          // open the journal, but they don't pollute the result list.
          // (snapProbeIp already calls snapScanLogPush('hit') for
          // every Moonraker reply; this guard only governs the UI.)
          if (!r.isSnapmaker) {
            snapScanLogPush("ambiguous",
              `${r.ip} — Moonraker host but not a Snapmaker (machine_type=${r.machineModel || "?"}) — skipped`,
              { ip: r.ip, machineModel: r.machineModel, derived: r });
            continue;
          }
          if (seenIps.has(r.ip)) continue;
          seenIps.add(r.ip);
          hits++;
          subnetHits++;
          onCandidate?.(r);
        }
        onProgress?.({ done, total, prefixes: queue.map(q => q.prefix) });
        // Inter-batch breathing room — only on EXTRA. Without it, the
        // anti-scan rate-limiter on a typical home firewall will lump
        // consecutive batches into a single "scan attack" event and
        // drop them all.
        if (gapMs && start + batch <= 254) {
          await new Promise(r => setTimeout(r, gapMs));
        }
      }
      const subnetElapsedMs = Math.round(performance.now() - subnetStart);
      // Suspicious = an EXTRA subnet that completed too fast with 0
      // hits. "Too fast" = anything under SNAP_FIREWALL_BLOCK_HINT_MS,
      // because a healthy /24 with batch=4 takes ≥ 25s (254 hosts ×
      // 350ms / 4 ≈ 22s + gaps). Sub-4s with 0 hits ⇒ firewall ate it.
      const suspicious = isExtra && subnetHits === 0 &&
                         subnetElapsedMs < SNAP_FIREWALL_BLOCK_HINT_MS;
      subnetStats.push({ prefix, source, hits: subnetHits,
                         elapsedMs: subnetElapsedMs, suspicious });
      if (suspicious) {
        snapScanLogPush("error",
          `${prefix}.0/24 finished in ${(subnetElapsedMs/1000).toFixed(1)}s with 0 hits — your firewall likely blocked the scan. Try Manual Add with the printer's exact IP.`,
          { prefix, elapsedMs: subnetElapsedMs, hits: 0, hint: "firewall_block_suspected" });
      }
    }

    const elapsedMs = Math.round(performance.now() - scanStart);
    snapScanLogPush("info",
      `Scan complete — ${hits} Snapmaker hit${hits === 1 ? "" : "s"} in ${(elapsedMs / 1000).toFixed(1)}s (${total} probes)`,
      { hits, totalProbes: total, elapsedMs, subnetStats });
    if (_snapScanLastEnv) _snapScanLastEnv.subnetStats = subnetStats;
  }

  /* ── LAN scanner (the choice-modal middleman was retired — brand-pick
     Snapmaker now opens this panel directly with both an inline
     "Add by IP" + the auto-scan running in the background). ─────── */
  // Bundle a candidate's discovery data into the shape we'll persist on
  // the Firestore device doc (under `discovery`). Includes:
  //   - `discoveredAt` — ISO timestamp so we know when the scan ran
  //   - `source`       — "mdns" | "http"
  //   - `derived`      — the parsed identity fields
  //   - `raw`          — verbatim payloads (mDNS service + HTTP responses)
  //
  // We intentionally store the RAW payloads, not just the derived fields:
  // future features (firmware-version-aware features, model detection
  // improvements, etc.) can re-parse the same source data without a
  // re-scan, and this is invaluable for triaging support tickets.
  /* ── One-click add — write a discovered Snapmaker straight to Firestore.
     Used by the scan-card click handler so the user doesn't have to
     pass through the add form for printers we already know everything
     about (mDNS / Moonraker probe gave us name + IP + model). Mirrors
     the document shape that `submitPrinterAdd()` writes for the
     manual path so the inventory schema stays consistent. Resolves
     to the new device id on success, or null on failure (caller can
     fall back to the form). */
  async function snapAddDiscoveredPrinter(c) {
    if (!c) {
      console.warn("[snap-scan] add aborted: no candidate");
      return null;
    }
    const uid = state.activeAccountId;
    if (!uid) {
      console.warn("[snap-scan] add aborted: no active account (state.activeAccountId is null)");
      return null;
    }
    const brand = "snapmaker";
    const printerName = c.deviceName || c.machineModel || c.hostName || `Snapmaker ${c.ip}`;
    const printerModelId = snapModelIdFromMachineModel(c.machineModel || c.hostName);
    try {
      const db  = fbDb(uid);
      const ref = db.collection("users").doc(uid)
                    .collection("printers").doc(brand)
                    .collection("devices").doc();
      const sortIndex = state.printers.length;
      // Build the payload defensively. Firestore rejects undefined
      // values — we coerce every potentially-undefined field to null
      // (or a safe default) before the write, AND we strip nested
      // undefineds from the discovery payload so a stray `undefined`
      // somewhere in the raw mDNS/HTTP responses can't kill the write.
      const discovery = snapBuildDiscoveryRecord(c);
      const cleanDiscovery = discovery ? JSON.parse(JSON.stringify(discovery)) : null;
      const payload = {
        printerName,
        printerModelId,
        ip: c.ip || "",
        id: ref.id,
        isActive: false,
        sortIndex,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        discovery: cleanDiscovery,
      };
      console.log("[snap-scan] writing printer doc", { uid, brand, id: ref.id, name: printerName });
      await ref.set(payload);
      console.log("[snap-scan] printer doc written successfully", ref.id);
      return ref.id;
    } catch (e) {
      console.error("[snap-scan] Firestore write failed:", {
        code: e?.code,
        message: e?.message,
        full: e
      });
      return null;
    }
  }

  function snapBuildDiscoveryRecord(c) {
    if (!c) return null;
    return {
      discoveredAt: new Date().toISOString(),
      source: c.source || null,
      derived: {
        ip: c.ip || null,
        isSnapmaker: !!c.isSnapmaker,
        machineModel:    c.machineModel    || null,
        deviceName:      c.deviceName      || null,
        hostName:        c.hostName        || null,
        softwareVersion: c.softwareVersion || null,
        klippyState:     c.klippyState     || null,
        moonrakerVersion:c.moonrakerVersion|| null,
        apiVersion:      c.apiVersion      || null,
        serialNumber:    c.serialNumber    || null,
        nozzleCount:     c.nozzleCount     || 0,
        qualityScore:    c.qualityScore    || 0,
      },
      raw: c.raw || null,
    };
  }

  // Resolve a Moonraker `machine_model` string against the local Snapmaker
  // catalog so we can pre-fill the model picker with the matching entry
  // (and fall back to the placeholder "Select Printer" id=0 when nothing
  // matches — e.g. firmware reporting a model we don't have art for yet).
  function snapModelIdFromMachineModel(machineModel) {
    if (!machineModel) return "0";
    const list = state.db.printerModels?.snapmaker || [];
    const hay = String(machineModel).toLowerCase().replace(/[\s_-]+/g, "");
    // Try exact / contains match against name OR id, normalised. We strip
    // separators on both sides so "Snapmaker U1" matches catalog entries
    // like "U1", "snapmaker-u1" or "Snapmaker_U1" alike.
    let hit = list.find(m => {
      const mn = String(m.name || "").toLowerCase().replace(/[\s_-]+/g, "");
      const mi = String(m.id   || "").toLowerCase().replace(/[\s_-]+/g, "");
      return mn === hay || mi === hay || (mn && hay.includes(mn)) || (mn && mn.includes(hay));
    });
    return hit ? String(hit.id) : "0";
  }

  function snapCandidateCardHtml(c) {
    // Title line — prefer the user's nickname (device_name) over the
    // model over the codename hostname over the bare IP. This is the
    // exact same priority we use to pre-fill the form, so the card
    // visibly previews what the form will be seeded with.
    const title = c.deviceName || c.machineModel || c.hostName || c.ip;
    // Model + firmware version — the "what is this printer" line.
    const modelParts = [];
    if (c.machineModel && c.machineModel !== title) modelParts.push(c.machineModel);
    if (c.softwareVersion) modelParts.push(`v${c.softwareVersion}`);
    const modelLine = modelParts.join(" · ");
    // Hostname — only shown when it's not redundant with the title.
    const hostLine  = (c.hostName && c.hostName !== title && c.hostName !== c.machineModel)
                    ? c.hostName : "";
    // Serial number on its own row (formatted with the "S/N" prefix to
    // match how the field is displayed on the printer's own touchscreen
    // and in the support tooling).
    const serialLine = c.serialNumber ? `S/N · ${c.serialNumber}` : "";
    // Confidence tier. With the new scoring (isSnapmaker = +8), a
    // confirmed Snapmaker always lands in the "high" tier, generic
    // Moonraker hosts in low/med depending on what they reveal.
    const score = c.qualityScore || 0;
    const tier  = score >= 10 ? "high" : (score >= 5 ? "med" : "low");
    // Brand badge — only shown when machine_type contained "Snapmaker".
    // Visual confirmation that THIS row is a real Snapmaker, not a
    // Klipper-running NAS or someone's Voron.
    const brandBadge = c.isSnapmaker
      ? `<span class="snap-scan-card-badge" title="${esc(t("snapScanCardBrandConfirmed") || "Confirmed Snapmaker (machine_type contains 'Snapmaker')")}">Snapmaker</span>`
      : "";
    // Resolve the model image so the card previews which printer this
    // is. Falls back to the per-brand "Select Printer" entry image
    // (which IS no_printer.png in the catalog) when machine_type didn't
    // match anything we know — keeps the layout stable instead of
    // showing an empty thumbnail box.
    const modelId    = snapModelIdFromMachineModel(c.machineModel || c.hostName);
    const matched    = findPrinterModel("snapmaker", modelId);
    const fallback   = findPrinterModel("snapmaker", "0"); // catalog placeholder = no_printer.png
    const imgUrl     = printerImageUrl(matched) || printerImageUrl(fallback);
    const thumbHtml  = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="" onerror="this.style.opacity='.15'"/>`
      : "";
    // Card markup — uses a <div role="button"> rather than a real
    // <button>. Reason: browsers refuse to honour `display: flex` on a
    // <button> with multiple block children predictably; the rendering
    // collapses to inline-block height in some contexts (visible bug:
    // thumbnail bleeding below the visible card box). A div with the
    // proper a11y attributes (role, tabindex, key handler) gives us
    // perfect control over the layout AND keeps the keyboard story
    // working (Enter / Space trigger via the wired keydown handler).
    return `
      <div class="snap-scan-card snap-scan-card--${tier}${c.isSnapmaker ? " snap-scan-card--snap" : ""}"
           role="button" tabindex="0"
           data-ip="${esc(c.ip)}" data-model="${esc(c.machineModel || "")}" data-host="${esc(c.hostName || "")}">
        <span class="snap-scan-card-thumb">${thumbHtml}</span>
        <span class="snap-scan-card-main">
          <span class="snap-scan-card-title">
            <span class="snap-scan-card-title-text">${esc(title)}</span>
            ${brandBadge}
          </span>
          <span class="snap-scan-card-ip">${esc(c.ip)}</span>
          ${modelLine  ? `<span class="snap-scan-card-line snap-scan-card-line--model">${esc(modelLine)}</span>` : ""}
          ${hostLine   ? `<span class="snap-scan-card-line snap-scan-card-line--host" title="${esc(hostLine)}">${esc(hostLine)}</span>` : ""}
          ${serialLine ? `<span class="snap-scan-card-line snap-scan-card-line--sn"   title="${esc(c.serialNumber)}">${esc(serialLine)}</span>` : ""}
        </span>
        <span class="snap-scan-card-score" title="${esc(t("snapScanScore", { n: score }) || `Match score: ${score}`)}">${score}</span>
        <span class="icon icon-chevron-r icon-14 snap-scan-card-chev"></span>
      </div>`;
  }

  function openSnapmakerScan() {
    // Side-panel pattern (matches scales / printer-detail / friends):
    // two elements driven by `.open` — `#snapScanOverlay` (the dim
    // backdrop) and `#snapScanPanel` (the slide-in card itself).
    const overlay = $("snapScanOverlay");
    const panel   = $("snapScanPanel");
    if (!overlay || !panel) return;
    const sub      = $("snapScanSub");
    const bar      = $("snapScanBar");
    const stats    = $("snapScanStats");
    const results  = $("snapScanResults");
    const empty    = $("snapScanEmpty");
    if (results) results.innerHTML = "";
    if (empty)   empty.hidden = false;
    if (bar)     bar.style.width = "0%";
    if (stats)   stats.textContent = "0 / 0";
    if (sub)     sub.textContent = t("snapScanStarting") || "Starting scan…";
    // Reset the debug log on every (re)scan so the user sees only the
    // current run's output. Render shows/hides the panel based on the
    // current debugEnabled flag.
    snapScanLogClear();
    // Refresh the user-declared extra-subnets chips every time the modal
    // opens so they reflect the latest localStorage state (e.g. if the
    // user opened settings in another window).
    snapRenderExtraSubnetsUI();
    // Reset the Add-by-IP widget so reopening doesn't carry stale state
    // (a half-typed IP, an "Invalid" tip, etc.) from the previous session.
    // Closing the <details> triggers the `toggle` listener above, which
    // already wipes the input/tip/button/status — so we only need to
    // collapse the wrapper and abort any in-flight probe here.
    const ipDetails = $("snapAddIpDetails");
    if (ipDetails) ipDetails.open = false;
    try { _snapAddIpAbort?.abort(); } catch {}
    _snapAddIpAbort = null;
    // Slide the panel in + dim the backdrop. Both get `.open` so the
    // CSS transitions on each fire in lockstep.
    overlay.classList.add("open");
    panel.classList.add("open");

    // Cancel any previous scan, then start fresh.
    snapAbortScan();
    const ctl = new AbortController();
    _snapScanAbort = ctl;

    let foundCount = 0;
    // Track which IPs we've already rendered so we can update the row in
    // place rather than appending a duplicate when /printer/info answers
    // after /server/info has already produced a (lower-score) candidate.
    const rendered = new Map(); // ip -> { card, score }
    snapScanLan({
      signal: ctl.signal,
      onCandidate: (c) => {
        if (empty) empty.hidden = true;
        const wrap = document.createElement("div");
        wrap.innerHTML = snapCandidateCardHtml(c);
        const card = wrap.firstElementChild;
        if (!card) return;
        // One-click add — write directly to Firestore, close the scan
        // panel, and open the detail panel for the just-added printer.
        const triggerAdd = async () => {
          console.log("[snap-scan] triggerAdd fired for", c.ip);
          if (card.classList.contains("snap-scan-card--loading")) return;
          card.classList.add("snap-scan-card--loading");
          const newId = await snapAddDiscoveredPrinter(c);
          if (!newId) {
            card.classList.remove("snap-scan-card--loading");
            console.warn("[snap-scan] one-click add returned null — see preceding warning");
            return;
          }
          // Close the scan panel + abort any in-flight scan.
          snapAbortScan();
          closeSnapmakerScan();
          // Wait briefly for the Firestore listener (subscribePrinters)
          // to populate state.printers with the new doc, then open the
          // detail side-panel. Polls every 40ms up to ~2s. If the
          // listener never fires (extremely rare), we silently bail.
          const start = Date.now();
          let printer = null;
          while (Date.now() - start < 2000) {
            printer = state.printers.find(p => p.brand === "snapmaker" && p.id === newId);
            if (printer) break;
            await new Promise(r => setTimeout(r, 40));
          }
          if (printer) {
            openPrinterDetail("snapmaker", newId);
          } else {
            console.warn("[snap-scan] printer doc was written but Firestore listener didn't update state.printers within 2s — open it manually from the grid");
          }
        };
        card.addEventListener("click", triggerAdd);
        card.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            triggerAdd();
          }
        });
        const prev = rendered.get(c.ip);
        if (prev) {
          // Existing entry — replace it only if the new probe scored
          // higher (more identity fields filled in). Otherwise drop the
          // duplicate so the list stays stable.
          if ((c.qualityScore || 0) > prev.score) {
            prev.card.replaceWith(card);
            rendered.set(c.ip, { card, score: c.qualityScore || 0 });
          }
        } else {
          foundCount++;
          rendered.set(c.ip, { card, score: c.qualityScore || 0 });
          if (results) results.appendChild(card);
        }
        // Re-sort visible rows by score (desc) so the strongest match
        // bubbles to the top as scan results stream in. Tie-break on IP
        // so the order is stable when scores equal.
        if (results) {
          const sorted = Array.from(results.children).sort((a, b) => {
            const sa = +(a.querySelector(".snap-scan-card-score")?.textContent || 0);
            const sb = +(b.querySelector(".snap-scan-card-score")?.textContent || 0);
            if (sb !== sa) return sb - sa;
            return (a.dataset.ip || "").localeCompare(b.dataset.ip || "", undefined, { numeric: true });
          });
          sorted.forEach(el => results.appendChild(el));
        }
      },
      onProgress: ({ done, total, prefixes }) => {
        if (bar)   bar.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "0%";
        if (stats) stats.textContent = `${done} / ${total}`;
        if (sub) {
          // No active NIC ⇒ os.networkInterfaces() returned nothing
          // useful. Tell the user to check the connection rather than
          // silently spinning at 0/0.
          if (total === 0) {
            sub.textContent = t("snapScanNoSubnets")
                            || "No active network detected — connect to Wi-Fi or Ethernet.";
            return;
          }
          if (done >= total) {
            sub.textContent = t("snapScanDone", { n: foundCount }) || `Scan complete — ${foundCount} found`;
            // When the scan finished with 0 Snapmaker hits, swap the
            // generic empty state for a more actionable one if any
            // user-declared subnet looks firewall-blocked. Reads
            // _snapScanLastEnv.subnetStats which snapScanLan populated.
            if (foundCount === 0 && empty) {
              const blocked = (_snapScanLastEnv?.subnetStats || [])
                .filter(s => s.suspicious)
                .map(s => `${s.prefix}.0/24`);
              if (blocked.length) {
                empty.innerHTML = esc(t("snapScanEmptyFirewall", { p: blocked.join(", ") })
                  || `Your firewall likely dropped probes on ${blocked.join(", ")} — try Manual Add with the printer's exact IP.`);
                empty.classList.add("snap-scan-empty--warn");
              } else {
                empty.textContent = t("snapScanEmpty")
                  || "No Snapmaker found yet — make sure the printer is on the same Wi-Fi network.";
                empty.classList.remove("snap-scan-empty--warn");
              }
            }
          } else {
            sub.textContent = t("snapScanProgress", { p: prefixes.join(", ") })
                            || `Scanning ${prefixes.join(", ")}…`;
          }
        }
      }
    }).catch(() => {/* aborted or per-host failure already swallowed */});
  }
  function closeSnapmakerScan() {
    snapAbortScan();
    $("snapScanOverlay")?.classList.remove("open");
    $("snapScanPanel")?.classList.remove("open");
  }
  $("snapScanClose")?.addEventListener("click", closeSnapmakerScan);
  // Backdrop click closes the panel (same UX as scales / printer detail).
  $("snapScanOverlay")?.addEventListener("click", closeSnapmakerScan);
  // Escape key — replaces the visible ✕ button (now removed).
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && $("snapScanPanel")?.classList.contains("open")) {
      closeSnapmakerScan();
    }
  });
  // The "Back" button was removed — brand-pick now opens this panel
  // directly, so there is no previous step to return to. Closing is
  // done via the X in the header or by clicking the backdrop.
  $("snapScanRestart")?.addEventListener("click", () => {
    // Re-run the scan in-place (don't close + reopen — preserves overlay focus).
    openSnapmakerScan();
  });
  // Debug log: collapsible header (chevron flips), Clear button wipes
  // the in-memory buffer + DOM. Both are no-ops when state.debugEnabled
  // is false because the panel is hidden in that case.
  $("snapScanLogToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const body = $("snapScanLogBody");
    const btn  = $("snapScanLogToggle");
    if (!body || !btn) return;
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("snap-scan-log-toggle--open", open);
    if (open) snapScanLogRender(); // flush queued lines on first open
  });
  $("snapScanLogClear")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    snapScanLogClear();
  });
  $("snapScanLogExport")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    snapScanLogExport();
  });
  // Extra-subnets widget: Add button + Enter key submits; the input
  // clears + chip appears immediately. The list is read fresh from
  // localStorage at every snapScanLan() call, so changes take effect
  // on the very next scan with no extra plumbing.
  $("snapExtraSubnetsAdd")?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    snapAddExtraSubnetFromInput();
  });
  $("snapExtraSubnetsInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      snapAddExtraSubnetFromInput();
    }
  });

  /* ── Inline "Add by IP" — live IPv4 validation + direct probe.
     Drives 4 visual states on the input + button:
       1. EMPTY     — neutral border, button disabled, no tip
       2. TYPING    — neutral border (still incomplete), button disabled, no tip
       3. INVALID   — red border, info bubble visible, button disabled
       4. VALID     — green border, info bubble hidden, button enabled
     Clicking the button (or pressing Enter on a valid input) probes the
     IP and either pre-fills the add form (success) or shows an error
     state below the row (no reply).                                       */
  let _snapAddIpAbort = null;
  // Validation is now CLICK-DRIVEN, not live. While the user types, the
  // input stays neutral (no red border, no bubble) — feedback only fires
  // when they hit Validate and the IP doesn't parse. Two responsibilities
  // for the input handler:
  //   1. Enable the Validate button as soon as there is ANY text (so the
  //      user can click to receive validation feedback).
  //   2. If a previous click left the input in an error state, clear
  //      that state on the next keystroke so the user gets feedback
  //      they're "fixing" the problem.
  function snapAddIpUpdateState() {
    const inp = $("snapAddIpInput");
    const tip = $("snapAddIpTip");
    const btn = $("snapAddIpBtn");
    const status = $("snapAddIpStatus");
    if (!inp || !tip || !btn) return;
    const raw = (inp.value || "").trim();
    // Drop any sticky error UI as soon as the user resumes typing.
    if (inp.classList.contains("snap-add-ip-input--err")) {
      inp.classList.remove("snap-add-ip-input--err");
      tip.hidden = true;
    }
    // Button is enabled the moment the input is non-empty. We don't try
    // to validate live — the user clicks, THEN we validate.
    btn.disabled = raw.length === 0;
    // Clear any stale probe-status row when the user resumes typing.
    if (status && !status.hidden && !btn.classList.contains("loading")) {
      status.hidden = true;
      status.textContent = "";
      status.className = "snap-add-ip-status";
    }
  }
  // Keystroke filter — only digits + dots. Block everything else
  // (letters, spaces, etc.) at input time so the field is always parseable.
  // Toggle reactions on the <details> wrapper:
  //   - on EXPAND: focus the input so the user can type immediately
  //     (saves a click compared to "click trigger → click input").
  //   - on COLLAPSE: clear the input + any stale validation/error UI
  //     so reopening starts fresh.
  $("snapAddIpDetails")?.addEventListener("toggle", () => {
    const details = $("snapAddIpDetails");
    const inp     = $("snapAddIpInput");
    const tip     = $("snapAddIpTip");
    const btn     = $("snapAddIpBtn");
    const status  = $("snapAddIpStatus");
    if (!details) return;
    if (details.open) {
      // Defer focus until after the browser has painted the expanded
      // body — calling focus() before that on Safari/Webkit can race
      // with the open transition and silently no-op.
      setTimeout(() => inp?.focus(), 30);
    } else {
      try { _snapAddIpAbort?.abort(); } catch {}
      _snapAddIpAbort = null;
      if (inp)    { inp.value = ""; inp.classList.remove("snap-add-ip-input--err", "snap-add-ip-input--ok"); }
      if (tip)    tip.hidden = true;
      if (btn)    { btn.disabled = true; btn.classList.remove("loading"); }
      if (status) { status.hidden = true; status.textContent = ""; status.className = "snap-add-ip-status"; }
    }
  });

  $("snapAddIpInput")?.addEventListener("beforeinput", e => {
    if (e.inputType && e.inputType.startsWith("delete")) return; // allow deletions
    const data = e.data;
    if (data == null) return;
    if (!/^[\d.]+$/.test(data)) e.preventDefault();
  });
  $("snapAddIpInput")?.addEventListener("input", snapAddIpUpdateState);
  $("snapAddIpInput")?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      const btn = $("snapAddIpBtn");
      if (btn && !btn.disabled) btn.click();
    }
  });

  $("snapAddIpBtn")?.addEventListener("click", async () => {
    const inp = $("snapAddIpInput");
    const btn = $("snapAddIpBtn");
    const status = $("snapAddIpStatus");
    if (!inp || !btn) return;
    const ip = snapValidateIp(inp.value);
    if (!ip) {
      // Defensive — UI keeps the button disabled when the IP is invalid,
      // but in case some path bypasses the disabled state we still
      // refuse to probe.
      snapAddIpUpdateState();
      return;
    }
    btn.classList.add("loading");
    btn.disabled = true;
    if (status) {
      status.hidden = false;
      status.className = "snap-add-ip-status snap-add-ip-status--info";
      status.textContent = t("snapManualProbing", { ip }) || `Reaching ${ip}…`;
    }
    try { _snapAddIpAbort?.abort(); } catch {}
    const ctl = new AbortController();
    _snapAddIpAbort = ctl;
    const c = await snapProbeIp(ip, ctl.signal);
    btn.classList.remove("loading");
    btn.disabled = false;
    if (!c) {
      // No reply — keep the user on the scan modal so they can fix the
      // IP or try anyway. Reuses the same "Continue anyway" button as
      // the legacy manual modal.
      if (status) {
        status.className = "snap-add-ip-status snap-add-ip-status--err";
        status.innerHTML = `
          <span>${esc(t("snapManualNoReply", { ip }) || `No reply from ${ip}.`)}</span>
          <button type="button" class="snap-add-ip-anyway" id="snapAddIpAnyway">${esc(t("snapManualContinueAnyway") || "Continue anyway")}</button>
        `;
        $("snapAddIpAnyway")?.addEventListener("click", () => {
          // Close the scan modal first so the add form is on top.
          closeSnapmakerScan();
          openPrinterAddForm("snapmaker", null, {
            ip,
            printerName: `Snapmaker ${ip}`,
            modelId: "0",
          });
        });
      }
      return;
    }
    // Success — open the add form pre-filled, identical priorities to
    // the scan-card click + legacy manual probe path.
    closeSnapmakerScan();
    openPrinterAddForm("snapmaker", null, {
      ip:          c.ip,
      printerName: c.deviceName || c.machineModel || c.hostName || `Snapmaker ${c.ip}`,
      modelId:     snapModelIdFromMachineModel(c.machineModel || c.hostName),
      discovery:   snapBuildDiscoveryRecord(c),
    });
  });

  /* ── Step 2b — manual IP probe ─────────────────────────────────────── */
  function openSnapmakerManual() {
    const overlay = $("snapManualOverlay");
    if (!overlay) return;
    const ip      = $("snapManualIp");
    const status  = $("snapManualStatus");
    const probe   = $("snapManualProbe");
    if (ip)     ip.value = "";
    if (status) { status.hidden = true; status.textContent = ""; status.className = "snap-manual-status"; }
    if (probe)  probe.classList.remove("loading");
    overlay.classList.add("open");
    setTimeout(() => ip?.focus(), 50);
  }
  function closeSnapmakerManual() {
    try { _snapManualAbort?.abort(); } catch {}
    _snapManualAbort = null;
    $("snapManualOverlay")?.classList.remove("open");
  }
  $("snapManualClose")?.addEventListener("click", closeSnapmakerManual);
  $("snapManualOverlay")?.addEventListener("click", e => {
    if (e.target.id === "snapManualOverlay") closeSnapmakerManual();
  });
  // Legacy manual modal — kept around for now but its only entry path
  // (the choice modal) has been retired, so the Back button just closes
  // the modal without reopening anything (otherwise it would call the
  // deleted openSnapmakerAddChoice and throw).
  $("snapManualBack")?.addEventListener("click", () => {
    closeSnapmakerManual();
  });
  $("snapManualIp")?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("snapManualProbe")?.click();
    }
  });
  $("snapManualProbe")?.addEventListener("click", async () => {
    const ipEl    = $("snapManualIp");
    const status  = $("snapManualStatus");
    const probeBt = $("snapManualProbe");
    const ip      = (ipEl?.value || "").trim();
    // Loose IPv4 validation. Snapmaker sits on private LAN so we don't try
    // to be cleverer than .x.x.x.x — we just want to catch typos.
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) {
      if (status) {
        status.hidden = false;
        status.className = "snap-manual-status snap-manual-status--err";
        status.textContent = t("snapManualBadIp") || "Please enter a valid IPv4 address.";
      }
      ipEl?.focus();
      return;
    }
    // Live status while we probe so the user knows we didn't freeze.
    if (status) {
      status.hidden = false;
      status.className = "snap-manual-status snap-manual-status--info";
      status.textContent = t("snapManualProbing", { ip }) || `Reaching ${ip}…`;
    }
    probeBt?.classList.add("loading");

    try { _snapManualAbort?.abort(); } catch {}
    const ctl = new AbortController();
    _snapManualAbort = ctl;
    const c = await snapProbeIp(ip, ctl.signal);
    probeBt?.classList.remove("loading");
    if (!c) {
      // Failed probe — keep the user on this modal so they can fix the IP
      // or try anyway (we still let them continue to the empty form).
      if (status) {
        status.className = "snap-manual-status snap-manual-status--err";
        status.innerHTML = `
          <span>${esc(t("snapManualNoReply", { ip }) || `No reply from ${ip}.`)}</span>
          <button type="button" class="snap-manual-anyway" id="snapManualAnyway">${esc(t("snapManualContinueAnyway") || "Continue anyway")}</button>
        `;
        $("snapManualAnyway")?.addEventListener("click", () => {
          closeSnapmakerManual();
          openPrinterAddForm("snapmaker", null, {
            ip,
            printerName: `Snapmaker ${ip}`,
            modelId: "0",
          });
        });
      }
      return;
    }
    closeSnapmakerManual();
    // Same prefill priority as the scan path: prefer the user nickname
    // (device_name from /machine/system_info) over the model name over
    // the firmware codename hostname.
    openPrinterAddForm("snapmaker", null, {
      ip:          c.ip,
      printerName: c.deviceName || c.machineModel || c.hostName || `Snapmaker ${c.ip}`,
      modelId:     snapModelIdFromMachineModel(c.machineModel || c.hostName),
      discovery:   snapBuildDiscoveryRecord(c),
    });
  });

  // openPrinterAddForm doubles as the edit modal. When `editPrinter` is
  // provided, the form pre-fills every field with the existing values,
  // hides the Back button, switches the primary CTA to "Save changes",
  // and routes the submit through an UPDATE rather than an auto-id SET.
  //
  // `prefill` is for the discovery flow (Snapmaker scan / manual probe):
  // shape `{ ip?, printerName?, modelId? }`. It seeds the empty add form
  // with the values we just learned from the printer so the user only has
  // to confirm + add. Ignored when `editPrinter` is set (edit takes over).
  function openPrinterAddForm(brand, editPrinter = null, prefill = null) {
    if (!brand || !PRINTER_ADD_SCHEMA[brand]) return;
    _printerAddBrand = brand;
    _printerEditContext = editPrinter ? { brand, deviceId: editPrinter.id } : null;
    // Stash the discovery payload (if any) — the form's submit handler
    // will pull this out and write it to the Firestore doc. Edit mode
    // doesn't get a new discovery (we never overwrite an existing one
    // from the edit form), so we only set it on the add path.
    _printerAddDiscovery = (!editPrinter && prefill && prefill.discovery) ? prefill.discovery : null;
    const meta   = PRINTER_BRAND_META[brand];
    const schema = PRINTER_ADD_SCHEMA[brand];
    const helper = PRINTER_ADD_HELPER[brand];
    const isEdit = !!editPrinter;

    // Title is fixed ("Printers Settings") via the data-i18n attribute on
    // .pba-title; the sub keeps the brand label so the user still sees
    // which workflow they're in.
    $("printerAddSub").textContent = meta.label;

    // Adjust footer for edit mode: hide Back, swap save label, reveal
    // the hold-to-confirm Delete (icon-only trash button) — same pattern
    // and 1.5s hold duration as the Rack delete in the storage view.
    const backBtn = $("printerAddBack");
    if (backBtn) backBtn.style.display = isEdit ? "none" : "";
    const saveLabel = $("printerAddSave")?.querySelector(".label");
    if (saveLabel) saveLabel.textContent = t(isEdit ? "printerEditSave" : "printerAddSave");
    const delBtn = $("printerAddDelete");
    if (delBtn) {
      delBtn.classList.toggle("hidden", !isEdit);
      delBtn.title = t("printerEditDeleteHint")
                   || "Hold 1.5s to delete this printer";
    }

    // Per-brand model catalog. We KEEP the id="0" placeholder (the "Select
    // Printer" entry shipped in every brand JSON) and pin it to the top so
    // it acts as a visible "no model yet" choice. The picker still uses
    // the entry's image (no_printer.png) — this matches the convention
    // used elsewhere in the TigerTag stack.
    const allModels = state.db.printerModels?.[brand] || [];
    const placeholderModel = allModels.find(m => String(m.id) === "0");
    const otherModels = allModels.filter(m => String(m.id) !== "0");
    const models = placeholderModel ? [placeholderModel, ...otherModels] : otherModels;

    // Render a single field. Supports labelText (raw, never i18n'd) for
    // protocol-mandated literals like Creality's "Root".
    const renderField = f => {
      const labelHtml = f.labelText ? esc(f.labelText) : esc(t(f.labelKey));
      const reqMark = f.optional ? `<span class="pba-field-opt">${esc(t("printerOptional"))}</span>`
                                 : (f.required ? '<span class="pba-field-req">*</span>' : "");
      const hint = f.hintKey ? `<span class="pba-field-hint">${esc(t(f.hintKey))}</span>` : "";
      // Secret fields get an eye toggle on the right of the input.
      // Both icons (eye-on + eye-off) are pre-rendered stacked so the
      // toggle is purely a class flip — no DOM swap, no layout jump.
      if (f.secret) {
        return `
          <label class="pba-field">
            <span class="pba-field-label">${labelHtml} ${reqMark}</span>
            <span class="pba-input-wrap pba-input-wrap--secret">
              <input type="password"
                     class="pba-input${f.mono ? " pba-input--mono" : ""}"
                     name="${esc(f.key)}"
                     placeholder="${esc(f.placeholder)}"
                     autocomplete="off" autocapitalize="off" spellcheck="false"
                     ${f.required ? "required" : ""}/>
              <button type="button" class="pba-input-eye" data-eye-target="${esc(f.key)}" title="${esc(t("printerSecretShow"))}">
                <span class="pba-eye-stack">
                  <span class="pba-eye-icon pba-eye-icon--on  icon icon-eye-on  icon-14"></span>
                  <span class="pba-eye-icon pba-eye-icon--off icon icon-eye-off icon-14"></span>
                </span>
              </button>
            </span>
            ${hint}
          </label>`;
      }
      return `
        <label class="pba-field">
          <span class="pba-field-label">${labelHtml} ${reqMark}</span>
          <input type="text"
                 class="pba-input${f.mono ? " pba-input--mono" : ""}"
                 name="${esc(f.key)}"
                 placeholder="${esc(f.placeholder)}"
                 autocomplete="off" autocapitalize="off" spellcheck="false"
                 ${f.required ? "required" : ""}/>
          ${hint}
        </label>`;
    };

    // Render a section with a small caps header.
    const renderSection = (s) => `
      <section class="pba-section">
        <header class="pba-section-head">${esc(t(s.titleKey))}</header>
        ${s.fields.map(renderField).join("")}
      </section>`;

    const sectionsHtml = schema.sections.map(renderSection).join("");

    // Helper banner removed — the per-field hints already give all the
    // setup context the user needs. Keeping `helper` referenced via
    // PRINTER_ADD_HELPER + the bullets translations in case we want to
    // reintroduce it elsewhere (e.g. a "?" tooltip).
    const helperHtml = "";

    // Custom model picker — a select element can't render thumbnails, so
    // we build a button + popup list. A hidden <input> stores the chosen
    // model id so the form-collection step keeps working unchanged.
    const modelPickerOptions = models.map(m => {
      const imgUrl = printerImageUrl(m);
      const imgHtml = imgUrl ? `<img src="${esc(imgUrl)}" alt="" onerror="this.style.opacity='.15'"/>` : "";
      return `
        <button type="button" class="pba-mp-opt" data-id="${esc(m.id)}" data-name="${esc(m.name)}">
          <span class="pba-mp-thumb">${imgHtml}</span>
          <span class="pba-mp-name">${esc(m.name)}</span>
        </button>`;
    }).join("");

    // Pre-select either the printer's current model (in edit mode), the
    // model derived from a discovery probe (Snapmaker scan / manual), or
    // the placeholder "Select Printer" entry (id 0) so the dropdown
    // always opens with a meaningful state.
    const prefillModel = (!isEdit && prefill && prefill.modelId)
      ? findPrinterModel(brand, prefill.modelId)
      : null;
    const editModel = isEdit
      ? findPrinterModel(brand, editPrinter.printerModelId)
      : null;
    const defaultModel    = editModel || prefillModel || placeholderModel || models[0] || null;
    const defaultModelId  = defaultModel ? String(defaultModel.id) : "";
    const defaultModelName= defaultModel ? defaultModel.name : t("printerAddModelPh");
    const defaultModelImg = defaultModel ? printerImageUrl(defaultModel) : null;
    const defaultThumbHtml= defaultModelImg
      ? `<img src="${esc(defaultModelImg)}" alt="" onerror="this.style.opacity='.15'"/>`
      : "";

    $("printerAddBody").innerHTML = `
      ${helperHtml}

      <section class="pba-section">
        <header class="pba-section-head">${esc(t("printerSecIdentity"))}</header>

        <div class="pba-field">
          <span class="pba-field-label">${esc(t("printerLblModel"))} <span class="pba-field-req">*</span></span>
          <div class="pba-modelpicker" id="pbaModelPicker">
            <button type="button" class="pba-mp-trigger" id="pbaMpTrigger" aria-haspopup="listbox" aria-expanded="false">
              <span class="pba-mp-thumb pba-mp-thumb--trigger" id="pbaMpTriggerThumb">${defaultThumbHtml}</span>
              <span class="pba-mp-trigger-text" id="pbaMpTriggerText">${esc(defaultModelName)}</span>
              <span class="icon icon-chevron-r icon-13 pba-mp-chev"></span>
            </button>
            <input type="hidden" name="printerModelId" id="pbaMpValue" value="${esc(defaultModelId)}" />
            <div class="pba-mp-list" id="pbaMpList" role="listbox" hidden>
              ${modelPickerOptions}
            </div>
          </div>
        </div>

        <label class="pba-field">
          <span class="pba-field-label">${esc(t("printerLblName"))} <span class="pba-field-req">*</span></span>
          <input type="text" class="pba-input" name="printerName" placeholder="${esc(t("printerAddNamePh"))}" required />
        </label>
      </section>

      ${sectionsHtml}

      <div class="pba-error" id="printerAddError" hidden></div>`;

    wireModelPicker(brand, models);
    wirePasswordEyes($("printerAddBody"));

    // Pre-fill every field with the existing printer's values when in
    // edit mode. We iterate the schema explicitly (rather than dumping
    // the whole `editPrinter` object into the DOM) so that fields the
    // form doesn't expose — id, sortIndex, isActive, deleted, etc.
    // remain untouched on the doc.
    if (isEdit) {
      const body = $("printerAddBody");
      const setVal = (name, v) => {
        const el = body.querySelector(`input[name="${name}"]`);
        if (el && v != null) el.value = String(v);
      };
      setVal("printerName", editPrinter.printerName);
      schema.sections.forEach(sec => {
        sec.fields.forEach(f => setVal(f.key, editPrinter[f.key]));
      });
    } else if (prefill) {
      // Discovery flow (Snapmaker scan / manual probe): seed only the
      // values we learned from the network. We DON'T touch the model id
      // here — that's already wired through `defaultModel` above so the
      // trigger button + thumbnail render correctly on first paint.
      const body = $("printerAddBody");
      const setVal = (name, v) => {
        const el = body.querySelector(`input[name="${name}"]`);
        if (el && v != null && v !== "") el.value = String(v);
      };
      if (prefill.printerName) setVal("printerName", prefill.printerName);
      if (prefill.ip)          setVal("ip",          prefill.ip);
    }

    $("printerAddOverlay").classList.add("open");
    setTimeout(() => {
      // In edit mode focus the printer name (the most likely thing the
      // user wants to tweak); in prefill mode (discovery) the user has
      // already picked the IP/model, so focus the name input so they can
      // rename if they want; in plain add mode keep focus on the model picker.
      const body = $("printerAddBody");
      if (isEdit || prefill) {
        const ni = body.querySelector("input[name=printerName]");
        ni?.focus();
        ni?.select();
      } else {
        $("pbaMpTrigger")?.focus();
      }
    }, 50);
  }

  /* ── Custom model picker — opens a list of models with thumbnails.
     Selecting a model:
       1. Updates the hidden input `printerModelId` (form payload key)
       2. Updates the visible trigger label + thumbnail
       3. Pre-fills the empty-or-not `printerName` field with the model
          name as a courtesy (the user can still override it).            */
  function wireModelPicker(brand, models) {
    const trigger = $("pbaMpTrigger");
    const list    = $("pbaMpList");
    const value   = $("pbaMpValue");
    const text    = $("pbaMpTriggerText");
    const thumb   = $("pbaMpTriggerThumb");
    if (!trigger || !list) return;

    const open = () => {
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.classList.add("pba-mp-trigger--open");
    };
    const close = () => {
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.classList.remove("pba-mp-trigger--open");
    };
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      list.hidden ? open() : close();
    });
    // Outside-click closes the popup.
    document.addEventListener("click", e => {
      if (!list.hidden && !list.contains(e.target) && e.target !== trigger) close();
    });

    list.querySelectorAll(".pba-mp-opt").forEach(opt => {
      opt.addEventListener("click", () => {
        const id   = opt.dataset.id;
        const name = opt.dataset.name;
        const m    = models.find(x => String(x.id) === id);
        const url  = printerImageUrl(m);
        value.value = id;
        text.textContent = name;
        thumb.innerHTML = url ? `<img src="${esc(url)}" alt="" onerror="this.style.opacity='.15'"/>` : "";
        // Pre-fill printerName when empty so the user keeps moving forward.
        // We skip the placeholder entry (id=="0", "Select Printer") since
        // its name is a meta-label, not an actual model name. When the
        // user picks the placeholder we leave printerName empty so they
        // type something meaningful themselves.
        const nameInput = $("printerAddBody").querySelector("input[name=printerName]");
        if (nameInput && id !== "0" && !nameInput.value.trim()) nameInput.value = name;
        close();
        nameInput?.focus();
        nameInput?.select();
      });
    });
  }

  // For each <input type=password> wrapped in .pba-input-wrap--secret,
  // wire the eye button to toggle the type between "password" and "text".
  // The icon flips between eye-on (hidden) and eye-off (revealed) so the
  // visual matches the current state.
  function wirePasswordEyes(scope) {
    scope.querySelectorAll(".pba-input-eye").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        const wrap = btn.closest(".pba-input-wrap--secret");
        const inp  = wrap?.querySelector("input");
        if (!inp) return;
        const showing = inp.type === "text";
        inp.type = showing ? "password" : "text";
        btn.title = showing ? t("printerSecretShow") : t("printerSecretHide");
        btn.classList.toggle("pba-input-eye--on", !showing);
        const iconSpan = btn.querySelector(".icon");
        if (iconSpan) {
          iconSpan.classList.toggle("icon-eye-on", showing);
          iconSpan.classList.toggle("icon-eye-off", !showing);
        }
      });
    });
  }
  function closePrinterAddForm() {
    $("printerAddOverlay")?.classList.remove("open");
    _printerAddBrand = null;
    _printerEditContext = null;
    _printerAddDiscovery = null;
  }
  $("printerAddClose")?.addEventListener("click", closePrinterAddForm);
  $("printerAddBack")?.addEventListener("click", () => {
    closePrinterAddForm();
    openPrinterBrandPicker();
  });
  $("printerAddOverlay")?.addEventListener("click", e => {
    if (e.target.id === "printerAddOverlay") closePrinterAddForm();
  });
  $("printerAddSave")?.addEventListener("click", () => submitPrinterAdd());

  // Hold-to-confirm Delete — same 1.5s press-and-hold pattern + visual
  // fill animation as the rack delete in storage view. Only fires when
  // an edit context is active (the trash button is hidden in add mode
  // anyway, but we double-check here as a defensive guard against a
  // stale class-toggle race).
  setupHoldToConfirm($("printerAddDelete"), 1500, async () => {
    const ctx = _printerEditContext;
    if (!ctx) return;
    const uid = state.activeAccountId;
    if (!uid) return;
    const err = $("printerAddError");
    try {
      const ref = fbDb(uid).collection("users").doc(uid)
                    .collection("printers").doc(ctx.brand)
                    .collection("devices").doc(ctx.deviceId);
      await ref.delete();
      // Close the form — onSnapshot will refresh the list. We don't
      // explicitly remove the doc from `state.printers` because the
      // Firestore listener handles that within ~50 ms.
      closePrinterAddForm();
    } catch (e) {
      console.warn("[printers] delete failed:", e?.code, e?.message);
      if (err) {
        err.textContent = t("printerDeleteErr") || "Failed to delete the printer.";
        err.hidden = false;
      }
    }
  });

  async function submitPrinterAdd() {
    const brand = _printerAddBrand;
    if (!brand) return;
    const uid = state.activeAccountId;
    if (!uid) return;

    const isEdit = !!_printerEditContext;

    const body = $("printerAddBody");
    const err  = $("printerAddError");
    err.hidden = true;

    // Collect inputs. We capture EVERY field listed in the schema (even
    // if the user cleared an optional one) so an empty string can be
    // written back to wipe the previous value rather than leaving stale
    // data on the doc.
    const schema = PRINTER_ADD_SCHEMA[brand];
    const data = {};
    const nameInput = body.querySelector("input[name=printerName]");
    data.printerName = (nameInput?.value || "").trim();
    const modelInput = body.querySelector("input[name=printerModelId]");
    if (modelInput) data.printerModelId = (modelInput.value || "").trim();
    schema.sections.forEach(sec => sec.fields.forEach(f => {
      const el = body.querySelector(`input[name="${f.key}"]`);
      const v  = (el?.value || "").trim();
      data[f.key] = v;
    }));

    if (!data.printerName) {
      err.textContent = t("printerAddErrName");
      err.hidden = false;
      return;
    }
    // Required brand-specific fields
    const missing = schema.sections.flatMap(s => s.fields)
      .filter(f => f.required && !data[f.key]);
    if (missing.length) {
      err.textContent = t("printerAddErrMissing", { fields: missing.map(f => f.labelText || t(f.labelKey)).join(", ") });
      err.hidden = false;
      return;
    }

    const btn = $("printerAddSave");
    btn.classList.add("loading");
    btn.disabled = true;
    try {
      const db  = fbDb(uid);
      if (isEdit) {
        // ── EDIT: update the existing doc, leaving id/isActive/sortIndex
        //         untouched. We DO write empty strings so the user can
        //         clear an optional secret field (e.g. mqttPassword).
        const editId = _printerEditContext.deviceId;
        const ref = db.collection("users").doc(uid)
                      .collection("printers").doc(brand)
                      .collection("devices").doc(editId);
        await ref.update({
          ...data,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Reconnect Snapmaker live channel after a settings edit.
        // The user may have changed the IP (or any other connection
        // field) — the existing WebSocket is still wired to the OLD
        // address and would silently keep streaming stale data, so we
        // tear it down and reconnect with the freshly-saved values.
        // We wait briefly for the Firestore listener to refresh
        // state.printers, then call snapConnect with the new doc.
        // snapConnect itself is idempotent: if the IP didn't actually
        // change, it's a no-op.
        if (brand === "snapmaker") {
          const start = Date.now();
          let updated = null;
          while (Date.now() - start < 2000) {
            updated = state.printers.find(p => p.brand === "snapmaker" && p.id === editId);
            // Wait for a state with the post-update timestamp + matching ip
            if (updated && updated.ip === data.ip) break;
            await new Promise(r => setTimeout(r, 40));
          }
          if (updated && updated.ip) {
            snapDisconnect(snapKey(updated));
            snapConnect(updated);
            // Refresh any open detail panel so the live block re-renders
            // against the new connection state.
            if (_activePrinter && snapKey(_activePrinter) === snapKey(updated)) {
              _activePrinter = updated;
              try { renderPrinterDetail(); } catch {}
            }
          }
        }
      } else {
        // ── ADD: auto-id under the brand subcollection.
        const ref = db.collection("users").doc(uid)
                      .collection("printers").doc(brand)
                      .collection("devices").doc();
        const sortIndex = state.printers.length; // append to the end
        const docPayload = {
          ...data,
          id: ref.id,
          isActive: false,
          sortIndex,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        // Persist the full discovery payload when the printer was added
        // via Scan / Manual probe. The bundle holds the raw mDNS TXT
        // record + raw /printer/info, /server/info, /machine/system_info
        // responses + the derived identity fields, so future code can
        // re-parse without a re-scan and support tickets get a complete
        // snapshot of what the printer reported.
        if (_printerAddDiscovery) {
          docPayload.discovery = _printerAddDiscovery;
        }
        await ref.set(docPayload);
      }
      closePrinterAddForm();
    } catch (e) {
      console.warn(`[printers] ${isEdit ? "update" : "create"} failed:`, e?.code, e?.message);
      err.textContent = t("printerAddErrSave");
      err.hidden = false;
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  }
  // Convert Firestore Timestamp object to ms (the existing tsToMs at line 366
  // handles legacy shapes; here we add support for { seconds, nanoseconds }).
  function scaleTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds != null) return ts.seconds * 1000 + Math.round((ts.nanoseconds || 0) / 1e6);
    return tsToMs(ts) || 0;
  }
  // ── Scale v2 field accessors ───────────────────────────────────────
  // Studio Manager reads scale documents using the v2 schema documented
  // in `tigerscale-doc-schema.md` — no v1 fallback. Firmwares writing
  // the legacy v1 names (`last_seen`, `last_spool`, `name`, `rssi`,
  // `battery_pct`) will appear OFFLINE / unnamed in the UI until they
  // are updated to v2. This is intentional: forcing a clean cut keeps
  // the codebase from accumulating dual-read shims indefinitely.
  function scaleHeartbeatAt(s)        { return s?.last_heartbeat_at   ?? null; }
  function scaleDisplayName(s)        { return s?.display_name        ?? null; }
  function scaleCurrentSpoolUid1(s)   { return s?.current_spool_uid_1 ?? null; }
  function scaleCurrentSpoolUid2(s)   { return s?.current_spool_uid_2 ?? null; }
  function scaleWifiSignalDbm(s)      { return s?.wifi_signal_dbm     ?? null; }
  function scaleBatteryPercent(s)     { return s?.battery_percent     ?? null; }
  function scaleIsCharging(s)         { return s?.is_charging         ?? null; }
  function scalePowerSource(s)        { return s?.power_source        ?? null; }
  function scaleHardwareRevision(s)   { return s?.hardware_revision   ?? null; }
  function isScaleOnline(s) {
    return Date.now() - scaleTsToMs(scaleHeartbeatAt(s)) < SCALE_ONLINE_THRESHOLD_MS;
  }

  // Update the header status icon — three visual tiers:
  //   • scale-none      → no scale paired at all      (red, bigger, pulsing — invites discovery)
  //   • scale-connected → ≥1 paired AND online        (green, glow)
  //   • (default)       → paired but all offline      (muted grey)
  function renderScaleHealth() {
    const el = $("scaleHealth");
    if (!el) return;
    const total  = state.scales.length;
    const online = state.scales.filter(isScaleOnline).length;
    el.classList.toggle("scale-none", total === 0);
    el.classList.toggle("scale-connected", online > 0);
    if (total === 0)        el.dataset.tooltip = t("scaleHealthNone")    || "No scale connected";
    else if (online === 0)  el.dataset.tooltip = t("scaleHealthOffline", { n: total }) || `${total} scale(s) — all offline`;
    else                    el.dataset.tooltip = t("scaleHealthOnline",  { n: online, total }) || `${online}/${total} scale(s) online`;
  }

  // Render the slide-in panel listing all the user's scales with their state
  // and their last-seen spool (matched against current inventory).
  function renderScalesPanel() {
    const body = $("scalesPanelBody");
    if (!body) return;
    if (!state.scales.length) {
      // Onboarding card — promote the open-source TigerScale repo
      body.innerHTML = `
        <div class="scales-empty-card">
          <img class="scales-empty-img" src="../assets/img/TigerScale_Photo.png" alt="TigerScale" />
          <div class="scales-empty-title" data-i18n="scaleEmptyTitle">${esc(t("scaleEmptyTitle"))}</div>
          <div class="scales-empty-sub" data-i18n="scaleEmptySub">${esc(t("scaleEmptySub"))}</div>
          <ul class="scales-empty-bullets">
            <li data-i18n="scaleEmptyBullet1">${esc(t("scaleEmptyBullet1"))}</li>
            <li data-i18n="scaleEmptyBullet2">${esc(t("scaleEmptyBullet2"))}</li>
            <li data-i18n="scaleEmptyBullet3">${esc(t("scaleEmptyBullet3"))}</li>
          </ul>
          <a class="scales-empty-cta" id="scaleGithubLink" href="#">
            <span class="icon icon-github icon-14"></span>
            <span data-i18n="scaleEmptyCta">View on GitHub</span>
          </a>
          <div class="scales-empty-license" data-i18n="scaleEmptyLicense">${esc(t("scaleEmptyLicense"))}</div>
        </div>`;
      // Open the repo in the user's default browser (Electron)
      $("scaleGithubLink")?.addEventListener("click", e => {
        e.preventDefault();
        // Same pattern as the sidebar GitHub button — main.js's setWindowOpenHandler
        // routes external URLs to the OS browser via shell.openExternal.
        window.open("https://github.com/TigerTag-Project/TigerTag-Scale");
      });
      return;
    }
    body.innerHTML = state.scales.map(s => {
      const online = isScaleOnline(s);
      const lastSeenMs = scaleTsToMs(scaleHeartbeatAt(s));
      const lastSeenStr = lastSeenMs ? agoString(lastSeenMs) : "—";
      // v2 schema: current_spool_uid_1 / _2 are plain UID strings (the
      // ids of the inventory docs the firmware just detected on the
      // platform). We cross-reference against state.rows to render the
      // friendly title / colour / brand / live remaining weight.
      const uid1 = scaleCurrentSpoolUid1(s);
      const uid2 = scaleCurrentSpoolUid2(s);
      const findRowByUid = uid => state.rows.find(x =>
        String(x.uid) === String(uid) || String(x.spoolId) === String(uid));
      const renderSpool = (uid) => {
        if (!uid) return "";
        const r = findRowByUid(uid);
        const fillBg   = r ? colorBg(r) : "rgba(150,150,150,.2)";
        const fillHtml = r ? slotFillInnerHTML(r) : "";
        const titleLn  = r?.colorName && r.colorName !== "-" ? r.colorName : (r?.material || uid);
        const subLn    = r ? [r.brand, r.material].filter(Boolean).join(" · ") : `uid=${uid}`;
        const wAvail   = r?.weightAvailable ?? "—";
        return `
          <div class="scale-last-spool">
            <div class="scale-last-puck" style="background:${fillBg}">${fillHtml}</div>
            <div class="scale-last-meta">
              <div class="scale-last-name">${esc(String(titleLn))}</div>
              <div class="scale-last-sub">${esc(subLn)}</div>
            </div>
            <div class="scale-last-w">${esc(String(wAvail))}<span class="scale-last-w-unit">g</span></div>
          </div>`;
      };
      // If both UIDs reference the same physical spool (twin tags),
      // render one card; otherwise render both. We detect twin pairs
      // by checking whether one row's twin_tag_uid points at the
      // other UID.
      let lastBlock;
      if (!uid1 && !uid2) {
        lastBlock = `<div class="scale-last-empty">${esc(t("scaleNoActivity"))}</div>`;
      } else if (uid1 && uid2) {
        const r1 = findRowByUid(uid1);
        const r2 = findRowByUid(uid2);
        const isTwinPair = r1?.twinUid && (String(r1.twinUid) === String(uid2)) ||
                           r2?.twinUid && (String(r2.twinUid) === String(uid1));
        lastBlock = isTwinPair ? renderSpool(uid1) : (renderSpool(uid1) + renderSpool(uid2));
      } else {
        lastBlock = renderSpool(uid1 || uid2);
      }
      const dispName = scaleDisplayName(s) || "TigerScale";
      const battery  = scaleBatteryPercent(s);
      return `<div class="scale-card${online ? " is-online" : ""}" data-scale-mac="${esc(s.mac)}">
        <div class="scale-card-head">
          <span class="scale-card-status" title="${online ? "online" : "offline"}"></span>
          <div class="scale-card-info">
            <div class="scale-card-name">${esc(dispName)}</div>
            <div class="scale-card-meta">${esc(s.mac)} · ${online ? t("scaleStatusOnline") : `${t("scaleStatusOffline")} · ${esc(lastSeenStr)}`}</div>
          </div>
          <div class="scale-card-actions">
            <button class="scale-card-btn" data-action="delete" title="${t("scaleRemove")}"><span class="icon icon-trash icon-13"></span></button>
          </div>
        </div>
        ${lastBlock}
        <div class="scale-card-fw">
          ${s.fw_version ? `fw ${esc(s.fw_version)}` : ""}
          ${battery != null ? `· ${esc(String(battery))}% battery` : ""}
        </div>
      </div>`;
    }).join("");

    // Wire delete buttons
    body.querySelectorAll(".scale-card-btn[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest("[data-scale-mac]");
        const mac = card?.dataset.scaleMac;
        if (!mac) return;
        const s = state.scales.find(x => x.mac === mac);
        if (!s) return;
        if (!confirm(t("scaleRemoveConfirm", { name: scaleDisplayName(s) || mac }))) return;
        try {
          const uid = state.activeAccountId;
          await fbDb(uid).collection("users").doc(uid).collection("scales").doc(mac).delete();
        } catch (e) { reportError("scale.delete", e); }
      });
    });
  }

  // "5m ago" / "2h ago" — small relative-time helper for last_seen
  function agoString(ms) {
    const dt = Math.max(0, Date.now() - ms);
    const m = Math.floor(dt / 60000);
    if (m < 1)  return t("agoNow")   || "just now";
    if (m < 60) return t("agoMin",  { n: m }) || `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return t("agoHour", { n: h }) || `${h}h`;
    const d = Math.floor(h / 24);
    return t("agoDay", { n: d }) || `${d}d`;
  }

  // Scale-health icon tick — recompute online status every 10s even without
  // new snapshots (since "online" depends on "now" against last_seen).
  setInterval(() => {
    if (!state.scales.length) return;
    renderScaleHealth();
    if ($("scalesPanel")?.classList.contains("open")) renderScalesPanel();
  }, 10 * 1000);

  async function createRack({ name, level, position }) {
    const user = fbAuth().currentUser;
    if (!user) { console.warn("[createRack] no user"); return null; }
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const order = state.racks.length;
    const payload = {
      name: name.trim() || "Rack",
      level: Math.max(1, Math.min(15, parseInt(level, 10) || 1)),
      position: Math.max(1, Math.min(20, parseInt(position, 10) || 1)),
      order,
      createdAt: ts,
      lastUpdate: ts
    };
    console.log(`[createRack] writing to users/${user.uid}/racks/`, payload);
    const doc = await fbDb().collection("users").doc(user.uid)
      .collection("racks").add(payload);
    console.log(`[createRack] OK → id=${doc.id}`);
    return doc.id;
  }

  async function updateRack(rackId, fields) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const rackRef = fbDb().collection("users").doc(user.uid).collection("racks").doc(rackId);
    const batch = fbDb().batch();
    batch.set(rackRef, {
      ...fields,
      lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // If dimensions shrink, every spool whose slot is out of the new bounds
    // is orphaned and must return to the unranked sidebar — same batch so
    // it's atomic. We iterate `state.rows` (already normalised, reads both
    // legacy flat and nested rack schemas) so the query stays schema-agnostic.
    const newLevel = fields.level;
    const newPos   = fields.position;
    if (newLevel != null || newPos != null) {
      let freed = 0;
      state.rows.forEach(row => {
        if (row.rackId !== rackId || row.deleted) return;
        const oobLevel = (newLevel != null && Number.isInteger(row.rackLevel) && row.rackLevel >= newLevel);
        const oobPos   = (newPos   != null && Number.isInteger(row.rackPos)   && row.rackPos   >= newPos);
        if (oobLevel || oobPos) {
          batch.update(invRef.doc(row.spoolId), { rack: null });
          freed++;
        }
      });
      if (freed > 0) console.log(`[updateRack] resized rack ${rackId} → freed ${freed} out-of-bounds spool(s)`);
    }

    await batch.commit();
  }

  async function deleteRack(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch = fbDb().batch();
    // Free all spools currently assigned to this rack — `state.rows` is
    // schema-agnostic so we catch both legacy (flat) and migrated (nested)
    // docs in one pass.
    state.rows.forEach(row => {
      if (row.rackId === rackId && !row.deleted) {
        batch.update(invRef.doc(row.spoolId), { rack: null });
      }
    });
    batch.delete(fbDb().collection("users").doc(user.uid)
      .collection("racks").doc(rackId));
    await batch.commit();
  }

  // Unassign all spools from a rack but keep the rack itself.
  // Returns the number of spools that were freed.
  async function emptyRack(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return 0;
    await playEmptyRackCascade(rackId);
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const targets = state.rows.filter(r => r.rackId === rackId && !r.deleted);
    if (!targets.length) return 0;
    const batch = fbDb().batch();
    targets.forEach(row => batch.update(invRef.doc(row.spoolId), { rack: null }));
    await batch.commit();
    return targets.length;
  }

  // Visually animate every filled slot of a rack flying out to the unranked
  // panel, with a stagger. Resolves once the last slot has finished its
  // animation. Pure visual — does not touch Firestore.
  function playEmptyRackCascade(rackId) {
    return new Promise(resolve => {
      const card = document.querySelector(`#invRackView .rp-rack[data-rack-id="${CSS.escape(rackId)}"]`);
      if (!card) return resolve();
      const filled = Array.from(card.querySelectorAll(".rp-slot--filled"));
      if (!filled.length) return resolve();
      // Sort top→bottom, left→right
      filled.sort((a, b) => {
        const lvA = parseInt(a.dataset.level, 10), lvB = parseInt(b.dataset.level, 10);
        if (lvA !== lvB) return lvB - lvA;
        return parseInt(a.dataset.pos, 10) - parseInt(b.dataset.pos, 10);
      });
      const STAGGER = 30;
      const ANIM_MS = 280;
      filled.forEach((el, i) => {
        el.style.animationDelay = (i * STAGGER) + "ms";
        el.classList.add("rp-slot--cascade-out");
      });
      const totalMs = (filled.length - 1) * STAGGER + ANIM_MS + 20;
      setTimeout(resolve, totalMs);
    });
  }

  // Set of spoolIds that just landed in a slot — used by renderRackView to
  // trigger a one-time "bounce-in" animation when the snapshot rebuilds the DOM.
  // Cleared as each animation fires.
  const _justPlacedSpools = new Set();
  // Set of "rackId|lv|pos" coordinates that should bounce on next render
  // (for empty-rack moves where the spoolId may have moved to unranked sidebar).
  const _justFilledSlots = new Set();

  // Some spools are physically two RFID tags glued to the same spool
  // (a "twin" pair). Their inventory docs are linked via `twin_tag_uid` /
  // `twinUid`. Storage location must mirror to BOTH docs so a scan of
  // either tag returns the correct rack/level/position. This helper
  // returns the twin's spoolId or null when there's no twin.
  function twinSpoolIdOf(row) {
    if (!row || !row.twinUid) return null;
    const twin = state.rows.find(r =>
      r.spoolId !== row.spoolId &&
      (String(r.uid) === String(row.twinUid) || String(r.spoolId) === String(row.twinUid))
    );
    return twin ? twin.spoolId : null;
  }

  // Assign / move / unassign a spool to a slot. Performs a swap if the target
  // slot is already occupied (in a single Firestore batch for atomicity).
  // Twin pairs (linked RFID tags) are written together so both docs stay
  // in sync.
  async function assignSpoolToSlot(spoolId, rackId, level, position) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const batch  = fbDb().batch();

    // Find any spool currently in the target slot
    const occupant = state.rows.find(r =>
      !r.deleted && r.rackId === rackId && r.rackLevel === level && r.rackPos === position
      && r.spoolId !== spoolId
    );
    // Where the moved spool is coming from (may be null = unranked)
    const moving = state.rows.find(r => r.spoolId === spoolId);

    // Mirror an update to the twin's doc when the row has a twin.
    const writeWithTwin = (row, fields, fallbackId) => {
      const id = row?.spoolId || fallbackId;
      if (!id) return;
      batch.update(invRef.doc(id), fields);
      const twinId = row ? twinSpoolIdOf(row) : null;
      if (twinId) batch.update(invRef.doc(twinId), fields);
    };

    if (occupant && moving && moving.rackId) {
      // Swap: occupant moves to the moving spool's previous slot
      writeWithTwin(occupant, {
        rack: { id: moving.rackId, level: moving.rackLevel, position: moving.rackPos }
      });
    } else if (occupant) {
      // Coming from unranked → push the occupant out as unranked
      writeWithTwin(occupant, { rack: null });
    }
    // Place the new spool into the target slot (mirror to twin if any)
    writeWithTwin(moving, { rack: { id: rackId, level, position } }, spoolId);
    // Tag this spool for the next render — bounce-in animation
    _justPlacedSpools.add(spoolId);
    await batch.commit();
  }

  async function unassignSpool(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
    const row = state.rows.find(r => r.spoolId === spoolId);
    const twinId = row ? twinSpoolIdOf(row) : null;
    const fields = { rack: null };
    if (twinId) {
      // Twin pair → atomic batch so both docs flip together.
      const batch = fbDb().batch();
      batch.update(invRef.doc(spoolId), fields);
      batch.update(invRef.doc(twinId),  fields);
      await batch.commit();
    } else {
      await invRef.doc(spoolId).update(fields);
    }
  }


  // Render the racks list inside the racks panel
  // Inner HTML for a chip / filled slot — uses colorBg(row) to support any
  // color style (mono / bicolor / tricolor / rainbow / conic_gradient) and
  // overlays a fill level matching the remaining weight.
  function slotFillInnerHTML(row) {
    const cap = row.capacity || 1000;
    const cur = row.weightAvailable != null ? row.weightAvailable : 0;
    const pct = Math.max(0, Math.min(100, Math.round((cur / cap) * 100)));
    const bg  = colorBg(row);  // CSS background expression (may be a gradient)
    // Depleted (≤ 0g): show a thin colored strip at the bottom + an "EMPTY"
    // indicator so the slot looks distinct from a free slot. Without this,
    // a 0% fill produces nothing visible and the slot looks unoccupied.
    if (pct <= 0) {
      return `<div class="rp-fill rp-fill--depleted" style="background:${bg}"></div>
              <div class="rp-fill-empty-tag" aria-hidden="true">0g</div>`;
    }
    return `<div class="rp-fill" style="height:${pct}%;background:${bg}"></div>`;
  }

  // Cache: which spool is currently in (rackId, level, position)?
  function findSpoolInSlot(rackId, level, position) {
    return state.rows.find(r =>
      !r.deleted && r.rackId === rackId &&
      r.rackLevel === level && r.rackPos === position
    );
  }

  /* ── Slot locking ───────────────────────────────────────────────────────
     A locked slot blocks drag-out (if filled) and drag-in (if empty).
     Stored as an array of "<level>:<position>" strings on the rack doc. */
  function slotLockKey(level, position) { return `${level}:${position}`; }
  function isSlotLocked(rackId, level, position) {
    const r = state.racks.find(x => x.id === rackId);
    if (!r) return false;
    return Array.isArray(r.lockedSlots)
      && r.lockedSlots.includes(slotLockKey(level, position));
  }
  async function toggleSlotLock(rackId, level, position) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const r = state.racks.find(x => x.id === rackId);
    if (!r) return;
    const key = slotLockKey(level, position);
    const cur = Array.isArray(r.lockedSlots) ? r.lockedSlots : [];
    const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
    await fbDb().collection("users").doc(user.uid)
      .collection("racks").doc(rackId)
      .update({
        lockedSlots: next,
        lastUpdate: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }
  // Lock every slot in a rack (used by the kebab "Lock all" menu item).
  async function lockAllSlots(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const r = state.racks.find(x => x.id === rackId);
    if (!r) return;
    const all = [];
    for (let lv = 0; lv < (r.level || 0); lv++) {
      for (let pos = 0; pos < (r.position || 0); pos++) {
        all.push(slotLockKey(lv, pos));
      }
    }
    await fbDb().collection("users").doc(user.uid)
      .collection("racks").doc(rackId)
      .update({
        lockedSlots: all,
        lastUpdate: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }
  async function unlockAllSlots(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    await fbDb().collection("users").doc(user.uid)
      .collection("racks").doc(rackId)
      .update({
        lockedSlots: [],
        lastUpdate: firebase.firestore.FieldValue.serverTimestamp(),
      });
  }
  // Position a kebab menu against its anchor button. Uses fixed positioning so
  // the menu escapes the rack card's overflow + the racks-col flex layout.
  // Flips to the left if the button is too close to the right edge.
  function positionRackMenu(menu, anchorBtn) {
    const rect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.zIndex = "1000";
    // Measure menu (it's now visible, so offsetWidth/Height are real)
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 200;
    // Default: align right edge to anchor right edge, drop down from anchor
    let left = rect.right - mw;
    let top  = rect.bottom + 4;
    // Keep inside viewport
    const maxLeft = window.innerWidth - mw - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    // Flip up if not enough room below
    if (top + mh > window.innerHeight - 8) {
      top = rect.top - mh - 4;
      if (top < 8) top = 8;
    }
    menu.style.left = left + "px";
    menu.style.top  = top + "px";
  }

  /* ── Auto-fill: assign unranked spools to empty (and unlocked) slots,
     iterating racks in order, top→bottom, left→right.  Single Firestore
     batch so the snapshot updates atomically. */
  // If `rackId` is provided, fill ONLY that rack. Otherwise fill all racks.
  async function autoFillEmptySlots(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return 0;
    // Exclude depleted spools from the pool — there's no point storing an
    // empty roll, and it would loop with auto-unstorage if both are ON.
    const pool = getUnrackedSpools().filter(r =>
      r.weightAvailable == null || Number(r.weightAvailable) > 0
    );
    if (!pool.length || !state.racks.length) return 0;
    const targets = rackId
      ? state.racks.filter(r => r.id === rackId)
      : state.racks;
    if (!targets.length) return 0;
    const batch = fbDb().batch();
    let placed = 0;
    outer:
    for (const r of targets) {
      for (let lv = r.level - 1; lv >= 0; lv--) {
        for (let pos = 0; pos < r.position; pos++) {
          if (!pool.length) break outer;
          if (isSlotLocked(r.id, lv, pos)) continue;
          if (findSpoolInSlot(r.id, lv, pos)) continue;
          const spool = pool.shift();
          const invCol = fbDb().collection("users").doc(user.uid).collection("inventory");
          const fields = { rack: { id: r.id, level: lv, position: pos } };
          batch.update(invCol.doc(spool.spoolId), fields);
          // Mirror the location to the linked twin tag, if any.
          const twinId = twinSpoolIdOf(spool);
          if (twinId) batch.update(invCol.doc(twinId), fields);
          // Mark each newly-filled slot for staggered bounce-in
          _justPlacedSpools.add(spool.spoolId);
          placed++;
        }
      }
    }
    if (!placed) return 0;
    await batch.commit();
    return placed;
  }

  /* Auto-storage feature — when the toggle in the "Spools not stored" side
     panel is ON, every fresh inventory snapshot triggers this routine to
     drop newly-detected unranked spools into the first free slot.
     Throttled to one run per snapshot batch (no recursion when our own
     writes propagate). */
  let _autoStoreInFlight = false;
  async function maybeAutoStoreUnrankedSpools() {
    if (_autoStoreInFlight) return;
    if (state.friendView) return;                 // never write on a friend's account
    if (localStorage.getItem("tigertag.autoStorage.enabled") !== "true") return;
    if (!state.racks.length) return;              // nothing to fill into
    _autoStoreInFlight = true;
    try {
      const placed = await autoFillEmptySlots();
      if (placed > 0) console.log(`[autoStorage] placed ${placed} spool(s) automatically`);
    } catch (e) {
      console.warn("[autoStorage] failed:", e?.message);
    } finally {
      // Hold the lock briefly so the resulting snapshot doesn't re-trigger
      // a no-op pass before our writes have settled.
      setTimeout(() => { _autoStoreInFlight = false; }, 1500);
    }
  }

  /* Auto-unstorage feature — when ON, any spool currently placed in a
     rack whose `weight_available` reached 0 is automatically removed from
     the rack (rack_id / level / position cleared). The spool is NOT
     deleted: it simply returns to the "Spools not stored" pile, ready to
     be replaced by a fresh roll or kept for re-use of the empty cardboard.
     One Firestore batch per snapshot, throttled identically to auto-store. */
  let _autoUnstoreInFlight = false;
  async function maybeAutoUnstoreDepletedSpools() {
    if (_autoUnstoreInFlight) return;
    if (state.friendView) return;
    if (localStorage.getItem("tigertag.autoUnstorage.enabled") !== "true") return;
    const targets = state.rows.filter(r =>
      !r.deleted &&
      r.rackId != null &&                                  // currently placed
      r.weightAvailable != null &&
      Number(r.weightAvailable) <= 0                       // depleted
    );
    if (!targets.length) return;
    _autoUnstoreInFlight = true;
    try {
      const user = fbAuth().currentUser;
      if (!user) return;
      const invRef = fbDb().collection("users").doc(user.uid).collection("inventory");
      const batch  = fbDb().batch();
      const clearFields = { rack: null };
      targets.forEach(t => {
        batch.update(invRef.doc(t.spoolId), clearFields);
        // Mirror the unstore to the linked twin tag, if any.
        const twinId = twinSpoolIdOf(t);
        if (twinId) batch.update(invRef.doc(twinId), clearFields);
      });
      await batch.commit();
      console.log(`[autoUnstorage] freed ${targets.length} depleted spool(s)`);
    } catch (e) {
      console.warn("[autoUnstorage] failed:", e?.message);
    } finally {
      setTimeout(() => { _autoUnstoreInFlight = false; }, 1500);
    }
  }

  /* Place ONE specific spool in the first available unlocked slot — used
     by the "Auto-assign" button in the spool detail panel when a spool
     isn't yet stored anywhere. Returns the {rackId, level, position}
     that was claimed, or null if all slots are taken. */
  async function autoAssignSingleSpool(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return null;
    const spool = state.rows.find(r => r.spoolId === spoolId);
    if (!spool || spool.deleted) return null;
    if (spool.rackId != null) return null;     // already placed
    for (const rack of state.racks) {
      for (let lv = (rack.level || 0) - 1; lv >= 0; lv--) {
        for (let pos = 0; pos < (rack.position || 0); pos++) {
          if (isSlotLocked(rack.id, lv, pos)) continue;
          if (findSpoolInSlot(rack.id, lv, pos)) continue;
          // Twin-aware write: when the spool has a paired twin tag we
          // mirror the location to the twin's doc inside one batch so
          // both stay synchronised.
          const invCol = fbDb().collection("users").doc(user.uid).collection("inventory");
          const fields = { rack: { id: rack.id, level: lv, position: pos } };
          const twinId = twinSpoolIdOf(spool);
          if (twinId) {
            const batch = fbDb().batch();
            batch.update(invCol.doc(spoolId), fields);
            batch.update(invCol.doc(twinId),  fields);
            await batch.commit();
          } else {
            await invCol.doc(spoolId).update(fields);
          }
          // Tag for the bounce-in animation on next render
          _justPlacedSpools.add(spoolId);
          return { rackId: rack.id, level: lv, position: pos, rackName: rack.name };
        }
      }
    }
    return null;
  }

  // Greys out filled rack slots whose spool doesn't match the main search bar
  // (#searchInv) AND/OR the brand/material quick-filters.
  function applyRackSearchDim() {
    const q = (state.search || "").trim().toLowerCase();
    const brand = state.brandFilter || "";
    const material = state.materialFilter || "";
    const noFilter = !q && !brand && !material;
    document.querySelectorAll("#invRackView .rp-slot--filled").forEach(el => {
      if (noFilter) {
        el.classList.remove("rp-dim");
        el.classList.remove("rp-slot--match");
        return;
      }
      const sid = el.dataset.spoolId;
      const r = state.rows.find(x => x.spoolId === sid);
      if (!r) { el.classList.add("rp-dim"); el.classList.remove("rp-slot--match"); return; }
      const matchSearch = !q || [r.uid, r.colorName, r.material, r.brand, r.series, r.sku, r.barcode]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
      const matchBrand = !brand || String(r.brand) === brand;
      const matchMaterial = !material || String(r.material) === material;
      const type = state.typeFilter || "";
      const matchType = !type || String(r.productType) === type;
      const matches = matchSearch && matchBrand && matchMaterial && matchType;
      el.classList.toggle("rp-dim", !matches);
      // Positive match indicator on the slot CONTAINER (border + glow) —
      // makes depleted spools (whose .rp-fill is invisible at 0%) still
      // clearly findable when the user is searching.
      el.classList.toggle("rp-slot--match", matches);
    });
  }

  // True when a spool has been used up (weight_available ≤ 0). Used
  // to exclude empties from various COUNTS (unranked total, stats
  // tile, search counter) without removing them from the actual
  // display lists — the user still wants to SEE the empty spool.
  // Negative numbers are also treated as empty (some chips ship with
  // a slightly miscalibrated zero point).
  function isEmptyRow(r) {
    const w = Number(r?.weightAvailable);
    return Number.isFinite(w) && w <= 0;
  }

  // Filter unranked spools (rack_id is null/missing, not deleted).
  // Empty spools ARE kept visible (user can still see / manage them)
  // — they are only excluded from COUNTS via isEmptyRow().
  function getUnrackedSpools() {
    const search = ($("rpUnrackedSearch")?.value || "").trim().toLowerCase();
    return state.rows.filter(r => {
      if (r.deleted) return false;
      if (r.rackId) return false;   // already placed
      if (!search) return true;
      return (
        (r.uid || "").toLowerCase().includes(search) ||
        String(r.material || "").toLowerCase().includes(search) ||
        String(r.brand || "").toLowerCase().includes(search) ||
        String(r.colorName || "").toLowerCase().includes(search)
      );
    });
  }

  // Backwards-compat alias — older code paths called renderRacksList()
  function renderRacksList() { renderRackView(); }

  // Build a single unranked-spool row (for the right sidebar).
  // Layout: line 1 = brand (primary identity), line 2 = material · colorName
  // so the user can scan brands first then drill into the variant.
  // In read-only mode (friend view) the row is non-draggable.
  function unrackedRowHTML(row) {
    const readOnly = !!state.friendView;
    const tip = `${esc(row.brand || "")} · ${esc(row.material || "")}\n${esc(row.colorName || row.uid || "")}`;
    const titleLine = row.brand || row.material || row.uid || "—";
    const subLine   = [row.material, row.colorName].filter(Boolean).join(" · ");
    const wAvail    = row.weightAvailable != null ? row.weightAvailable : "—";
    const wCap      = row.capacity || 1000;
    return `<div class="rp-side-row" draggable="${readOnly ? "false" : "true"}" data-spool-id="${esc(row.spoolId)}" title="${tip}">
      <div class="rp-side-puck">${slotFillInnerHTML(row)}</div>
      <div class="rp-side-meta">
        <div class="rp-side-name">${esc(titleLine)}</div>
        <div class="rp-side-sub">${esc(subLine || "—")}</div>
      </div>
      <div class="rp-side-w">${wAvail}<span class="rp-side-w-unit">/${wCap}g</span></div>
    </div>`;
  }

  // Set by a side-row dragend, used to defer renderRackView so the panel
  // slide-back animation isn't cut off by an incoming Firestore snapshot.
  let _unrackedSettleUntil = 0;
  let _rackRenderDeferred = false;
  // Set by setViewMode("rack") when force-opening the panel — triggers a
  // slide-in animation on the next render instead of appearing already open.
  let _unrackedAnimateOpen = false;
  // Currently-dragged rack id for drag-and-drop reordering, or null.
  let _draggingRackId = null;

  /* ── Skyline-packing masonry layout ────────────────────────────────────
     Places each .rp-racks-col child at the leftmost-lowest free position
     so racks of varying widths AND heights pack tightly (Pinterest-style).
     Children become position:absolute; the container's height is set to
     match the tallest column so the page reflows correctly.
     Re-runs on:
       - every renderRackView (after innerHTML)
       - window resize (debounced)
       - ResizeObserver on the container (panel toggles, etc.)
     Skyline = sorted array of {x, end, y} segments representing the current
     bottom of every reserved horizontal interval.  */
  let _masonryRO = null;
  let _masonryResizeTimer = null;
  let _masonryLastWidth = 0;
  function layoutRacksMasonry() {
    const container = document.querySelector("#invRackView .rp-racks-col");
    if (!container) return;
    const items = Array.from(container.children);
    if (!items.length) { container.style.height = ""; return; }

    // Reset positioning so we can measure natural sizes
    container.style.position = "relative";
    items.forEach(el => {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
    });

    const containerWidth = container.clientWidth;
    if (!containerWidth) return;
    const GAP_X = 14;
    const GAP_Y = 14;

    // Force a reflow to get accurate dimensions after the reset
    const dims = items.map(el => ({ el, w: el.offsetWidth, h: el.offsetHeight }));

    // Skyline: array of horizontal segments at given y
    let skyline = [{ x: 0, end: containerWidth, y: 0 }];

    function maxYInRange(x, end) {
      let m = 0;
      for (const seg of skyline) {
        if (seg.end <= x) continue;
        if (seg.x >= end) break;
        if (seg.y > m) m = seg.y;
      }
      return m;
    }
    function reserve(x, w, newY) {
      const end = x + w;
      const next = [];
      for (const seg of skyline) {
        if (seg.end <= x || seg.x >= end) {
          next.push(seg);
        } else {
          if (seg.x < x)   next.push({ x: seg.x, end: x,        y: seg.y });
          if (seg.end > end) next.push({ x: end, end: seg.end,  y: seg.y });
        }
      }
      next.push({ x, end, y: newY });
      next.sort((a, b) => a.x - b.x);
      // Merge adjacent segments at same y
      const merged = [];
      for (const seg of next) {
        const last = merged[merged.length - 1];
        if (last && last.end === seg.x && last.y === seg.y) last.end = seg.end;
        else merged.push(seg);
      }
      skyline = merged;
    }

    let totalHeight = 0;
    dims.forEach(({ el, w, h }) => {
      if (!w || !h) return;
      // Candidate x positions = skyline segment starts. Pick lowest y, then leftmost x.
      let best = null;
      for (const seg of skyline) {
        const x = seg.x;
        if (x + w > containerWidth) continue;
        const y = maxYInRange(x, x + w);
        if (best === null || y < best.y || (y === best.y && x < best.x)) best = { x, y };
      }
      if (!best) {
        // Doesn't fit horizontally — drop on a new row at x=0
        best = { x: 0, y: skyline.reduce((m, s) => Math.max(m, s.y), 0) };
      }
      el.style.position = "absolute";
      el.style.left = best.x + "px";
      el.style.top  = best.y + "px";
      // Reserve [x, x + w + GAP_X] at height (y + h + GAP_Y) so the next
      // item placed in this x-range has a vertical gap, and any item starting
      // immediately to the right is pushed out by GAP_X.
      reserve(best.x, w + GAP_X, best.y + h + GAP_Y);
      const bottom = best.y + h;
      if (bottom > totalHeight) totalHeight = bottom;
    });
    container.style.height = totalHeight + "px";
  }
  function scheduleMasonryRelayout() {
    clearTimeout(_masonryResizeTimer);
    _masonryResizeTimer = setTimeout(layoutRacksMasonry, 60);
  }
  // One global window-resize listener (registered lazily, never duplicated)
  if (typeof window !== "undefined" && !window._racksMasonryWired) {
    window._racksMasonryWired = true;
    window.addEventListener("resize", scheduleMasonryRelayout);
  }

  /* Reorder racks: move srcId before/after targetId in the visual order, then
     write the new `order` index back to Firestore for every rack that shifted.
     The state.racks array is sorted client-side by `order` so the next snapshot
     re-render reflects the new positions. */
  async function reorderRacks(srcId, targetId, beforeTarget) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const list = state.racks.slice();
    const srcIdx = list.findIndex(r => r.id === srcId);
    if (srcIdx === -1) return;
    const [moved] = list.splice(srcIdx, 1);
    let targetIdx = list.findIndex(r => r.id === targetId);
    if (targetIdx === -1) return;
    list.splice(beforeTarget ? targetIdx : targetIdx + 1, 0, moved);
    // Write new order indices in a single batch — only for racks whose index changed
    const ref = fbDb().collection("users").doc(user.uid).collection("racks");
    const batch = fbDb().batch();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    let writes = 0;
    list.forEach((r, i) => {
      if (r.order !== i) {
        batch.update(ref.doc(r.id), { order: i, lastUpdate: ts });
        writes++;
      }
    });
    if (writes) await batch.commit();
    console.log(`[reorderRacks] moved ${srcId} ${beforeTarget ? "before" : "after"} ${targetId} — wrote ${writes} order(s)`);
  }

  /* ── Rich hover tooltip for filled rack slots ──────────────────────────
     A single floating element (#rackHoverTip) is reused for every slot. On
     mouseenter we populate it with the spool data and position it above
     (or below) the hovered slot; mouseleave hides it. Hidden while a
     drag is in progress so the bubble doesn't fight the drag-target ring.
     Uses event delegation on #invRackView so it auto-applies to every
     re-render without re-wiring per slot. */
  function ensureRackTooltipEl() {
    let tip = document.getElementById("rackHoverTip");
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "rackHoverTip";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tip);
    return tip;
  }
  function buildRackTooltipHTML(row, coord, locked) {
    const cap = row.capacity || 1000;
    const cur = row.weightAvailable != null ? row.weightAvailable : 0;
    const pct = Math.max(0, Math.min(100, Math.round((cur / cap) * 100)));
    const bg  = colorBg(row);
    const brand = row.brand || "—";
    const material = row.material || "—";
    const colorName = row.colorName || "";
    return `
      <div class="rht-head">
        <div class="rht-puck"><div class="rht-puck-fill" style="height:${pct}%;background:${bg}"></div></div>
        <div class="rht-titles">
          <div class="rht-brand">${esc(brand)}</div>
          <div class="rht-mat">${esc(material)}${colorName ? ` · ${esc(colorName)}` : ""}</div>
        </div>
        ${coord ? `<div class="rht-coord">${esc(coord)}</div>` : ""}
      </div>
      <div class="rht-weight">
        <div class="rht-weight-line">
          <span class="rht-weight-cur">${cur}</span><span class="rht-weight-sep">/</span><span class="rht-weight-cap">${cap} g</span>
          <span class="rht-weight-pct">${pct}%</span>
        </div>
        <div class="rht-weight-bar"><div class="rht-weight-bar-fill" style="width:${pct}%"></div></div>
      </div>
      ${locked ? `<div class="rht-locked"><span class="icon icon-lock icon-13"></span>${esc(t("rackLockedTip"))}</div>` : ""}
    `;
  }
  function positionRackTooltip(tip, slot) {
    const rect = slot.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const PAD = 8;
    // Default: above the slot, horizontally centered on it
    let left = rect.left + rect.width / 2 - tw / 2;
    let top  = rect.top - th - PAD;
    // Clamp horizontally
    if (left < PAD) left = PAD;
    if (left + tw > window.innerWidth - PAD) left = window.innerWidth - tw - PAD;
    // Flip below if not enough room above
    if (top < PAD) top = rect.bottom + PAD;
    tip.style.left = left + "px";
    tip.style.top  = top + "px";
  }
  function showRackTooltipFor(slot) {
    if (document.body.classList.contains("is-dragging-spool")) return;
    const sid = slot.dataset.spoolId;
    if (!sid) return;
    const row = state.rows.find(r => r.spoolId === sid);
    if (!row) return;
    const tip = ensureRackTooltipEl();
    const coord = slot.dataset.coord || "";
    const locked = slot.classList.contains("rp-slot--locked");
    tip.innerHTML = buildRackTooltipHTML(row, coord, locked);
    tip.classList.add("is-open");
    tip.setAttribute("aria-hidden", "false");
    // Defer positioning to next frame so we have correct measured size
    requestAnimationFrame(() => positionRackTooltip(tip, slot));
  }
  function hideRackTooltip() {
    const tip = document.getElementById("rackHoverTip");
    if (!tip) return;
    tip.classList.remove("is-open");
    tip.setAttribute("aria-hidden", "true");
  }
  // Wire delegated mouseover/mouseout on #invRackView ONCE — survives re-renders.
  function wireRackTooltipDelegation() {
    const root = $("invRackView");
    if (!root || root._tooltipWired) return;
    root._tooltipWired = true;
    root.addEventListener("mouseover", e => {
      const slot = e.target.closest(".rp-slot--filled");
      if (!slot) return;
      // Only fire when the cursor first enters the slot (not on child re-targets)
      if (e.relatedTarget && slot.contains(e.relatedTarget)) return;
      showRackTooltipFor(slot);
    });
    root.addEventListener("mouseout", e => {
      const slot = e.target.closest(".rp-slot--filled");
      if (!slot) return;
      if (e.relatedTarget && slot.contains(e.relatedTarget)) return;
      hideRackTooltip();
    });
    // Hide on scroll inside the rack view (the slot moves but the tip stays)
    root.addEventListener("scroll", hideRackTooltip, true);
  }

  function renderRackView() {
    const list = $("invRackView");
    if (!list) return;
    // ── Read-only flag — true when viewing a friend's storage. Disables
    // create / edit / delete / drag / drop / lock-toggle. Kept as one variable
    // (vs scattering checks) so future call sites stay consistent.
    const readOnly = !!state.friendView;
    list.classList.toggle("is-read-only", readOnly);
    wireRackTooltipDelegation();
    // If a side-row drag just ended, defer rebuild until the slide-back finishes
    const remaining = _unrackedSettleUntil - Date.now();
    if (remaining > 0 && !_rackRenderDeferred) {
      _rackRenderDeferred = true;
      setTimeout(() => { _rackRenderDeferred = false; renderRackView(); }, remaining);
      return;
    }

    // ── Stats bar — global overview at the top of Storage. Shows: rack count,
    // filled-vs-total slots (with mini progress bar), empty count, locked count,
    // and the "Spools not stored" toggle on the right.
    // The count excludes empty spools (weight ≤ 0) — they stay visible in
    // the panel but don't inflate the headline number.
    const unrankedCount = getUnrackedSpools().filter(r => !isEmptyRow(r)).length;
    const racksCount   = state.racks.length;
    let totalSlotsAll = 0, filledSlotsAll = 0, lockedSlotsAll = 0;
    state.racks.forEach(r => {
      const cap = (r.level || 0) * (r.position || 0);
      totalSlotsAll += cap;
      lockedSlotsAll += Array.isArray(r.lockedSlots) ? r.lockedSlots.length : 0;
    });
    filledSlotsAll = state.rows.filter(x => !x.deleted && x.rackId).length;
    const emptySlotsAll = Math.max(0, totalSlotsAll - filledSlotsAll);
    const fillPctAll = totalSlotsAll > 0 ? Math.round((filledSlotsAll / totalSlotsAll) * 100) : 0;
    // Depleted spools: active inventory items where the user has used up
    // all the filament (weightAvailable <= 0). They're still in the
    // database but ready to be discarded / replaced.
    const depletedSpoolsCount = state.rows.filter(x =>
      !x.deleted && (x.weightAvailable != null) && Number(x.weightAvailable) <= 0
    ).length;
    const racksLabel = t("rackStatsRacks", { n: racksCount });
    // The unranked panel is opened/closed by the "not stored" tile in the
    // stats bar (we still need this read here to set the tile's active state).
    // Forced closed when the active count is 0 — there's nothing actionable
    // to show, so the panel sliding in just wastes screen real estate. The
    // user's persisted preference is preserved (we don't overwrite it),
    // we just don't honour it when the panel would open empty.
    const userWantsPanelOpen = localStorage.getItem("tigertag.unrackedPanelOpen") !== "false";
    const panelOpenInit = userWantsPanelOpen && unrankedCount > 0;
    let html = `
      <div class="rv-header">
        <div class="rv-stats" role="group" aria-label="Storage overview">
          ${readOnly ? "" : `<button id="btnNewRackTile" class="rv-stat rv-stat-add" title="${esc(t("rackNew"))}" aria-label="${esc(t("rackNew"))}">
            <div class="rv-stat-num rv-stat-num--plus">+</div>
            <div class="rv-stat-lbl">${esc(t("rackNew"))}</div>
          </button>`}
          ${racksCount ? `
          <div class="rv-stat" data-stat="racks" title="${esc(racksLabel)}">
            <div class="rv-stat-num">${racksCount}</div>
            <div class="rv-stat-lbl">${esc(racksLabel)}</div>
          </div>
          <div class="rv-stat rv-stat--wide rv-stat--slots" data-stat="slots" title="${filledSlotsAll}/${totalSlotsAll} ${esc(t("rackStatsSlots"))}">
            <div class="rv-stat-line">
              <span class="rv-stat-num"><span class="rv-stat-num-strong">${filledSlotsAll}</span><span class="rv-stat-num-sep">/</span><span class="rv-stat-num-soft">${totalSlotsAll}</span></span>
              <span class="rv-stat-lbl rv-stat-lbl--inline">${esc(t("rackStatsSlots"))}</span>
            </div>
            <div class="rv-stat-bar"><div class="rv-stat-bar-fill" style="width:${fillPctAll}%"></div></div>
          </div>
          <div class="rv-stat rv-stat--clickable" data-stat="empty" title="Highlight empty slots">
            <div class="rv-stat-num">${emptySlotsAll}</div>
            <div class="rv-stat-lbl">${esc(t("rackStatsEmpty"))}</div>
          </div>
          <div class="rv-stat rv-stat--clickable" data-stat="locked" title="Highlight locked slots">
            <div class="rv-stat-num">${lockedSlotsAll}</div>
            <div class="rv-stat-lbl">${esc(t("rackStatsLocked"))}</div>
          </div>
          <div class="rv-stat rv-stat--clickable" data-stat="depleted" title="${esc(t("rackStatsDepletedTip") || "Spools with no filament left")}">
            <div class="rv-stat-num">${depletedSpoolsCount}</div>
            <div class="rv-stat-lbl">${esc(t("rackStatsDepleted"))}</div>
          </div>` : ``}
          <div id="btnToggleUnranked" class="rv-stat rv-stat--clickable rv-stat--orange${panelOpenInit ? " rv-stat--active" : ""}" data-stat="unranked" title="${esc(t("rackUnrackedTitle"))}" role="button" tabindex="0" aria-pressed="${panelOpenInit ? "true" : "false"}">
            <div class="rv-stat-body">
              <div class="rv-stat-num">${unrankedCount}</div>
              <div class="rv-stat-lbl">${esc(t("rackStatsUnranked"))}</div>
            </div>
            <span class="rv-stat-chev icon icon-chevrons-r icon-20" aria-hidden="true"></span>
          </div>
        </div>
      </div>`;

    // ── Two-column layout: left = racks (or empty-state when none),
    //    right = unranked sidebar (always shown so the user can see/manage
    //    their filaments even before creating a first rack).
    const unranked = getUnrackedSpools();
    const sideRows = unranked.map(unrackedRowHTML).join("")
                  || `<div class="rp-unranked-empty">${t("rackAllPlaced")}</div>`;

    // Empty-state card replaces the rack list when there's no rack yet.
    // In read-only (friend view) we hide the "+ Create rack" CTA — the user
    // can't create racks for someone else's account.
    const emptyHTML = !state.racks.length
      ? `<div class="rp-empty">
          <img class="rp-empty-img" src="../assets/img/Panda_Feed_Rack.png" alt="" />
          <div class="rp-empty-sub">${t(readOnly ? "racksEmptyFriendSub" : "racksEmptySub")}</div>
          ${readOnly ? "" : `<button class="rp-cta rp-empty-cta" id="btnNewRackEmpty">
            <span class="icon icon-plus icon-14"></span>
            <span data-i18n="rackNew">${t("rackNew")}</span>
          </button>`}
        </div>`
      : "";

    const racksHTML = state.racks.map(r => {
      const rows = [];
      // Coordinate system: bottom shelf = "A" (going up to B, C, …), slots
      // numbered 1..N from left. A slot is referenced as "B3" = shelf B, slot 3.
      const shelfLetter = (lv) => String.fromCharCode(65 + lv);
      // Column header: 1 2 3 … N (font mono, muted, small)
      const colHeaderCells = [];
      for (let pos = 0; pos < r.position; pos++) {
        colHeaderCells.push(`<span class="rp-col-label">${pos + 1}</span>`);
      }
      rows.push(`<div class="rp-row rp-row--header"><span class="rp-row-label"></span><div class="rp-row-slots" style="--slots:${r.position}">${colHeaderCells.join("")}</div></div>`);
      // Render top shelf first (level r.level-1 at top, level 0 at bottom — physical layout)
      for (let lv = r.level - 1; lv >= 0; lv--) {
        const cells = [];
        for (let pos = 0; pos < r.position; pos++) {
          const occ    = findSpoolInSlot(r.id, lv, pos);
          const locked = isSlotLocked(r.id, lv, pos);
          const lockCls = locked ? " rp-slot--locked" : "";
          const coord = `${shelfLetter(lv)}${pos + 1}`;
          if (occ) {
            // Bounce-in marker if this spool was just placed (drop / auto-fill).
            // The class is consumed once and stripped after the animation.
            const justPlaced = _justPlacedSpools.has(occ.spoolId) || _justFilledSlots.has(`${r.id}|${lv}|${pos}`);
            const bounceCls = justPlaced ? " rp-slot--just-placed" : "";
            // No native title — the rich custom tooltip (#rackHoverTip) handles
            // the on-hover info bubble. draggable=false on locked filled slots.
            cells.push(`<div class="rp-slot rp-slot--filled${lockCls}${bounceCls}" draggable="${(readOnly || locked) ? "false" : "true"}"
                              data-rack="${esc(r.id)}" data-level="${lv}" data-pos="${pos}"
                              data-spool-id="${esc(occ.spoolId)}"
                              data-coord="${coord}">${slotFillInnerHTML(occ)}</div>`);
          } else {
            const tip = locked ? `[${coord}] 🔒 ${t("rackLockedTip")}` : `[${coord}]`;
            cells.push(`<div class="rp-slot${lockCls}" data-rack="${esc(r.id)}" data-level="${lv}" data-pos="${pos}" title="${tip}" data-coord="${coord}"></div>`);
          }
        }
        rows.push(`<div class="rp-row"><span class="rp-row-label">${shelfLetter(lv)}</span><div class="rp-row-slots" style="--slots:${r.position}">${cells.join("")}</div></div>`);
      }
      const totalSlots = r.level * r.position;
      const filled     = state.rows.filter(x => !x.deleted && x.rackId === r.id).length;
      const lockedCnt  = Array.isArray(r.lockedSlots) ? r.lockedSlots.length : 0;
      const allLocked  = lockedCnt > 0 && lockedCnt === totalSlots;
      return `<div class="rp-rack" data-rack-id="${esc(r.id)}">
        <div class="rp-rack-head">
          ${readOnly ? "" : `<span class="rp-rack-grip" title="Drag to reorder" draggable="true" data-rack-drag-id="${esc(r.id)}">⋮⋮</span>`}
          <div class="rp-rack-info">
            <div class="rp-rack-name">
              <span class="rp-rack-name-text">${esc(r.name)}</span>
              <span class="rp-rack-count">·</span>
              <span class="rp-rack-count-num">${filled}/${totalSlots}</span>
            </div>
          </div>
          ${readOnly ? "" : `<div class="rp-rack-actions">
            <button class="rp-rack-btn rp-rack-kebab" data-action="kebab" title="${esc(t("rackActionMore"))}" aria-label="${esc(t("rackActionMore"))}" aria-haspopup="menu" aria-expanded="false"><span class="icon icon-kebab icon-18"></span></button>
            <div class="rp-menu" data-menu-for="${esc(r.id)}" hidden>
              <button class="rp-menu-item" data-action="edit"><span class="icon icon-edit icon-14"></span><span>${esc(t("rackActionEdit"))}</span></button>
              <button class="rp-menu-item" data-action="autofill"><span class="icon icon-sparkle icon-14"></span><span>${esc(t("rackActionAutofill"))}</span></button>
              <button class="rp-menu-item" data-action="${allLocked ? "unlockall" : "lockall"}"><span class="icon icon-lock icon-14"></span><span>${esc(allLocked ? t("rackActionUnlockAll") : t("rackActionLockAll"))}</span></button>
              <button class="rp-menu-item rp-menu-item--hold" data-action="empty"><span class="hold-progress hold-progress--primary"></span><span class="icon icon-broom icon-14"></span><span class="rp-menu-label">${esc(t("rackActionEmpty"))}</span></button>
              <div class="rp-menu-sep"></div>
              <button class="rp-menu-item rp-menu-item--danger rp-menu-item--hold" data-action="delete"><span class="hold-progress"></span><span class="icon icon-trash icon-14"></span><span class="rp-menu-label">${esc(t("rackActionDelete"))}</span></button>
            </div>
          </div>`}
        </div>
        <div class="rp-frame">
          <div class="rp-grid">${rows.join("")}</div>
        </div>
      </div>`;
    }).join("");

    // The unranked panel is now a slide-in (fixed positioning), opened on
    // demand via the "not stored" tile in the stats bar. The DOM stays inside
    // #invRackView so the existing drag/drop selectors keep working.
    html += `
      <div class="rp-racks-col">${racksHTML || emptyHTML}</div>
      <aside class="rp-side${panelOpenInit ? " is-open" : ""}" id="rpUnranked">
        <div class="rp-side-head">
          <span class="rp-side-count">${unranked.filter(r => !isEmptyRow(r)).length}</span>
          <span class="rp-side-title">${t("rackUnrackedTitle")}</span>
          <button class="rp-side-close" id="rpUnrackedClose" title="Hide panel" aria-label="Close">✕</button>
        </div>
        ${readOnly ? "" : `
        <!-- Auto Storage / Auto Unstorage toggles. They live together in
             a single "Automation" card so the user sees the two opposing
             policies side-by-side.
             - Auto Storage    → place new unranked spools in the first free slot
             - Auto Unstorage  → free the rack slot when a spool reaches 0g
                                  (data is kept; the spool just returns to the
                                   "Spools not stored" pile, never deleted) -->
        <div class="rp-side-auto-card">
          <label class="rp-side-toggle">
            <span class="rp-side-toggle-text">
              <span class="rp-side-toggle-title" data-i18n="autoStorageTitle">Auto storage</span>
              <span class="rp-side-toggle-sub" data-i18n="autoStorageSub">Place new spools automatically</span>
            </span>
            <span class="eac-toggle">
              <input type="checkbox" id="rpAutoStorageToggle" />
              <span class="eac-toggle-track"><span class="eac-toggle-thumb"></span></span>
            </span>
          </label>
          <label class="rp-side-toggle">
            <span class="rp-side-toggle-text">
              <span class="rp-side-toggle-title" data-i18n="autoUnstorageTitle">Auto unstorage</span>
              <span class="rp-side-toggle-sub" data-i18n="autoUnstorageSub">Free the rack slot when a spool reaches 0g</span>
            </span>
            <span class="eac-toggle">
              <input type="checkbox" id="rpAutoUnstorageToggle" />
              <span class="eac-toggle-track"><span class="eac-toggle-thumb"></span></span>
            </span>
          </label>
        </div>`}
        <div class="rp-side-search">
          <input id="rpUnrackedSearch" type="text" placeholder="${t("searchShort")}" />
          <span class="icon icon-search icon-13"></span>
        </div>
        <div class="rp-side-list" id="rpUnrackedStrip">${sideRows}</div>
      </aside>`;

    list.innerHTML = html;

    // ── Run the masonry packing AFTER the DOM is in place. requestAnimationFrame
    // gives the browser a frame to compute natural dimensions, then we measure
    // and absolutely-position each rack at its skyline-best position.
    // Also (re)wire a ResizeObserver so panel toggles / viewport tweaks reflow.
    requestAnimationFrame(() => {
      layoutRacksMasonry();
      const target = document.querySelector("#invRackView .rp-racks-col");
      if (target && typeof ResizeObserver !== "undefined") {
        if (_masonryRO) _masonryRO.disconnect();
        // Only react to WIDTH changes — height changes are caused by US
        // setting container.style.height, which would loop.
        _masonryRO = new ResizeObserver(entries => {
          const w = Math.round(entries[0]?.contentRect?.width || 0);
          if (w && Math.abs(w - _masonryLastWidth) > 1) {
            _masonryLastWidth = w;
            scheduleMasonryRelayout();
          }
        });
        _masonryRO.observe(target);
        _masonryLastWidth = Math.round(target.clientWidth);
      }
    });

    // ── Staggered bounce-in for newly placed slots
    // For drag-drop: 1 slot pops in ~immediately (220ms anim).
    // For auto-fill: many slots pop in with a 30ms inter-slot delay so the
    // rack visibly fills "left to right, top to bottom" in waves.
    const justPlaced = list.querySelectorAll(".rp-slot--just-placed");
    if (justPlaced.length) {
      // Sort by visual order (rack order, then top→bottom, then left→right)
      const ordered = Array.from(justPlaced).sort((a, b) => {
        const ra = a.closest(".rp-rack"); const rb = b.closest(".rp-rack");
        if (ra !== rb) {
          // Use index in the racks col to break racks tie
          const allRacks = Array.from(list.querySelectorAll(".rp-rack"));
          return allRacks.indexOf(ra) - allRacks.indexOf(rb);
        }
        const lvA = parseInt(a.dataset.level, 10), lvB = parseInt(b.dataset.level, 10);
        if (lvA !== lvB) return lvB - lvA;   // top shelf first
        return parseInt(a.dataset.pos, 10) - parseInt(b.dataset.pos, 10);
      });
      ordered.forEach((el, i) => {
        const delay = Math.min(i * 30, 1200);   // cap so very long fills finish in reasonable time
        el.style.animationDelay = delay + "ms";
        // Strip the class once the animation has had time to run, so a
        // subsequent re-render doesn't replay the bounce.
        setTimeout(() => {
          el.classList.remove("rp-slot--just-placed");
          el.style.animationDelay = "";
        }, delay + 400);
      });
      _justPlacedSpools.clear();
      _justFilledSlots.clear();
    }

    // ── Stat-bar filter chips: clicking "empty" / "locked" / "depleted"
    // highlights all matching slots with a glow ring. Click the same chip
    // again to clear. The "unranked" tile has its own click handler (below)
    // — it toggles the side panel, so we explicitly skip it here.
    list.querySelectorAll(".rv-stat--clickable").forEach(tile => {
      if (tile.id === "btnToggleUnranked") return;
      tile.addEventListener("click", () => {
        const kind = tile.dataset.stat;   // "empty" | "locked" | "depleted"
        const wasActive = tile.classList.contains("rv-stat--active");
        // Reset all chips + clear all glow rings (but don't touch the
        // "unranked" tile's active state — its semantics differ).
        list.querySelectorAll(".rv-stat--active:not(#btnToggleUnranked)")
          .forEach(t => t.classList.remove("rv-stat--active"));
        list.querySelectorAll(".rp-slot--highlight").forEach(s => s.classList.remove("rp-slot--highlight"));
        if (wasActive) return;
        tile.classList.add("rv-stat--active");
        if (kind === "empty") {
          list.querySelectorAll(".rp-slot:not(.rp-slot--filled):not(.rp-slot--locked)")
            .forEach(s => s.classList.add("rp-slot--highlight"));
        } else if (kind === "locked") {
          list.querySelectorAll(".rp-slot--locked").forEach(s => s.classList.add("rp-slot--highlight"));
        } else if (kind === "depleted") {
          // Highlight every filled slot whose underlying spool is depleted
          // (weightAvailable <= 0). Lookup is by spoolId on the slot DOM.
          list.querySelectorAll(".rp-slot--filled").forEach(s => {
            const sid = s.dataset.spoolId;
            const row = sid ? state.rows.find(r => r.spoolId === sid) : null;
            if (row && row.weightAvailable != null && Number(row.weightAvailable) <= 0) {
              s.classList.add("rp-slot--highlight");
            }
          });
        }
      });
    });

    // If we just entered Storage mode with unranked spools, animate the side
    // panel sliding in (otherwise it would already be at translateX(0) on the
    // first paint — no transition). Render with .is-open OFF, then add it on
    // the next frame so the CSS transition fires.
    if (_unrackedAnimateOpen) {
      _unrackedAnimateOpen = false;
      const aside = $("rpUnranked");
      if (aside) {
        aside.classList.remove("is-open");
        // Two rAFs: first paints the closed state, second triggers the open.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => aside.classList.add("is-open"));
        });
      }
    }

    // ── Wire rack head kebab → opens contextual menu
    list.querySelectorAll(".rp-rack-kebab").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const card = btn.closest("[data-rack-id]");
        if (!card) return;
        const menu = card.querySelector(".rp-menu");
        if (!menu) return;
        const isOpen = !menu.hidden;
        // Close any other open menus first
        document.querySelectorAll(".rp-menu").forEach(m => { m.hidden = true; });
        document.querySelectorAll(".rp-rack-kebab[aria-expanded='true']").forEach(b => b.setAttribute("aria-expanded", "false"));
        if (isOpen) return;
        menu.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        // Position the menu — anchor to the kebab button. Use fixed positioning
        // so the menu can escape rack overflow. Compute on open and on resize.
        positionRackMenu(menu, btn);
      });
    });
    // Click-away → close any open kebab menu
    if (!list._kebabOutsideWired) {
      list._kebabOutsideWired = true;
      document.addEventListener("click", e => {
        if (e.target.closest(".rp-menu")) return;
        if (e.target.closest(".rp-rack-kebab")) return;
        document.querySelectorAll(".rp-menu").forEach(m => { m.hidden = true; });
        document.querySelectorAll(".rp-rack-kebab[aria-expanded='true']").forEach(b => b.setAttribute("aria-expanded", "false"));
      });
    }
    // Wire all menu items. Two flavours:
    //   • Regular click → action runs immediately (Edit, Auto-fill, Lock all)
    //   • Hold-to-confirm (.rp-menu-item--hold) → action only runs after a 1.2s
    //     press, with a fill animation. Used for irreversible / destructive
    //     actions (Clear all, Delete) so a misclick can't wipe the rack.
    list.querySelectorAll(".rp-menu-item").forEach(btn => {
      const card = btn.closest("[data-rack-id]");
      if (!card) return;
      const rackId = card.dataset.rackId;
      const action = btn.dataset.action;
      const closeMenu = () => {
        const menu = card.querySelector(".rp-menu");
        if (menu) menu.hidden = true;
        const kebab = card.querySelector(".rp-rack-kebab");
        if (kebab) kebab.setAttribute("aria-expanded", "false");
      };
      const runAction = async () => {
        const rack = state.racks.find(r => r.id === rackId);
        if (!rack) return;
        try {
          if (action === "edit")           openRackEditModal(rack);
          else if (action === "delete")    await deleteRack(rack.id);
          else if (action === "autofill")  await autoFillEmptySlots(rack.id);
          else if (action === "lockall")   await lockAllSlots(rack.id);
          else if (action === "unlockall") await unlockAllSlots(rack.id);
          else if (action === "empty")     await emptyRack(rack.id);
        } catch (err) { reportError("rack.menu." + action, err); }
      };
      if (btn.classList.contains("rp-menu-item--hold")) {
        // Hold-to-confirm: 1.2s press. Click without hold = no-op (the click
        // event still fires after pointerup, but the timer was cancelled).
        // We swallow the regular click to avoid triggering the action.
        btn.addEventListener("click", e => { e.stopPropagation(); e.preventDefault(); });
        setupHoldToConfirm(btn, 1200, () => {
          closeMenu();
          runAction();
        });
      } else {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          closeMenu();
          runAction();
        });
      }
    });

    // ── Live search — re-renders unranked sidebar AND dims non-matching rack slots
    const search = $("rpUnrackedSearch");
    if (search) {
      search.addEventListener("input", () => {
        const strip = $("rpUnrackedStrip");
        const cnt   = $("rpUnranked")?.querySelector(".rp-side-count");
        if (!strip) return;
        const filtered = getUnrackedSpools();
        // Both counters exclude empty spools — they're visible in the
        // list but shouldn't be tallied (consumed spools don't count
        // as "to be stored"). Keep the rendered list at full length.
        const activeCount = filtered.filter(r => !isEmptyRow(r)).length;
        if (cnt) cnt.textContent = activeCount;
        const tileNum = $("btnToggleUnranked")?.querySelector(".rv-stat-num");
        if (tileNum) tileNum.textContent = activeCount;
        strip.innerHTML = filtered.map(unrackedRowHTML).join("")
                       || `<div class="rp-unranked-empty">${t("noMatch")}</div>`;
        wireDragSources();
        // Re-wire click for newly rendered side rows
        strip.querySelectorAll(".rp-side-row").forEach(el => {
          el.addEventListener("click", () => {
            if (el._wasDragged) { el._wasDragged = false; return; }
            const sid = el.dataset.spoolId; if (sid) openDetail(sid);
          });
        });
      });
    }
    // Apply dim from the main search bar at every rack-view render
    applyRackSearchDim();

    // ── Click on a filled slot or unranked row → open the spool detail panel
    list.querySelectorAll(".rp-slot--filled, .rp-side-row").forEach(el => {
      el.addEventListener("click", e => {
        // Avoid firing if it was a drag (drag fires its own events)
        if (el._wasDragged) { el._wasDragged = false; return; }
        const sid = el.dataset.spoolId;
        if (!sid) return;
        openDetail(sid);
      });
    });

    // ── "+ Rack" buttons (after rack list + empty-state CTA when no rack yet)
    $("btnNewRackTile")?.addEventListener("click", () => openRackEditModal(null));
    $("btnNewRackEmpty")?.addEventListener("click", () => openRackEditModal(null));

    // ── Drag-and-drop to reorder racks (grip handle on the rack head)
    list.querySelectorAll(".rp-rack-grip").forEach(grip => {
      grip.addEventListener("dragstart", e => {
        const rackId = grip.dataset.rackDragId;
        if (!rackId) { e.preventDefault(); return; }
        e.dataTransfer.setData("application/x-rack-id", rackId);
        e.dataTransfer.effectAllowed = "move";
        _draggingRackId = rackId;
        grip.closest(".rp-rack")?.classList.add("rp-rack--dragging");
      });
      grip.addEventListener("dragend", () => {
        grip.closest(".rp-rack")?.classList.remove("rp-rack--dragging");
        _draggingRackId = null;
        document.querySelectorAll(".rp-rack--drop-before, .rp-rack--drop-after").forEach(el => {
          el.classList.remove("rp-rack--drop-before", "rp-rack--drop-after");
        });
      });
    });
    list.querySelectorAll(".rp-rack").forEach(card => {
      card.addEventListener("dragover", e => {
        if (!_draggingRackId) return;
        if (_draggingRackId === card.dataset.rackId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        card.classList.toggle("rp-rack--drop-before", before);
        card.classList.toggle("rp-rack--drop-after", !before);
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("rp-rack--drop-before", "rp-rack--drop-after");
      });
      card.addEventListener("drop", async e => {
        if (!_draggingRackId) return;
        e.preventDefault();
        const targetId = card.dataset.rackId;
        const before = card.classList.contains("rp-rack--drop-before");
        card.classList.remove("rp-rack--drop-before", "rp-rack--drop-after");
        if (_draggingRackId === targetId) return;
        const srcId = _draggingRackId;
        _draggingRackId = null;
        try { await reorderRacks(srcId, targetId, before); }
        catch (err) { reportError("rack.reorder", err); }
      });
    });

    // Toggle unranked panel (slide in/out from the right, NO backdrop overlay).
    // The trigger is the "not stored" tile in the stats bar (rv-stat--toggle).
    // We sync its aria-pressed + .rv-stat--active state so the tile reads as
    // selected while the panel is open.
    function setUnrackedOpen(open) {
      const aside = $("rpUnranked");
      if (aside) aside.classList.toggle("is-open", open);
      const tile = $("btnToggleUnranked");
      if (tile) {
        tile.classList.toggle("rv-stat--active", open);
        tile.setAttribute("aria-pressed", open ? "true" : "false");
      }
      localStorage.setItem("tigertag.unrackedPanelOpen", open ? "true" : "false");
    }
    $("btnToggleUnranked")?.addEventListener("click", () => {
      const aside = $("rpUnranked");
      const open = !aside?.classList.contains("is-open");
      setUnrackedOpen(open);
    });
    // The toggle is a <div role=button> — wire keyboard activation manually
    // (Enter / Space) so it stays accessible without a real <button> element.
    $("btnToggleUnranked")?.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.target.click();
      }
    });
    $("rpUnrackedClose")?.addEventListener("click", () => setUnrackedOpen(false));

    // Auto-storage toggle inside the side panel — persisted in localStorage.
    // When flipped ON, fire the auto-fill routine immediately to clear the
    // current pile, then let `maybeAutoStoreUnrankedSpools()` handle future
    // snapshots automatically.
    const _autoStoreToggle = $("rpAutoStorageToggle");
    if (_autoStoreToggle) {
      _autoStoreToggle.checked = localStorage.getItem("tigertag.autoStorage.enabled") === "true";
      _autoStoreToggle.addEventListener("change", () => {
        const enabled = _autoStoreToggle.checked;
        localStorage.setItem("tigertag.autoStorage.enabled", enabled ? "true" : "false");
        if (enabled) maybeAutoStoreUnrankedSpools();
      });
    }
    // Auto-unstorage toggle — same pattern, triggers a one-shot pass on flip
    // so any spool currently at 0g leaves its rack immediately.
    const _autoUnstoreToggle = $("rpAutoUnstorageToggle");
    if (_autoUnstoreToggle) {
      _autoUnstoreToggle.checked = localStorage.getItem("tigertag.autoUnstorage.enabled") === "true";
      _autoUnstoreToggle.addEventListener("change", () => {
        const enabled = _autoUnstoreToggle.checked;
        localStorage.setItem("tigertag.autoUnstorage.enabled", enabled ? "true" : "false");
        if (enabled) maybeAutoUnstoreDepletedSpools();
      });
    }

    // ── Right-click on a slot → toggle its lock state (skipped in read-only)
    if (!readOnly) {
      list.querySelectorAll(".rp-slot").forEach(slot => {
        slot.addEventListener("contextmenu", async e => {
          e.preventDefault();
          const rackId = slot.dataset.rack;
          const lv     = parseInt(slot.dataset.level, 10);
          const pos    = parseInt(slot.dataset.pos, 10);
          if (!rackId || isNaN(lv) || isNaN(pos)) return;
          try { await toggleSlotLock(rackId, lv, pos); }
          catch (err) { reportError("rack.toggleLock", err); }
        });
      });
    }

    // ── Drag-and-drop wiring (skipped entirely in read-only)
    if (!readOnly) {
      wireDragSources();
      wireDropTargets();
    }
  }

  function wireDragSources() {
    document.querySelectorAll("#invRackView .rp-side-row, #invRackView .rp-chip, #invRackView .rp-slot--filled").forEach(el => {
      el.addEventListener("dragstart", e => {
        const sid = el.dataset.spoolId;
        if (!sid) { e.preventDefault(); return; }
        // Block drag-out from a locked filled slot
        const rackId = el.dataset.rack;
        if (rackId) {
          const lv  = parseInt(el.dataset.level, 10);
          const pos = parseInt(el.dataset.pos, 10);
          if (isSlotLocked(rackId, lv, pos)) { e.preventDefault(); return; }
        }
        e.dataTransfer.setData("text/plain", sid);
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("rp-dragging");
        el._wasDragged = true;
        // Globally signal "spool drag in progress" so the rack view can light
        // up valid drop targets, dim locked slots, and reveal coordinates to
        // help the user aim. Cleared on dragend.
        document.body.classList.add("is-dragging-spool");
        // Hide any visible hover tooltip so it doesn't fight the drop ring
        hideRackTooltip();
        // Hide the unranked side panel while dragging FROM it, so the racks
        // behind it become accessible as drop targets. Persistent open/close
        // state is left untouched — the panel slides back in on dragend.
        if (el.classList.contains("rp-side-row")) {
          $("rpUnranked")?.classList.add("is-dragging");
        }
        // Reset the click-suppression flag shortly after the drag completes
        setTimeout(() => { el._wasDragged = false; }, 400);
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("rp-dragging");
        document.body.classList.remove("is-dragging-spool");
        // Wipe any leftover drop-target highlight (e.g. user released outside
        // a slot, or dragleave didn't fire for some reason).
        document.querySelectorAll("#invRackView .rp-slot--drop, #invRackView .rp-slot--drop-deny").forEach(s => {
          s.classList.remove("rp-slot--drop");
          s.classList.remove("rp-slot--drop-deny");
        });
        // Only set the settle window if we dragged FROM the side panel — the
        // panel needs ~300ms to slide back in, and we mustn't let the Firestore
        // snapshot rebuild the DOM mid-animation. For inter-rack drags the
        // panel is untouched, so we don't want to delay the visual update.
        if (el.classList.contains("rp-side-row")) {
          $("rpUnranked")?.classList.remove("is-dragging");
          _unrackedSettleUntil = Date.now() + 320;
        }
      });
    });
  }

  // Helper: clear the "active drop target" highlight from every slot except
  // the one we're keeping. Prevents two slots being highlighted simultaneously
  // (which can happen because dragleave fires AFTER dragenter on the next slot,
  // and especially because we scale-up the active slot — so the cursor can be
  // briefly inside two overlapping slots at once).
  function clearOtherDropHighlights(keepSlot) {
    document.querySelectorAll("#invRackView .rp-slot--drop, #invRackView .rp-slot--drop-deny").forEach(s => {
      if (s !== keepSlot) {
        s.classList.remove("rp-slot--drop");
        s.classList.remove("rp-slot--drop-deny");
      }
    });
  }
  function wireDropTargets() {
    // Slots accept drops (filled = swap, empty = place). Locked slots reject all drops.
    document.querySelectorAll("#invRackView .rp-slot").forEach(slot => {
      // dragenter is the moment the cursor first crosses into the slot —
      // perfect place to flip the highlight ON and clear any stale highlight
      // on a previously-hovered slot.
      slot.addEventListener("dragenter", e => {
        const rackId = slot.dataset.rack;
        const lv  = parseInt(slot.dataset.level, 10);
        const pos = parseInt(slot.dataset.pos, 10);
        clearOtherDropHighlights(slot);
        if (isSlotLocked(rackId, lv, pos)) {
          slot.classList.remove("rp-slot--drop");
          slot.classList.add("rp-slot--drop-deny");
        } else {
          slot.classList.remove("rp-slot--drop-deny");
          slot.classList.add("rp-slot--drop");
        }
      });
      slot.addEventListener("dragover", e => {
        const rackId = slot.dataset.rack;
        const lv  = parseInt(slot.dataset.level, 10);
        const pos = parseInt(slot.dataset.pos, 10);
        if (isSlotLocked(rackId, lv, pos)) {
          e.dataTransfer.dropEffect = "none";
          // Keep dragenter's class set; don't toggle on every dragover frame
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Make sure this slot still has the highlight (in case dragenter
        // got skipped, e.g. when the drag started on this very slot).
        if (!slot.classList.contains("rp-slot--drop")) {
          clearOtherDropHighlights(slot);
          slot.classList.add("rp-slot--drop");
        }
      });
      slot.addEventListener("dragleave", e => {
        // Ignore spurious leaves caused by entering child elements (.rp-fill)
        // or when the cursor moves from the slot to its scaled-up portion.
        // relatedTarget is the element being entered — if it's still inside
        // the slot, we ignore the leave.
        if (e.relatedTarget && slot.contains(e.relatedTarget)) return;
        slot.classList.remove("rp-slot--drop");
        slot.classList.remove("rp-slot--drop-deny");
      });
      slot.addEventListener("drop", async e => {
        e.preventDefault();
        // Stop the event from bubbling up to the rack-view's "drop in
        // empty space → unassign" fallback. Without this, a drop on a
        // slot would assign AND immediately unassign.
        e.stopPropagation();
        slot.classList.remove("rp-slot--drop");
        slot.classList.remove("rp-slot--drop-deny");
        const sid = e.dataTransfer.getData("text/plain");
        if (!sid) return;
        const rackId = slot.dataset.rack;
        const level  = parseInt(slot.dataset.level, 10);
        const pos    = parseInt(slot.dataset.pos, 10);
        if (isSlotLocked(rackId, level, pos)) return;   // locked target rejects
        try { await assignSpoolToSlot(sid, rackId, level, pos); }
        catch (err) { console.warn("[assignSpoolToSlot]", err.message); }
      });
    });

    // The unranked strip also accepts drops (= unassign)
    const strip = $("rpUnrackedStrip");
    if (strip) {
      strip.addEventListener("dragover", e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        strip.classList.add("rp-unranked-strip--drop");
      });
      strip.addEventListener("dragleave", () => strip.classList.remove("rp-unranked-strip--drop"));
      strip.addEventListener("drop", async e => {
        e.preventDefault();
        // Stop propagation so the rack-view fallback (below) doesn't ALSO
        // try to unassign the same spool a second time.
        e.stopPropagation();
        strip.classList.remove("rp-unranked-strip--drop");
        const sid = e.dataTransfer.getData("text/plain");
        if (!sid) return;
        try { await unassignSpool(sid); }
        catch (err) { console.warn("[unassignSpool]", err.message); }
      });
    }

    // ── Drop in TRUE empty space → unassign ───────────────────────────
    // The cursor must be OUTSIDE every rack card (not just outside a
    // slot). Dropping on rack padding / title / between slots inside
    // the same rack does NOT unassign — that prevents accidental
    // dismissal when the user lifts the spool a few pixels and drops
    // it back without crossing into another rack.
    //
    // Rule of thumb: if `closest(".rp-rack")` is null, we're in the
    // void. Same logic for the unranked strip and sidebar rows (still
    // skipped since those have their own handlers).
    const view = $("invRackView");
    if (view) {
      const isVoidTarget = (target) => {
        if (!target) return false;
        // Don't override when the cursor is over a real drop target.
        if (target.closest(".rp-slot, #rpUnrackedStrip, .rp-side-row")) return false;
        // The cursor must be outside ALL rack cards. If the user is
        // hovering rack padding / title bar / inter-slot gap — that's
        // INSIDE a rack and should NOT unassign.
        if (target.closest(".rp-rack")) return false;
        return true;
      };
      view.addEventListener("dragover", e => {
        if (!document.body.classList.contains("is-dragging-spool")) return;
        if (!isVoidTarget(e.target)) {
          // Drop the highlight if we just left the void into a rack.
          view.classList.remove("rp-view--drop-void");
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        view.classList.add("rp-view--drop-void");
      });
      view.addEventListener("dragleave", e => {
        if (e.relatedTarget && view.contains(e.relatedTarget)) return;
        view.classList.remove("rp-view--drop-void");
      });
      view.addEventListener("drop", async e => {
        view.classList.remove("rp-view--drop-void");
        // Only fire on a TRUE void — closest(".rp-rack") must be null.
        if (!isVoidTarget(e.target)) return;
        e.preventDefault();
        const sid = e.dataTransfer.getData("text/plain");
        if (!sid) return;
        const row = state.rows.find(r => r.spoolId === sid);
        if (!row || !row.rackId) return; // already unranked → no-op
        // Visual confirmation BEFORE the Firestore round-trip — so the
        // user sees their action register instantly even on slow links.
        // The animation is a ghost copy of the source slot that flies
        // toward the unranked panel and fades out, while the unranked
        // panel pulses briefly to signal "the spool just landed here".
        playUnrankAnimation(row).catch(() => {});
        try { await unassignSpool(sid); }
        catch (err) { console.warn("[unassignSpool void-drop]", err.message); }
      });
    }
  }

  // Animate a single spool leaving the rack via void-drop.
  // Reuses the existing `rp-slot--cascade-out` keyframe (the same one
  // playEmptyRackCascade fires on every slot when emptying a full
  // rack), so a single eject reads visually as "one slice of the
  // empty-rack animation". We also flag the spool with
  // `_justPlacedSpools` so it gets the bounce-in landing animation in
  // the unranked sidebar once the Firestore listener rebuilds.
  function playUnrankAnimation(row) {
    return new Promise(resolve => {
      if (!row || !row.rackId) { resolve(); return; }
      const sourceSlot = document.querySelector(
        `#invRackView .rp-slot[data-rack="${CSS.escape(row.rackId)}"][data-level="${row.rackLevel}"][data-pos="${row.rackPos}"]`
      );
      // Tag the spool so the next render bounces it in at its new home.
      // Same mechanism that auto-fill / auto-store use for landed spools.
      _justPlacedSpools.add(row.spoolId);
      if (!sourceSlot) { resolve(); return; }
      sourceSlot.classList.add("rp-slot--cascade-out");
      // 280 ms matches the keyframe duration; we resolve a hair later
      // so the slot has fully faded before Firestore rebuilds the row.
      setTimeout(resolve, 300);
    });
  }

  // (Old openRacks() removed — view switching is now handled by setViewMode("rack").
  //  Kept for callers from earlier code paths that might still reference it.)

  /* ── Rack create/edit modal ── */
  let _editingRackId = null;
  function openRackEditModal(rack) {
    _editingRackId = rack?.id || null;
    $("recTitle").textContent = rack ? t("rackEdit") : t("rackNew");
    // Default name for a new rack — "Rack N" where N = next index in the list
    const defaultName = `Rack ${(state.racks?.length || 0) + 1}`;
    $("rackNameInput").value = rack?.name ?? defaultName;
    $("rackLevelInput").value = rack?.level || 5;
    $("rackPositionInput").value = rack?.position || 8;
    $("rackEditResult").textContent = "";
    // Reset any leftover field-level error bubbles from a previous open
    document.querySelectorAll("#rackEditOverlay .rec-field.is-invalid").forEach(f => {
      f.classList.remove("is-invalid");
      f.querySelector(".rec-field-err")?.remove();
    });
    // Save button label depends on mode: edit → "Save", new → "Create".
    // We update only the inner .label span so the .spinner sibling stays intact.
    const saveBtn = $("rackEditSave");
    const saveLabel = saveBtn?.querySelector(".label");
    if (saveLabel) saveLabel.textContent = rack ? t("rackSave") : t("rackCreate");
    if (saveBtn) saveBtn.classList.remove("loading");   // reset any leftover state
    // Delete + Empty buttons only visible in edit mode.
    // Cancel button removed — the ✕ in the corner is the only way to dismiss.
    const delBtn = $("rackEditDelete");
    if (delBtn) delBtn.classList.toggle("hidden", !rack);
    const emptyBtn = $("rackEditEmpty");
    if (emptyBtn) emptyBtn.classList.toggle("hidden", !rack);
    renderRackPresets();
    updateRackTotalLabel();
    $("rackEditOverlay").classList.add("open");
    setTimeout(() => $("rackNameInput").focus(), 80);
  }
  function closeRackEditModal() {
    $("rackEditOverlay").classList.remove("open");
    _editingRackId = null;
  }

  function renderRackPresets() {
    const el = $("recPresets");
    if (!el) return;
    const currentLevel = parseInt($("rackLevelInput").value, 10);
    const currentPos   = parseInt($("rackPositionInput").value, 10);
    const presets = state.rackPresets || [];
    const presetMatches = presets.find(p => p.level === currentLevel && p.position === currentPos);
    const isCustom = !presetMatches;
    const IMG = "../assets/img/Panda_Feed_Rack.png";

    // Two-column layout: a single big Panda image on the left,
    // the 4 preset buttons stacked vertically on the right.
    const slotsLabel = t("rackSlots") || "slots";
    const imgFor = p => `../assets/img/${p?.image || "Panda_Feed_Rack.png"}`;
    // The big image on the left reflects the currently active preset.
    // Custom (no match) → generic Panda_Feed_Rack.png
    const activeImg = presetMatches ? imgFor(presetMatches) : IMG;

    let rows = presets.map(p => {
      const matches = p === presetMatches;
      const total = p.level * p.position;
      return `<button class="rec-preset${matches ? " rec-preset--active" : ""}" data-preset-id="${esc(p.id)}">
        <span class="rec-preset-name">${esc(p.name)}</span>
        <span class="rec-preset-dim">${p.level} × ${p.position} · <strong>${total}</strong> ${esc(slotsLabel)}</span>
      </button>`;
    }).join("");
    const customTotal = (Number.isFinite(currentLevel) && Number.isFinite(currentPos))
      ? currentLevel * currentPos : 0;
    rows += `<button class="rec-preset rec-preset--custom${isCustom ? " rec-preset--active" : ""}" data-preset-id="__custom__">
      <span class="rec-preset-name">${esc(t("rackPresetCustom"))}</span>
      <span class="rec-preset-dim">${isCustom ? `${currentLevel} × ${currentPos} · <strong>${customTotal}</strong> ${esc(slotsLabel)}` : "—"}</span>
    </button>`;

    el.innerHTML = `
      <div class="rec-presets-grid">
        <img class="rec-presets-img" id="recPresetsImg" src="${activeImg}" alt="" />
        <div class="rec-presets-list">${rows}</div>
      </div>`;
    el.querySelectorAll("[data-preset-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.presetId;
        // Custom is non-mutating — just mark it active visually; the user
        // adjusts the level / position inputs manually below.
        if (id === "__custom__") {
          $("rackLevelInput").focus();
          return;
        }
        const p = presets.find(x => x.id === id);
        if (!p) return;
        // Only update dimensions — never overwrite the name (per user spec)
        $("rackLevelInput").value = p.level;
        $("rackPositionInput").value = p.position;
        renderRackPresets();
        updateRackTotalLabel();   // setting .value programmatically doesn't fire 'input' — refresh manually
      });
    });
  }

  function confirmDeleteRack(rack) {
    const msg = t("rackDeleteConfirm", { name: rack.name });
    if (!confirm(msg)) return;
    deleteRack(rack.id).catch(e => console.warn("[deleteRack]", e.message));
  }

  // Sidebar "Storage" button still routes to the rack view in the main panel.
  // (btnNewRack is rendered dynamically inside the rack view header — wired in renderRackView.)
  $("btnOpenRacks")?.addEventListener("click", () => setViewMode("rack"));
  $("rackEditClose")?.addEventListener("click", closeRackEditModal);
  // Hold-to-confirm wiring — 1.5s press-and-hold replaces the confirm() dialog.
  // Prevents accidental clicks; shows a fill animation as the user holds.
  setupHoldToConfirm($("rackEditDelete"), 1500, () => {
    if (!_editingRackId) return;
    deleteRack(_editingRackId)
      .then(() => closeRackEditModal())
      .catch(e => { reportError("rack.delete", e); $("rackEditResult").textContent = "⚠ " + (e.message || t("networkError")); });
  });
  // Hold-to-confirm Clear all — same 1.5s press-and-hold pattern as Delete,
  // but uses the orange (primary) fill instead of red since the action is
  // reversible (spools just go back to Unranked, the rack stays).
  setupHoldToConfirm($("rackEditEmpty"), 1500, async () => {
    if (!_editingRackId) return;
    try {
      await emptyRack(_editingRackId);
    } catch (e) {
      reportError("rack.empty", e);
      $("rackEditResult").textContent = "⚠ " + (e.message || t("networkError"));
    }
  });
  $("rackEditOverlay")?.addEventListener("click", e => {
    if (e.target === $("rackEditOverlay")) closeRackEditModal();
  });
  function updateRackTotalLabel() {
    const lv = parseInt($("rackLevelInput")?.value, 10);
    const ps = parseInt($("rackPositionInput")?.value, 10);
    const num = $("recTotalNum");
    const lbl = $("recTotalLbl");
    if (!num || !lbl) return;
    const total = (Number.isFinite(lv) && Number.isFinite(ps) && lv > 0 && ps > 0) ? lv * ps : null;
    num.textContent = total != null ? String(total) : "—";
    lbl.textContent = t("rackSlots") || "slots";
  }
  $("rackLevelInput")?.addEventListener("input", () => { renderRackPresets(); updateRackTotalLabel(); });
  $("rackPositionInput")?.addEventListener("input", () => { renderRackPresets(); updateRackTotalLabel(); });

  // Field-level validation helpers — red border + tooltip bubble next to the field
  function setFieldError(input, msg) {
    if (!input) return;
    const field = input.closest(".rec-field");
    if (!field) return;
    field.classList.add("is-invalid");
    let bubble = field.querySelector(".rec-field-err");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "rec-field-err";
      field.appendChild(bubble);
    }
    bubble.textContent = msg;
  }
  function clearFieldError(input) {
    if (!input) return;
    const field = input.closest(".rec-field");
    if (!field) return;
    field.classList.remove("is-invalid");
    field.querySelector(".rec-field-err")?.remove();
  }
  // Auto-clear errors as soon as the user types in a field
  ["rackNameInput", "rackLevelInput", "rackPositionInput"].forEach(id => {
    $(id)?.addEventListener("input", () => clearFieldError($(id)));
  });

  $("rackEditSave")?.addEventListener("click", async () => {
    const name     = $("rackNameInput").value.trim();
    const level    = parseInt($("rackLevelInput").value, 10);
    const position = parseInt($("rackPositionInput").value, 10);
    // Clear any previous errors before re-validating
    [$("rackNameInput"), $("rackLevelInput"), $("rackPositionInput")].forEach(clearFieldError);
    let firstInvalid = null;
    if (!name) {
      setFieldError($("rackNameInput"), t("rackNameRequired"));
      firstInvalid ||= $("rackNameInput");
    }
    if (!level || level < 1 || level > 15) {
      setFieldError($("rackLevelInput"), t("rackLevelInvalid"));
      firstInvalid ||= $("rackLevelInput");
    }
    if (!position || position < 1 || position > 20) {
      setFieldError($("rackPositionInput"), t("rackPositionInvalid"));
      firstInvalid ||= $("rackPositionInput");
    }
    if (firstInvalid) { firstInvalid.focus(); return; }

    setLoading($("rackEditSave"), true);   // spinner + disabled until Firestore confirms
    try {
      if (_editingRackId) {
        await updateRack(_editingRackId, { name, level, position });
      } else {
        await createRack({ name, level, position });
      }
      closeRackEditModal();
    } catch (e) {
      // Network / Firestore failures stay in the global result line
      $("rackEditResult").textContent = "⚠ " + (e.message || t("networkError"));
    } finally {
      setLoading($("rackEditSave"), false);
    }
  });

  /* ── Friend inventory panel ──────────────────────────────────────────────── */
  function openFriendInventory(friendUid, friendName, avatarColor) {
    // Header
    const av = $("friendInvAvatar");
    if (av) {
      const initials = (friendName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      av.textContent = initials;
      av.style.background = avatarColor || "#888";
    }
    if ($("friendInvName")) $("friendInvName").textContent = friendName || friendUid;

    // Reset body
    const grid    = $("friendInvGrid");
    const loading = $("friendInvLoading");
    const sub     = $("friendInvSub");
    if (grid)    { grid.innerHTML = ""; grid.classList.add("hidden"); }
    if (loading) loading.classList.remove("hidden");
    if (sub)     sub.textContent = "";

    // Open panel
    $("friendInvPanel").classList.add("open");
    $("friendInvOverlay").classList.add("open");

    // Fetch friend's inventory (Firestore rules allow access if friendship keys match)
    fbDb().collection("users").doc(friendUid).collection("inventory").get()
      .then(snap => {
        if (loading) loading.classList.add("hidden");
        const rows = snap.docs
          .map(d => normalizeRow(d.id, d.data()))
          .filter(r => !r.deleted)
          .sort((a, b) => (a.brand + a.material + a.colorName).localeCompare(b.brand + b.material + b.colorName));
        if (sub) sub.textContent = t("loadedSpools", { n: rows.length });
        if (!rows.length) {
          grid.innerHTML = `<div class="fi-empty">${t("noMatch")}</div>`;
        } else {
          grid.innerHTML = rows.map(r => {
            const swatch = r.colors?.length
              ? `background:linear-gradient(135deg,${r.colors.slice(0,2).join(",")})` : "background:#888";
            return `<div class="fi-spool-card">
              <div class="fi-spool-swatch" style="${swatch}"></div>
              <div class="fi-spool-info">
                <div class="fi-spool-name">${esc(r.colorName || r.brand)}</div>
                <div class="fi-spool-meta">${esc(r.material)} · ${esc(r.brand)}</div>
                <div class="fi-spool-weight">${r.weightAvailable != null ? r.weightAvailable + " g" : "—"}</div>
              </div>
            </div>`;
          }).join("");
        }
        grid.classList.remove("hidden");
      })
      .catch(err => {
        if (loading) loading.classList.add("hidden");
        if (sub) sub.textContent = "⚠ " + (err.message || t("networkError"));
      });
  }

  function closeFriendInventory() {
    $("friendInvPanel").classList.remove("open");
    $("friendInvOverlay").classList.remove("open");
  }

  $("friendInvBack").addEventListener("click", closeFriendInventory);
  $("friendInvOverlay").addEventListener("click", closeFriendInventory);

  /* ── Friend view: friend inventory in main interface ────────────────────── */
  // Renders the top header chip (left of the KPI stats). Two modes:
  //
  //   • Friend view  → avatar + name + "READ-ONLY" badge (or error)
  //   • Own view     → avatar + name + random welcome greeting
  //
  // Hidden when no account is connected. Both modes share the same
  // visual frame (avatar | stacked name+sub), so the user gets the same
  // reading rhythm whether they're on their own inventory or peeking at
  // a friend's. Originally Friend-only, hence the historical name.
  function renderFriendBanner() {
    const banner = $("friendViewBanner");
    // Toggle the sidebar avatar's "swap-back" affordance — visible only
    // while we're currently viewing a friend's inventory. The avatar's
    // click handler reads the same state to decide whether to act as a
    // dropdown trigger or as a one-click "return home" button.
    $("sbUser")?.classList.toggle("sb-user--viewing-friend", !!state.friendView);
    if (!banner) return;
    banner.classList.remove("fvb--own", "fvb--error");
    // ─── Friend view ───────────────────────────────────────────────
    if (state.friendView) {
      const { displayName, avatarColor, error } = state.friendView;
      const initials = (displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      const fg = readableTextOn(avatarColor || "var(--accent)");
      banner.innerHTML = `
        <span class="fvb-avatar" style="background:${avatarColor || "var(--accent)"};color:${fg}">${esc(initials)}</span>
        <div class="fvb-inner">
          <span class="fvb-name">${esc(displayName || "—")}</span>
          ${error
            ? `<span class="fvb-badge fvb-badge--error" title="${esc(error)}">⚠ ${t("friendInvErrorBadge")}</span>`
            : `<span class="fvb-badge">${t("friendViewReadOnly")}</span>`}
        </div>`;
      banner.classList.toggle("fvb--error", !!error);
      banner.classList.remove("hidden");
      return;
    }
    // ─── Own view (signed in, not previewing a friend) ─────────────
    const acc = activeAccount();
    if (!acc) { banner.classList.add("hidden"); return; }
    const own = state.displayName || acc.displayName || acc.email || "—";
    const initials = own.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
    const grad = getAccGradient(acc);
    const fg = readableTextOn(getAccShadow(acc));
    // `t("welcomeBack")` resolves to one of the locale's random greetings
    // (the i18n helper picks a fresh one per call from the array form).
    const greeting = t("welcomeBack") || "👋 Welcome back,";
    banner.innerHTML = `
      <span class="fvb-avatar" style="background:${grad};color:${fg}">${esc(initials)}</span>
      <div class="fvb-inner">
        <span class="fvb-name">${esc(own)}</span>
        <span class="fvb-welcome">${esc(greeting)}</span>
      </div>`;
    banner.classList.add("fvb--own");
    banner.classList.remove("hidden");
  }

  // ── Friend-view auth helper ───────────────────────────────────────────
  // Strategy: ALWAYS pre-warm the Firebase Auth ID token when entering a
  // friend view, but skip the network call if the last refresh was < 30 min
  // ago (cheap throttle to avoid hitting the auth backend on every click).
  // If a read still fails with permission-denied → force-refresh and retry
  // once as a safety net.
  let _lastTokenRefresh = 0;
  const TOKEN_THROTTLE_MS = 30 * 60 * 1000;   // 30 min
  async function prewarmAuthToken(ownerUid, { force = false } = {}) {
    const user = fbAuth(ownerUid).currentUser;
    if (!user) return;
    if (!force && Date.now() - _lastTokenRefresh < TOKEN_THROTTLE_MS) return;
    try {
      await user.getIdToken(true);
      _lastTokenRefresh = Date.now();
    } catch (e) {
      console.warn("[Auth] token refresh failed:", e?.code, e?.message);
    }
  }
  // Read a Firestore collection on a friend's account. The caller is expected
  // to have called prewarmAuthToken() once before opening the friend view.
  // If a read still fails with permission-denied, we force a hard refresh
  // and retry once as a belt-and-braces safety net.
  async function readFriendCollectionWithRetry(ownerUid, friendUid, collection) {
    const ref = fbDb(ownerUid).collection("users").doc(friendUid).collection(collection);
    try {
      return await ref.get();
    } catch (e) {
      if (e?.code !== "permission-denied") throw e;
      console.log(`[FriendView] permission-denied on ${collection}, force-refreshing token and retrying…`);
      await prewarmAuthToken(ownerUid, { force: true });
      return await ref.get();
    }
  }

  async function switchToFriendView(friendUid, friendName, avatarColor) {
    closeProfilesModal(); closeFriends();
    const ownerUid = state.activeAccountId;  // capture so async errors land on the right account
    // ── Tear down ALL live subscriptions on the OWNER's data BEFORE mutating
    // state. If we don't, a buffered onSnapshot can fire mid-switch and write
    // the owner's inventory back into state.* / re-render the owner's racks,
    // leaving the previous user's content visible while we wait for the
    // friend's read to complete. (The onSnapshot callbacks also have a
    // `state.friendView` guard as defence-in-depth — see subscribeInventory.)
    unsubscribeInventory();
    unsubscribeRacks();
    state.friendView = { uid: friendUid, displayName: friendName, avatarColor, error: null };
    state.inventory = null; state.rows = [];
    state.racks = [];
    state.invLoading = true;
    renderFriendBanner();
    renderStats(); renderInventory();
    // Pre-warm the auth token ONCE on entering a friend view (throttled to
    // 30 min between actual refreshes). Avoids the "permission-denied → retry
    // succeeds" flash when the local ID token is close to expiry.
    await prewarmAuthToken(ownerUid);
    try {
      console.log(`[FriendView] reading users/${friendUid}/inventory as ${ownerUid}`);
      const snap = await readFriendCollectionWithRetry(ownerUid, friendUid, "inventory");
      console.log(`[FriendView] received ${snap.docs.length} docs`);
      const raw = {};
      snap.forEach(doc => { raw[doc.id] = doc.data(); });
      state.inventory = raw;
      state.rows = snap.docs.map(doc => normalizeRow(doc.id, doc.data()));
      await preCacheImages(state.rows);
      // Guard: user might have switched away during the await
      if (state.friendView?.uid !== friendUid) return;
      // Read the friend's racks (one-shot — no live subscription needed,
      // read-only view).  If permissions deny, we silently fall back to an
      // empty rack list — the Storage tab will just show "no racks yet".
      try {
        const racksSnap = await readFriendCollectionWithRetry(ownerUid, friendUid, "racks");
        if (state.friendView?.uid !== friendUid) return;
        const racks = racksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        racks.sort((a, b) => {
          const oa = a.order ?? 999, ob = b.order ?? 999;
          if (oa !== ob) return oa - ob;
          const ta = a.createdAt?.seconds || 0;
          const tb = b.createdAt?.seconds || 0;
          return ta - tb;
        });
        state.racks = racks;
        console.log(`[FriendView] received ${racks.length} rack(s)`);
      } catch (re) {
        console.warn("[FriendView] racks read failed:", re.code, re.message);
        state.racks = [];
      }
      state.invLoading = false;
      sortRows(); renderStats(); renderInventory();
    } catch (e) {
      console.error("[FriendView] read failed:", e.code, e.message, e);
      if (state.friendView?.uid !== friendUid) return;
      state.invLoading = false;
      state.inventory = {}; state.rows = [];
      // Surface the error in the banner + empty state
      state.friendView.error = e.code === "permission-denied"
        ? t("friendInvPermDenied")
        : (e.message || t("networkError"));
      renderFriendBanner();
      renderStats(); renderInventory();
    }
  }

  function switchBackToOwnView() {
    if (!state.friendView) return;
    state.friendView = null;
    state.inventory = null; state.rows = [];
    state.racks = [];                                   // wipe the friend's racks
    renderFriendBanner();
    // Clear the visible artefacts of the friend's view IMMEDIATELY (stats,
    // table/grid/rack rendering, detail panel). Without this, the friend's
    // numbers would linger in the header KPI cards and their racks would
    // remain rendered until the first own-snapshot arrives a few hundred
    // milliseconds later — exactly the "previous user's data still visible"
    // glitch we want to avoid.
    const uid = state.activeAccountId;
    if (uid) state.invLoading = true;
    renderStats();
    renderInventory();
    if (uid) {
      subscribeInventory(uid);
      subscribeRacks(uid);                              // re-attach own racks live-sync
    }
  }

  // Show public key and toggle in settings panel
  function renderFriendsSection() {
    const keyEl = $("stgPublicKey");
    if (keyEl) keyEl.textContent = state.publicKey || "—";
    const toggle = $("stgPublicToggle");
    if (toggle) toggle.checked = state.isPublic;
  }

  // Incoming friend request modal
  let _pendingRequest = null;
  const _requestQueue  = [];

  function showFriendRequestModal(uid, data) {
    _requestQueue.push({ uid, data });
    if (_requestQueue.length === 1) _showNextRequest();
  }

  function _showNextRequest() {
    if (!_requestQueue.length) return;
    _pendingRequest = _requestQueue[0];
    const { uid, data } = _pendingRequest;
    const initials = (data.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
    const color = friendColorFallback(uid);
    $("frqAvatar").textContent = initials;
    $("frqAvatar").style.background = color;
    $("frqAvatar").style.color = readableTextOn(color);
    $("frqName").textContent = data.displayName || uid;
    $("friendRequestOverlay").classList.add("open");
  }

  function _closeRequestModal() {
    $("friendRequestOverlay").classList.remove("open");
    _requestQueue.shift();
    setTimeout(_showNextRequest, 300);
  }

  $("frqAccept").addEventListener("click", async () => {
    if (!_pendingRequest) return;
    await acceptFriendRequest(_pendingRequest.uid, _pendingRequest.data.displayName);
    renderFriendsList();
    _closeRequestModal();
  });
  $("frqRefuse").addEventListener("click", async () => {
    if (!_pendingRequest) return;
    await refuseFriendRequest(_pendingRequest.uid);
    _closeRequestModal();
  });
  $("frqBlock").addEventListener("click", async () => {
    if (!_pendingRequest) return;
    await blockUser(_pendingRequest.uid, _pendingRequest.data.displayName);
    _closeRequestModal();
  });

  // Add friend modal — split-field XXX-XXX
  const ADF_CHARS = /[^A-Z0-9]/g;

  function adfValue() {
    return ($("adfA").value + "-" + $("adfB").value).toUpperCase();
  }

  function openAddFriendModal() {
    $("adfA").value = "";
    $("adfB").value = "";
    $("adfResult").textContent = "";
    $("adfPreview").classList.add("hidden");
    $("adfSend").disabled = true;
    $("addFriendOverlay").classList.add("open");
    setTimeout(() => $("adfA").focus(), 80);
  }
  function closeAddFriendModal() { $("addFriendOverlay").classList.remove("open"); }

  $("addFriendClose").addEventListener("click", closeAddFriendModal);
  $("adfCancel").addEventListener("click", closeAddFriendModal);

  let _adfDebounce = null;
  let _adfFoundUid = null;
  let _adfFoundName = null;

  function _adfChanged() {
    const val = adfValue();
    $("adfPreview").classList.add("hidden");
    $("adfSend").disabled = true;
    $("adfResult").textContent = "";
    _adfFoundUid = null;
    clearTimeout(_adfDebounce);
    if ($("adfA").value.length < 3 || $("adfB").value.length < 3) return;
    $("adfResult").textContent = "🔍 " + t("friendSearching");
    _adfDebounce = setTimeout(async () => {
      try {
        // O(1) lookup in publicKeys/{key}
        const keySnap = await fbDb().collection("publicKeys").doc(val).get();
        if (!keySnap.exists) { $("adfResult").textContent = "⚠ " + t("friendNotFound"); return; }
        const targetUid = keySnap.data().uid;
        if (targetUid === fbAuth().currentUser?.uid) { $("adfResult").textContent = "⚠ " + t("friendSelf"); return; }
        const profileSnap = await fbDb().collection("userProfiles").doc(targetUid).get();
        const p = profileSnap.exists ? profileSnap.data() : {};
        _adfFoundUid = targetUid; _adfFoundName = p.displayName;
        const initials = (p.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
        const color = profileColor(p) || friendColorFallback(targetUid);
        $("adfPreviewAvatar").textContent = initials;
        $("adfPreviewAvatar").style.background = color;
        $("adfPreviewAvatar").style.color = readableTextOn(color);
        $("adfPreviewName").textContent = p.displayName || val;
        $("adfPreview").classList.remove("hidden");
        $("adfResult").textContent = "";
        $("adfResult").className = "adf-result";
        $("adfSend").disabled = false;
      } catch (e) {
        $("adfResult").textContent = "⚠ " + t("networkError");
        $("adfResult").className = "adf-result adf-result--error";
      }
    }, 500);
  }

  // Sanitise + auto-advance on adfA
  $("adfA").addEventListener("input", () => {
    $("adfA").value = $("adfA").value.toUpperCase().replace(ADF_CHARS, "");
    if ($("adfA").value.length === 3) $("adfB").focus();
    _adfChanged();
  });

  // Handle paste of full key "XXX-XXX" into adfA
  $("adfA").addEventListener("paste", e => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData("text").trim().toUpperCase();
    const parts = raw.replace(ADF_CHARS.source.replace("[^", "["), "").match(/^([A-Z0-9]{3})[^A-Z0-9]?([A-Z0-9]{3})$/);
    if (parts) {
      $("adfA").value = parts[1]; $("adfB").value = parts[2];
      $("adfB").focus(); _adfChanged();
    }
  });

  // Sanitise adfB; backspace when empty → go back to adfA
  $("adfB").addEventListener("input", () => {
    $("adfB").value = $("adfB").value.toUpperCase().replace(ADF_CHARS, "");
    _adfChanged();
  });
  $("adfB").addEventListener("keydown", e => {
    if (e.key === "Backspace" && $("adfB").value === "") $("adfA").focus();
    if (e.key === "Escape") closeAddFriendModal();
  });
  $("adfA").addEventListener("keydown", e => { if (e.key === "Escape") closeAddFriendModal(); });

  $("adfSend").addEventListener("click", async () => {
    if (!_adfFoundUid) return;
    $("adfSend").disabled = true;
    try {
      await sendFriendRequest(adfValue());
      $("adfResult").textContent = "✓ " + t("friendRequestSent");
      $("adfResult").className = "adf-result adf-result--success";
      $("adfPreview").classList.add("hidden");
      setTimeout(closeAddFriendModal, 1500);
    } catch (e) {
      console.warn("[sendFriendRequest]", e.code, e.message);
      // Firestore rejects when the target has blocked us OR isPublic check etc.
      // Most common case: blacklist → permission-denied. Show a clear, friendly message.
      const msg = e.code === "permission-denied"
        ? t("friendNotSharing")
        : t("networkError");
      $("adfResult").textContent = "⚠ " + msg;
      $("adfResult").className = "adf-result adf-result--error";
      $("adfSend").disabled = false;
    }
  });

  // Settings panel — friends section wiring
  $("btnAddFriend").addEventListener("click", openAddFriendModal);

  // Live search filter
  $("fpSearch")?.addEventListener("input", () => renderFriendsList());

  $("btnCopyPublicKey").addEventListener("click", () => {
    if (!state.publicKey) return;
    navigator.clipboard.writeText(state.publicKey).then(() => {
      const btn = $("btnCopyPublicKey");
      btn.classList.add("fp-hero-btn--copied");
      setTimeout(() => btn.classList.remove("fp-hero-btn--copied"), 1500);
    });
  });

  $("btnRegenPublicKey").addEventListener("click", async () => {
    await regeneratePublicKey();
  });

  $("stgPublicToggle").addEventListener("change", async () => {
    const isPublic = $("stgPublicToggle").checked;
    state.isPublic = isPublic;
    const user = fbAuth().currentUser;
    if (!user) return;
    await fbDb().collection("users").doc(user.uid).set({ isPublic }, { merge: true });
    await syncUserProfile(user.uid, { isPublic });
  });

  /* ── Display-name setup modal ─────────────────────────────────────────── */
  function openDisplayNameSetup() {
    $("dnsInput").value = "";
    $("dnsResult").textContent = "";
    $("displayNameSetupOverlay").classList.add("open");
    setTimeout(() => $("dnsInput").focus(), 80);
  }
  function closeDisplayNameSetup() {
    $("displayNameSetupOverlay").classList.remove("open");
  }

  $("dnsSave").addEventListener("click", async () => {
    const name = $("dnsInput").value.trim();
    if (name.length < 1) { $("dnsResult").textContent = "⚠ " + t("setupNamePlaceholder"); return; }
    $("dnsSave").disabled = true;
    $("dnsResult").textContent = "";
    try {
      const user = fbAuth().currentUser;
      if (!user) throw new Error("not signed in");
      await fbDb().collection("users").doc(user.uid).set({ displayName: name }, { merge: true });
      // Update local state
      const accounts = getAccounts();
      const acc = accounts.find(a => a.id === user.uid);
      if (acc) { acc.displayName = name; saveAccounts(accounts); }
      state.displayName       = name;
      $("sbName").textContent = name;
      $("sbAvatar").textContent = getInitials({ displayName: name, email: acc?.email || "" });
      applyAvatarStyle(acc);
      renderAccountDropdown();
      closeDisplayNameSetup();
    } catch (err) {
      $("dnsResult").textContent = "⚠ " + (err.message || t("networkError"));
    } finally {
      $("dnsSave").disabled = false;
    }
  });

  $("dnsInput").addEventListener("keydown", e => {
    if (e.key === "Enter") $("dnsSave").click();
  });

  /* ── Friends system ───────────────────────────────────────────────────── */

  function subscribeFriendRequests(uid) {
    unsubscribeFriendRequests();
    state.unsubFriendRequests = fbDb()
      .collection("users").doc(uid)
      .collection("friendRequests")
      .onSnapshot(snap => {
        state.friendRequests = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        renderFriendRequestBadge();
        // Show modal for each new incoming request
        snap.docChanges().forEach(change => {
          if (change.type === "added") showFriendRequestModal(change.doc.id, change.doc.data());
        });
      }, err => console.warn("[friendRequests]", err.message));
  }

  function unsubscribeFriendRequests() {
    if (state.unsubFriendRequests) { state.unsubFriendRequests(); state.unsubFriendRequests = null; }
  }

  function renderFriendRequestBadge() {
    const count = state.friendRequests.length;
    const badge = $("friendsBadge");
    if (!badge) return;
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  }

  // Accept a friend request → bidirectional add (rules verify only friendship presence,
  // no key check — see firestore.rules /inventory).
  async function acceptFriendRequest(requesterUid, displayName) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const batch = fbDb().batch();
    const myRef    = fbDb().collection("users").doc(user.uid);
    const theirRef = fbDb().collection("users").doc(requesterUid);
    // Add requester to MY friends list
    batch.set(myRef.collection("friends").doc(requesterUid), {
      displayName: displayName || requesterUid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // Add ME to THEIR friends list (allowed because I have a friendRequest from them)
    batch.set(theirRef.collection("friends").doc(user.uid), {
      displayName: state.displayName || user.email,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // Remove the pending request
    batch.delete(myRef.collection("friendRequests").doc(requesterUid));
    await batch.commit();
    state.friends = [...state.friends.filter(f => f.uid !== requesterUid),
      { uid: requesterUid, displayName, addedAt: Date.now() }];
  }

  // Refuse a friend request (just delete it — they can request again)
  async function refuseFriendRequest(requesterUid) {
    const user = fbAuth().currentUser;
    if (!user) return;
    await fbDb().collection("users").doc(user.uid)
      .collection("friendRequests").doc(requesterUid).delete();
  }

  // Block → blacklist + delete request
  async function blockUser(requesterUid, displayName) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const batch = fbDb().batch();
    const myRef = fbDb().collection("users").doc(user.uid);
    batch.set(myRef.collection("blacklist").doc(requesterUid), {
      displayName: displayName || requesterUid,
      blockedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    batch.delete(myRef.collection("friendRequests").doc(requesterUid));
    await batch.commit();
    // Update local state + UI immediately
    state.blacklist = [...state.blacklist.filter(b => b.uid !== requesterUid),
      { uid: requesterUid, displayName: displayName || requesterUid, blockedAt: Date.now() }];
    renderBlacklist();
  }

  // Remove a friend — deletes from both sides (symmetric)
  async function removeFriend(friendUid) {
    const user = fbAuth().currentUser;
    if (!user) return;
    const batch = fbDb().batch();
    batch.delete(fbDb().collection("users").doc(user.uid).collection("friends").doc(friendUid));
    batch.delete(fbDb().collection("users").doc(friendUid).collection("friends").doc(user.uid));
    await batch.commit();
    state.friends = state.friends.filter(f => f.uid !== friendUid);
    renderFriendsList();
  }

  // Load blacklisted users from Firestore
  async function loadBlacklist() {
    const user = fbAuth().currentUser;
    if (!user) return;
    const uid = user.uid;
    try {
      const snap = await fbDb(uid).collection("users").doc(uid).collection("blacklist").get();
      if (uid !== state.activeAccountId) return;
      state.blacklist = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderBlacklist();
    } catch (e) { console.warn("[blacklist]", e.message); }
  }

  // Remove a user from the blacklist (allows them to send friend requests again)
  async function unblockUser(blockedUid) {
    const user = fbAuth().currentUser;
    if (!user) return;
    await fbDb().collection("users").doc(user.uid)
      .collection("blacklist").doc(blockedUid).delete();
    state.blacklist = state.blacklist.filter(b => b.uid !== blockedUid);
    renderBlacklist();
  }

  // Render the blacklist section in the Friends panel
  function renderBlacklist() {
    const list = $("fpBlacklistList");
    const count = $("fpBlacklistCount");
    const block = $("fpBlacklistBlock");
    if (!list || !block) return;
    if (count) count.textContent = state.blacklist.length;
    // Hide entire section when empty
    if (!state.blacklist.length) { block.classList.add("hidden"); list.innerHTML = ""; return; }
    block.classList.remove("hidden");
    list.innerHTML = state.blacklist.map(b => {
      const initials = (b.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      const color = friendColorFallback(b.uid);
      const fg = readableTextOn(color);
      const date = b.blockedAt ? timeAgo(b.blockedAt.seconds ? b.blockedAt.seconds * 1000 : b.blockedAt) : "";
      return `<div class="fp-friend fp-blocked" data-uid="${esc(b.uid)}">
        <div class="fp-friend-avatar" style="background:${color};color:${fg}">${initials}</div>
        <div class="fp-friend-main">
          <div class="fp-friend-name">${esc(b.displayName || b.uid)}</div>
          <div class="fp-friend-date">${date ? t("blockedOn", { date }) : ""}</div>
        </div>
        <button class="fp-friend-btn fp-friend-unblock" data-action="unblock" title="${t("unblockBtn")}">
          ${t("unblockBtn")}
        </button>
      </div>`;
    }).join("");
    list.querySelectorAll(".fp-friend-unblock").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const row = btn.closest(".fp-friend");
        btn.disabled = true;
        try { await unblockUser(row.dataset.uid); }
        catch (err) { console.error("[unblock]", err); btn.disabled = false; }
      });
    });
  }

  // Claim a unique publicKey via O(1) document lookup + transaction
  // Deletes the previous key from publicKeys if provided
  async function claimPublicKey(uid, oldKey) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generatePublicKey();
      const keyRef = fbDb().collection("publicKeys").doc(candidate);
      try {
        await fbDb().runTransaction(async tx => {
          const snap = await tx.get(keyRef);
          if (snap.exists) throw Object.assign(new Error("taken"), { code: "taken" });
          tx.set(keyRef, { uid, claimedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        // Transaction succeeded — release old key if any
        if (oldKey) {
          try { await fbDb().collection("publicKeys").doc(oldKey).delete(); } catch (_) {}
        }
        return candidate;
      } catch (e) {
        if (e.code !== "taken") throw e;
        // collision — try a new candidate
      }
    }
    throw new Error("Could not generate a unique public key after 10 attempts");
  }

  // Regenerate publicKey and persist everywhere
  async function regeneratePublicKey() {
    const user = fbAuth().currentUser;
    if (!user) return;
    // Show loading state
    const el  = $("stgPublicKey");
    const btn = $("btnRegenPublicKey");
    if (el)  { el.textContent = ""; el.classList.add("pkey-loading"); }
    if (btn) btn.disabled = true;
    try {
      const newKey = await claimPublicKey(user.uid, state.publicKey);
      await fbDb().collection("users").doc(user.uid).update({ publicKey: newKey });
      await syncUserProfile(user.uid, { publicKey: newKey });
      state.publicKey = newKey;
      if (el) el.textContent = newKey;
    } finally {
      if (el)  el.classList.remove("pkey-loading");
      if (btn) btn.disabled = false;
    }
  }

  // Send a friend request to another user (by their publicKey)
  async function sendFriendRequest(targetPublicKey) {
    const user = fbAuth().currentUser;
    if (!user) return null;
    const key = targetPublicKey.trim().toUpperCase();
    // O(1) lookup in publicKeys/{key} — no query, no index needed
    const keySnap = await fbDb().collection("publicKeys").doc(key).get();
    if (!keySnap.exists) return { error: "notFound" };
    const targetUid = keySnap.data().uid;
    if (targetUid === user.uid) return { error: "self" };
    // Fetch display name from userProfiles
    const profileSnap = await fbDb().collection("userProfiles").doc(targetUid).get();
    const displayName = profileSnap.exists ? profileSnap.data().displayName : targetUid;
    // Write request to their friendRequests subcollection.
    // No key needed — Firestore rules now verify friendship presence only (not key match).
    await fbDb().collection("users").doc(targetUid)
      .collection("friendRequests").doc(user.uid).set({
        displayName: state.displayName || user.email,
        requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    return { ok: true, displayName, uid: targetUid };
  }

  /* ── Key helpers ──────────────────────────────────────────────────────── */
  function generatePublicKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let a = "", b = "";
    for (let i = 0; i < 3; i++) a += chars[Math.floor(Math.random() * chars.length)];
    for (let i = 0; i < 3; i++) b += chars[Math.floor(Math.random() * chars.length)];
    return `${a}-${b}`; // e.g. "4X7-K3M"
  }
  function generatePrivateKey() {
    return Array.from(crypto.getRandomValues(new Uint8Array(20)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Write safe public fields to userProfiles/{uid} (readable by all authenticated users)
  async function syncUserProfile(uid, fields) {
    try {
      await fbDb().collection("userProfiles").doc(uid).set(fields, { merge: true });
    } catch (e) { console.warn("[userProfiles] write:", e.message); }
  }

  async function syncUserDoc(uid) {
    // Always use the named Firestore instance for this specific uid,
    // never fbDb() without parameter — that depends on state.activeAccountId
    // at promise-resolution time and can point to the wrong account.
    const db = fbDb(uid);
    try {
      // Force-server read on first sync to avoid showing the "Set display
      // name" prompt based on a stale empty cache (the user could have set
      // the name on another device but the local cache hasn't synced yet).
      // Falls back to cache automatically if offline.
      let snap;
      try {
        snap = await db.collection("users").doc(uid).get({ source: "server" });
      } catch (_) {
        // Offline / blocked → fall back to default (cache OR server)
        snap = await db.collection("users").doc(uid).get();
      }
      if (!snap.exists) return;
      // Guard: by the time the Firestore round-trip completes, the active account
      // may have changed. Only apply UI side-effects for the current active account.
      if (uid !== state.activeAccountId) return;
      const data = snap.data();

      // Admin + debug
      state.isAdmin      = data.roles === "admin";
      state.debugEnabled = state.isAdmin && !!data.Debug;
      applyDebugMode();

      // Generate publicKey + privateKey on first login if missing
      const keysUpdate = {};
      if (!data.publicKey)  keysUpdate.publicKey  = await claimPublicKey(uid, null);
      if (!data.privateKey) keysUpdate.privateKey = generatePrivateKey();
      if (Object.keys(keysUpdate).length) {
        await db.collection("users").doc(uid).set(keysUpdate, { merge: true });
        Object.assign(data, keysUpdate);
      }
      // Store keys + public flag in state for easy access
      state.publicKey  = data.publicKey;
      state.privateKey = data.privateKey;
      state.isPublic   = data.isPublic || false;

      // Firestore displayName + color are canonical — sync to localStorage
      const accounts = getAccounts();
      const acc = accounts.find(a => a.id === uid);
      let localDirty = false;

      // Resolve display name: Firestore is authoritative, localStorage is fallback
      const firestoreName = data.displayName || "";
      const localName     = acc?.displayName  || "";
      const resolvedName  = firestoreName || localName;

      if (resolvedName) {
        // We have a name — apply it everywhere
        if (acc && acc.displayName !== resolvedName) { acc.displayName = resolvedName; localDirty = true; }
        state.displayName         = resolvedName;
        $("sbName").textContent   = resolvedName;
        $("sbAvatar").textContent = getInitials({ displayName: resolvedName, email: acc?.email || "" });
        // If Firestore was missing the name but localStorage had it, write it back
        if (!firestoreName && localName) {
          db.collection("users").doc(uid).set({ displayName: localName }, { merge: true }).catch(() => {});
        }
      } else {
        // Defensive double-check before prompting: re-read from server one
        // last time after a short grace (1s) in case the doc is currently
        // being created/updated by another device. Only prompt if the
        // server STILL says the name is empty.
        setTimeout(async () => {
          if (uid !== state.activeAccountId) return;
          // If anything has set the name in the meantime, bail out
          if (state.displayName) return;
          try {
            const fresh = await db.collection("users").doc(uid).get({ source: "server" });
            if (fresh.exists && fresh.data().displayName) {
              const name = fresh.data().displayName;
              const accs = getAccounts();
              const a = accs.find(x => x.id === uid);
              if (a) { a.displayName = name; saveAccounts(accs); }
              state.displayName = name;
              $("sbName").textContent = name;
              $("sbAvatar").textContent = getInitials({ displayName: name, email: a?.email || "" });
              return;
            }
          } catch (_) {}
          // Truly nothing — prompt the user
          if (uid === state.activeAccountId && !state.displayName) {
            openDisplayNameSetup();
          }
        }, 1000);
      }

      if (acc && data.color_r !== undefined && data.color_g !== undefined && data.color_b !== undefined) {
        const h = n => n.toString(16).padStart(2, "0");
        const hex = `#${h(data.color_r)}${h(data.color_g)}${h(data.color_b)}`;
        // Try to match a named swatch, fall back to "custom"
        const match = Object.entries(ACCOUNT_COLORS).find(([, [c]]) => c.toLowerCase() === hex.toLowerCase());
        if (match) { acc.color = match[0]; delete acc.customColor; }
        else        { acc.color = "custom"; acc.customColor = hex; }
        localDirty = true;
      }

      if (localDirty && acc) { saveAccounts(accounts); }
      applyAvatarStyle(acc);
      renderAccountDropdown();

      // Keep userProfiles in sync with latest public info
      syncUserProfile(uid, {
        publicKey:   data.publicKey,
        displayName: resolvedName,
        isPublic:    data.isPublic || false,
        color:       accPrimaryHex(acc),  // single hex field — simpler than color_r/g/b
      });

      // Reflect in open edit-account modal if already open
      if ($("editAccountModalOverlay").classList.contains("open")) {
        $("eacAdminBadge").classList.toggle("hidden", !state.isAdmin);
        $("eacDebugRow").classList.toggle("hidden",   !state.isAdmin);
        $("eacDebugToggle").checked = state.debugEnabled;
        $("eacName").textContent = resolvedName;
        $("eacDisplayNameInput").value = resolvedName;
      }
    } catch (err) {
      console.warn("[Firestore] syncUserDoc:", err.message);
    }
  }

  async function syncLangFromFirestore(uid) {
    try {
      const doc = await fbDb(uid).collection("users").doc(uid)
        .collection("prefs").doc("app").get();
      if (!doc.exists) return;
      const cloudLang = doc.data().lang;
      if (!cloudLang || !state.i18n[cloudLang] || cloudLang === state.lang) return;
      // Remote has a different (more recent) language — apply it
      state.lang = cloudLang;
      localStorage.setItem("tigertag.lang", cloudLang);
      const accounts = getAccounts();
      const acc = accounts.find(a => a.id === uid);
      if (acc) { acc.lang = cloudLang; saveAccounts(accounts); }
      applyLang(cloudLang);
    } catch (err) {
      console.warn("[Firestore] syncLang:", err.message);
    }
  }
  function applyLang(lang) {
    if (!lang || !state.i18n[lang]) return;
    state.lang = lang;
    applyTranslations();
    renderStats();
    renderInventory();
    if (state.selected && $("detailPanel").classList.contains("open")) openDetail(state.selected);
  }
  $("langSelect").addEventListener("change", () => {
    const lang = $("langSelect").value;
    saveAccountLang(lang);
    applyLang(lang);
  });

  /* ── init ── */
  loadLocales().then(() => {
    applyTranslations();
    return loadLookups();
  }).then(() => {
    runMigration(); // wipe legacy API-key accounts before Firebase takes over
    initAuth();    // start Firebase auth state listener
  });

  // ── Electron RFID integration ──
  if (window.electronAPI) {

    // Reader connect / disconnect
    window.electronAPI.onReaderStatus(({ connected, name }) => {
      const el = $("rfidStatus");
      const lbl = $("rfidLabel");
      el.style.display = "flex";
      el.classList.toggle("ok",  connected);
      el.classList.toggle("bad", !connected);
      lbl.textContent = connected ? t("rfidConnected", {name: name || "—"}) : t("rfidNoReader");
    });

    // Card scanned → find spool and open detail panel
    window.electronAPI.onRfid((uid, rawHex) => {
      console.log('[RFID] scanned uid:', uid, 'raw:', rawHex);

      // Flash the RFID indicator
      const el = $("rfidStatus");
      el.style.display = "flex";
      el.classList.add("ok");
      $("rfidLabel").textContent = t("rfidScanned", {uid: uid.slice(-6)});

      // Search in loaded inventory
      const row = state.rows.find(r => r.uid === uid || r.spoolId === uid);
      if (row) {
        openDetail(row.spoolId);
        return;
      }

      // Unknown UID — show a toast and pre-fill RFID field if panel is open
      toast($("mainResult"), "warn", t("rfidNotFound", {uid}));
    });

    // Auto-update notification
    window.electronAPI.onUpdateStatus(({ status }) => {
      const banner = $("updateBanner");
      const msg    = $("updateMsg");
      const btn    = $("btnInstallUpdate");
      if (status === 'available') {
        msg.innerHTML = t("updateDownloading");
        btn.classList.add("hidden");
        banner.classList.remove("hidden");
      } else if (status === 'ready') {
        msg.innerHTML = t("updateReady");
        btn.textContent = t("btnRestartUpdate");
        btn.classList.remove("hidden");
        banner.classList.remove("hidden");
      }
    });
    $("btnInstallUpdate").addEventListener("click", () => window.electronAPI.installUpdate());
  }

  // ── TD1S sensor integration ──
  if (window.td1s) {
    const TD1S_MAX = 400;
    const td1sLogEl = $("td1sLog");

    function td1sEsc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function td1sAppendLog({ time, type, message }) {
      const line = document.createElement('div');
      line.innerHTML =
        `<span class="log-time">[${time}]</span> ` +
        `<span class="log-${type}">${td1sEsc(message)}</span>`;
      td1sLogEl.appendChild(line);
      while (td1sLogEl.children.length > TD1S_MAX) td1sLogEl.removeChild(td1sLogEl.firstChild);
      td1sLogEl.scrollTop = td1sLogEl.scrollHeight;
    }

    window.td1s.onLog(entry => td1sAppendLog(entry));

    window.td1s.onStatus(msg => {
      $("td1sStatus").textContent = msg;
      const connected = msg === "Status: Sensor connected";
      $("btnTD1S")?.classList.toggle("td1s-connected", connected);
      $("td1sHealth")?.classList.toggle("td1s-connected", connected);
      $("td1sHealth")?.setAttribute("data-tooltip", t(connected ? "td1sDetected" : "td1sNotDetected"));
      state.td1sConnected = connected;
      // Auto-close connect modal when TD1S plugged in, then open viewer
      if (connected && _td1sConnectOpen) {
        closeTd1sConnectModal();
        openTd1sTesterModal();
      }
      // Auto-close tester modal when TD1S disconnected
      if (!connected && _td1sTesterOpen) {
        closeTd1sTesterModal();
      }
      // Update TD edit modal if open
      if ($("tdEditModalOverlay")?.classList.contains("open")) {
        if (connected && !_tdEditData) {
          _setEditState(_tdIds, "waiting"); _tdEditWaiting = true;
        } else if (!connected && !_tdEditData) {
          _setEditState(_tdIds, "disconnected"); _tdEditWaiting = false;
        }
      }
      // Update Color edit modal if open
      if ($("colorEditModalOverlay")?.classList.contains("open")) {
        if (connected && !_colorEditData) {
          _setEditState(_ceIds, "waiting"); _colorEditWaiting = true;
        } else if (!connected && !_colorEditData) {
          _setEditState(_ceIds, "disconnected"); _colorEditWaiting = false;
        }
      }
    });

    window.td1s.onSensorData(data => {
      $("td1sTdVal").textContent  = data.TD  || '-';
      $("td1sHexVal").textContent = data.HEX ? `#${data.HEX}` : '-';
      const hex = (data.HEX || '').replace('#', '');
      $("td1sColorCircle").style.background =
        /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : '#2a2a2a';
      // Feed into TD edit modal if waiting for a scan
      if (_tdEditWaiting && $("tdEditModalOverlay")?.classList.contains("open")) {
        _tdEditReceiveData(data);
      }
      // Feed into Color edit modal if waiting for a scan
      if (_colorEditWaiting && $("colorEditModalOverlay")?.classList.contains("open")) {
        _colorEditReceiveData(data);
      }
      // Feed into tester modal if open
      if (_td1sTesterOpen) {
        const circle = $("td1sTesterCircle");
        const hexIn  = $("td1sTesterHex");
        const tdIn   = $("td1sTesterTd");
        if (circle) circle.style.background = /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : "#2a2a2a";
        if (hexIn)  hexIn.value  = hex ? `#${hex.toUpperCase()}` : "";
        if (tdIn)   tdIn.value   = data.TD != null ? data.TD : "";
      }
    });

    window.td1s.onClear(() => {
      // Tester modal: blank out all display fields
      if (_td1sTesterOpen) {
        const circle = $("td1sTesterCircle");
        const hexIn  = $("td1sTesterHex");
        const tdIn   = $("td1sTesterTd");
        if (circle) circle.style.background = "#2a2a2a";
        if (hexIn)  hexIn.value  = "";
        if (tdIn)   tdIn.value   = "";
      }
      // TD Edit modal: go back to "waiting" so the user can re-scan
      if ($("tdEditModalOverlay")?.classList.contains("open") && _tdEditData) {
        _tdEditData = null; _tdEditWaiting = true;
        const c = $("tdEditCircle"); if (c) c.style.background = "#2a2a2a";
        const hi = $("tdEditHexInput"); if (hi) hi.value = "";
        const ti = $("tdEditTdInput"); if (ti) ti.value = "";
        _setEditState(_tdIds, "waiting");
      }
      // Color Edit modal: go back to "waiting" so the user can re-scan
      if ($("colorEditModalOverlay")?.classList.contains("open") && _colorEditData) {
        _colorEditData = null; _colorEditWaiting = true;
        const ci = $("colorEditCircle"); if (ci) ci.style.background = "#2a2a2a";
        const hi = $("colorEditHexInput"); if (hi) hi.value = "";
        const ti = $("colorEditTdInput"); if (ti) ti.value = "";
        _setEditState(_ceIds, "waiting");
      }
    });

    // Copy log
    $("td1sCopyBtn").addEventListener("click", () => {
      const text = Array.from(td1sLogEl.children).map(el => el.textContent).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        const btn = $("td1sCopyBtn");
        btn.style.borderColor = "#6ed46e";
        btn.style.color = "#6ed46e";
        setTimeout(() => { btn.style.borderColor = ""; btn.style.color = ""; }, 1500);
      });
    });

    // Clear log
    $("td1sClearBtn").addEventListener("click", () => { td1sLogEl.innerHTML = ''; });
  }
})();
