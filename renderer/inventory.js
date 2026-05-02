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
      rackId:     data.rack_id  || null,
      rackLevel:  Number.isInteger(data.level)    ? data.level    : null,
      rackPos:    Number.isInteger(data.position) ? data.position : null,
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

  function maybeMigrateDecimalSpoolIds(ownerUid) {
    if (state.friendView) return;
    if (!ownerUid || !state.inventory) return;
    for (const docId of Object.keys(state.inventory)) {
      if (!isDecimalSpoolId(docId)) continue;
      if (_uidMigrationQueue.includes(docId)) continue;
      _uidMigrationQueue.push(docId);
    }
    drainUidMigrationQueue(ownerUid);
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
        // Politeness — small gap between writes so we don't dominate the
        // user's Firestore quota during initial backfill.
        await new Promise(r => setTimeout(r, 200));
      }
    } finally {
      _uidMigrationDraining = false;
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
    // or more.
    const reverseTwins = await invRef.where("twin_tag_uid", "==", decimalId).get();

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
    unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales();
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
        unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales();
        state.inventory = null; state.rows = [];
        state.isAdmin = false; state.debugEnabled = false;
        state.publicKey = null; state.privateKey = null;
        state.friends = []; state.friendRequests = []; state.blacklist = []; state.racks = [];
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
      unsubscribeInventory(); unsubscribeFriendRequests(); unsubscribeRacks(); unsubscribeScales();
      state.inventory = null; state.rows = [];
      state.isAdmin = false; state.debugEnabled = false;
      state.publicKey = null; state.privateKey = null;
      state.friends = []; state.friendRequests = []; state.blacklist = []; state.racks = [];
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
        renderRackView();
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
      renderRackView();
      return;
    }
    $("invRackView").classList.add("hidden");

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
  }
  $("btnViewTable").addEventListener("click", () => setViewMode("table"));
  $("btnViewGrid").addEventListener("click",  () => setViewMode("grid"));
  $("btnViewRack")?.addEventListener("click", () => setViewMode("rack"));
  // Restore active button on boot
  if (state.viewMode === "grid") { $("btnViewGrid").classList.add("active"); $("btnViewTable").classList.remove("active"); }
  else if (state.viewMode === "rack") { $("btnViewRack")?.classList.add("active"); $("btnViewTable").classList.remove("active"); }

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
      ${state.friendView || r.deleted ? "" : `
      <div class="panel-section panel-section--delete">
        <button class="adf-btn adf-btn--danger panel-delete-btn" id="btnSpoolDelete" title="${esc(t("spoolMarkDeletedTip"))}" data-spool-id="${esc(r.spoolId)}">
          <span class="hold-progress"></span>
          <span class="icon icon-trash icon-13"></span>
          <span data-i18n="spoolMarkDeleted">${esc(t("spoolMarkDeleted"))}</span>
        </button>
      </div>`}
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
      </div>`;
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
  // Convert Firestore Timestamp object to ms (the existing tsToMs at line 366
  // handles legacy shapes; here we add support for { seconds, nanoseconds }).
  function scaleTsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts.seconds != null) return ts.seconds * 1000 + Math.round((ts.nanoseconds || 0) / 1e6);
    return tsToMs(ts) || 0;
  }
  function isScaleOnline(s) {
    return Date.now() - scaleTsToMs(s?.last_seen) < SCALE_ONLINE_THRESHOLD_MS;
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
      const lastSeenMs = scaleTsToMs(s.last_seen);
      const lastSeenStr = lastSeenMs ? agoString(lastSeenMs) : "—";
      // Try to match the last_spool against the current inventory for nice display
      let lastBlock = `<div class="scale-last-empty">${esc(t("scaleNoActivity"))}</div>`;
      const ls = s.last_spool;
      if (ls && (ls.uid_a || ls.uid_b)) {
        const targetUid = String(ls.uid_a || ls.uid_b);
        const r = state.rows.find(x => String(x.uid) === targetUid || String(x.spoolId) === targetUid)
              || (ls.uid_b && state.rows.find(x => String(x.uid) === String(ls.uid_b) || String(x.spoolId) === String(ls.uid_b)));
        const fillBg = r ? colorBg(r) : "rgba(150,150,150,.2)";
        const fillHtml = r ? slotFillInnerHTML(r) : "";
        const titleLine = r?.colorName !== "-" && r?.colorName ? r.colorName : (r?.material || targetUid);
        const subLine   = r ? [r.brand, r.material].filter(Boolean).join(" · ") : `uid=${targetUid}`;
        const wAvail    = ls.weight_available != null ? ls.weight_available : (r?.weightAvailable ?? "—");
        const wRaw      = ls.weight_raw != null ? `raw ${ls.weight_raw}g` : "";
        lastBlock = `
          <div class="scale-last-spool">
            <div class="scale-last-puck" style="background:${fillBg}">${fillHtml}</div>
            <div class="scale-last-meta">
              <div class="scale-last-name">${esc(String(titleLine))}</div>
              <div class="scale-last-sub">${esc(subLine)}${wRaw ? " · " + esc(wRaw) : ""}</div>
            </div>
            <div class="scale-last-w">${esc(String(wAvail))}<span class="scale-last-w-unit">g</span></div>
          </div>`;
      }
      return `<div class="scale-card${online ? " is-online" : ""}" data-scale-mac="${esc(s.mac)}">
        <div class="scale-card-head">
          <span class="scale-card-status" title="${online ? "online" : "offline"}"></span>
          <div class="scale-card-info">
            <div class="scale-card-name">${esc(s.name || "TigerScale")}</div>
            <div class="scale-card-meta">${esc(s.mac)} · ${online ? t("scaleStatusOnline") : `${t("scaleStatusOffline")} · ${esc(lastSeenStr)}`}</div>
          </div>
          <div class="scale-card-actions">
            <button class="scale-card-btn" data-action="delete" title="${t("scaleRemove")}"><span class="icon icon-trash icon-13"></span></button>
          </div>
        </div>
        ${lastBlock}
        <div class="scale-card-fw">
          ${s.fw_version ? `fw ${esc(s.fw_version)}` : ""}
          ${s.battery_pct != null ? `· ${esc(String(s.battery_pct))}% battery` : ""}
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
        if (!confirm(t("scaleRemoveConfirm", { name: s.name || mac }))) return;
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
    const rackRef = fbDb().collection("users").doc(user.uid).collection("racks").doc(rackId);
    const batch = fbDb().batch();
    batch.set(rackRef, {
      ...fields,
      lastUpdate: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // If dimensions shrink, every spool whose slot is out of the new bounds
    // (level >= newLevel  or  position >= newPosition) is orphaned and must be
    // returned to the unranked sidebar — same batch so it's atomic.
    const newLevel = fields.level;
    const newPos   = fields.position;
    if (newLevel != null || newPos != null) {
      const invSnap = await fbDb().collection("users").doc(user.uid)
        .collection("inventory").where("rack_id", "==", rackId).get();
      let freed = 0;
      invSnap.forEach(d => {
        const data = d.data();
        const lv = data.level;
        const ps = data.position;
        const oobLevel = (newLevel != null && Number.isInteger(lv) && lv >= newLevel);
        const oobPos   = (newPos   != null && Number.isInteger(ps) && ps >= newPos);
        if (oobLevel || oobPos) {
          batch.update(d.ref, { rack_id: null, level: null, position: null });
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
    // Free all spools assigned to this rack
    const invSnap = await fbDb().collection("users").doc(user.uid)
      .collection("inventory").where("rack_id", "==", rackId).get();
    const batch = fbDb().batch();
    invSnap.forEach(d => batch.update(d.ref, {
      rack_id: null, level: null, position: null
    }));
    batch.delete(fbDb().collection("users").doc(user.uid)
      .collection("racks").doc(rackId));
    await batch.commit();
  }

  // Unassign all spools from a rack but keep the rack itself.
  // Returns the number of spools that were freed.
  async function emptyRack(rackId) {
    const user = fbAuth().currentUser;
    if (!user) return 0;
    // Cascade animation BEFORE the Firestore writes — fade + slide each filled
    // slot toward the unranked panel one by one (top→bottom, left→right).
    // We pause for the cascade to play out, then commit the batch. The
    // Firestore snapshot then rebuilds the DOM with the slots empty.
    await playEmptyRackCascade(rackId);
    const invSnap = await fbDb().collection("users").doc(user.uid)
      .collection("inventory").where("rack_id", "==", rackId).get();
    if (invSnap.empty) return 0;
    const batch = fbDb().batch();
    invSnap.forEach(d => batch.update(d.ref, {
      rack_id: null, level: null, position: null
    }));
    await batch.commit();
    return invSnap.size;
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

  // Assign / move / unassign a spool to a slot. Performs a swap if the target
  // slot is already occupied (in a single Firestore batch for atomicity).
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

    if (occupant && moving && moving.rackId) {
      // Swap: occupant moves to the moving spool's previous slot
      batch.update(invRef.doc(occupant.spoolId), {
        rack_id:  moving.rackId,
        level:    moving.rackLevel,
        position: moving.rackPos
      });
    } else if (occupant) {
      // Coming from unranked → push the occupant out as unranked
      batch.update(invRef.doc(occupant.spoolId), {
        rack_id: null, level: null, position: null
      });
    }
    // Place the new spool into the target slot
    batch.update(invRef.doc(spoolId), {
      rack_id:  rackId,
      level:    level,
      position: position
    });
    // Tag this spool for the next render — bounce-in animation
    _justPlacedSpools.add(spoolId);
    await batch.commit();
  }

  async function unassignSpool(spoolId) {
    const user = fbAuth().currentUser;
    if (!user) return;
    await fbDb().collection("users").doc(user.uid).collection("inventory")
      .doc(spoolId).update({ rack_id: null, level: null, position: null });
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
          const ref = fbDb().collection("users").doc(user.uid)
            .collection("inventory").doc(spool.spoolId);
          batch.update(ref, { rack_id: r.id, level: lv, position: pos });
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
      targets.forEach(t => {
        batch.update(invRef.doc(t.spoolId), {
          rack_id: null, level: null, position: null,
        });
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
          await fbDb().collection("users").doc(user.uid)
            .collection("inventory").doc(spoolId)
            .update({ rack_id: rack.id, level: lv, position: pos });
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

  // Filter unranked spools (rack_id is null/missing, not deleted).
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
    const unrankedCount = getUnrackedSpools().length;
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
    const panelOpenInit = localStorage.getItem("tigertag.unrackedPanelOpen") !== "false";
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
          <span class="rp-side-count">${unranked.length}</span>
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
        if (cnt) cnt.textContent = filtered.length;
        // Keep the stats-bar tile in sync with the filter so it shows the
        // visible count, not the total.
        const tileNum = $("btnToggleUnranked")?.querySelector(".rv-stat-num");
        if (tileNum) tileNum.textContent = filtered.length;
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
        strip.classList.remove("rp-unranked-strip--drop");
        const sid = e.dataTransfer.getData("text/plain");
        if (!sid) return;
        try { await unassignSpool(sid); }
        catch (err) { console.warn("[unassignSpool]", err.message); }
      });
    }
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
