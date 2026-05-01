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
    $("sbAvatar").style.background = grad;
    $("sbAvatar").style.boxShadow = `0 0 0 3px ${sh}40,0 4px 20px ${sh}33`;
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
    return _appInfo;
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
    lines.push("# TigerTag Studio Manager — diagnostic report");
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
      lastUpdate: tsToMs(data.last_update) || tsToMs(data.updated_at),
      deleted: !!data.deleted || !!data.deleted_at,
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
    const accounts = getAccounts();
    const activeId = state.activeAccountId;
    const list = $("acctDropdownList");

    // ── Connected accounts ──
    let html = accounts.map(acc => `
      <button class="acct-drop-item${acc.id===activeId?' active':''}" data-drop-id="${esc(acc.id)}">
        <span class="acct-drop-avatar" style="background:${getAccGradient(acc)}">${esc(getInitials(acc))}</span>
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
        const isActive = state.friendView?.uid === f.uid;
        return `<button class="acct-drop-item${isActive ? ' acct-drop-friend-active' : ''}" data-drop-friend-uid="${esc(f.uid)}" data-drop-friend-name="${esc(f.displayName || f.uid)}" data-drop-friend-color="${esc(color)}">
          <span class="acct-drop-avatar" style="background:${color}">${initials}</span>
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
        if (id !== activeId) switchAccountUI(id);
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

  const SVG_CHECK = `<span class="icon icon-check icon-13"></span>`;

  $("btnStgExport").addEventListener("click", () => {
    if (!state.inventory) return;
    const blob = new Blob([JSON.stringify(state.inventory,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `tigertag-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
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
    } else {
      $("acctDropdown").classList.contains("open") ? closeAccountDropdown() : openAccountDropdown();
    }
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

  // Google sign-in via popup — sign in on DEFAULT app, then transfer session
  // to a named instance (uid) so multiple accounts can coexist independently.
  $("btnGoogleSignIn").addEventListener("click", async () => {
    setLoading($("btnGoogleSignIn"), true);
    $("addModalResult").innerHTML = "";
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const result = await firebase.auth().signInWithPopup(provider);
      const uid = result.user.uid;
      // Transfer session to named instance, mark active, then register listener
      ensureFirebaseApp(uid);
      await firebase.app(uid).auth().updateCurrentUser(result.user);
      setActiveId(uid);          // ← must run BEFORE setupNamedAuth so the listener's
                                  //   getActiveId() === uid check passes on first fire
      setupNamedAuth(uid);
      await firebase.auth().signOut();
      closeAddAccountModal();
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
        // Create on DEFAULT, transfer to named instance, then mark active
        const result = await firebase.auth().createUserWithEmailAndPassword(email, password);
        const uid = result.user.uid;
        ensureFirebaseApp(uid);
        await firebase.app(uid).auth().setPersistence(persistence);
        await firebase.app(uid).auth().updateCurrentUser(result.user);
        setActiveId(uid);          // ← before setupNamedAuth (listener guard fix)
        setupNamedAuth(uid);
        await firebase.auth().signOut();
        toast($("addModalResult"), "ok", t("loginAccountCreated"));
        setTimeout(closeAddAccountModal, 1400);
      } else {
        // Sign in on DEFAULT, transfer to named instance, then mark active
        const result = await firebase.auth().signInWithEmailAndPassword(email, password);
        const uid = result.user.uid;
        ensureFirebaseApp(uid);
        await firebase.app(uid).auth().setPersistence(persistence);
        await firebase.app(uid).auth().updateCurrentUser(result.user);
        setActiveId(uid);          // ← before setupNamedAuth (listener guard fix)
        setupNamedAuth(uid);
        await firebase.auth().signOut();
        closeAddAccountModal();
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

  /* ── Firestore inventory subscription ── */
  function subscribeInventory(uid) {
    unsubscribeInventory();
    _unsubInventory = fbDb()
      .collection("users").doc(uid)
      .collection("inventory")
      .onSnapshot({ includeMetadataChanges: true }, snapshot => {
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
        saveInventory(raw);
        preCacheImages(state.rows).then(() => {
          sortRows(); renderStats(); renderInventory();
          // Refresh open detail panel with latest data
          if (state.selected && $("detailPanel").classList.contains("open")) {
            openDetail(state.selected);
          }
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
    unsubscribeInventory(); unsubscribeFriendRequests();
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
        unsubscribeInventory(); unsubscribeFriendRequests();
        state.inventory = null; state.rows = [];
        state.isAdmin = false; state.debugEnabled = false;
        state.publicKey = null; state.privateKey = null;
        state.friends = []; state.friendRequests = []; state.blacklist = [];
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
          <span class="prf-account-avatar" style="background:${getAccGradient(acc)}">${esc(getInitials(acc))}</span>
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
          const initials = (f.displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
          const isActive = state.friendView?.uid === f.uid;
          return `
          <button class="prf-account-card prf-friend-card${isActive ? " prf-friend-active" : ""}"
                  data-fv-uid="${esc(f.uid)}" data-fv-name="${esc(f.displayName || f.uid)}" data-fv-color="${esc(color)}">
            <span class="prf-account-avatar" style="background:${color}">${initials}</span>
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
      unsubscribeInventory(); unsubscribeFriendRequests();
      state.inventory = null; state.rows = [];
      state.isAdmin = false; state.debugEnabled = false;
      state.publicKey = null; state.privateKey = null;
      state.friends = []; state.friendRequests = []; state.blacklist = [];
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
    return sortRows(deduplicateTwins(rows));
  }

  /* ── render ── */
  function renderInventory() {
    const rows = filteredRows();
    renderFriendBanner();

    // ── Loading or truly empty → dedicated welcome card ──────────────────────
    // In friendView, keep card-inv visible so the banner stays; show spinner there
    if (state.invLoading || (state.inventory !== null && state.rows.length === 0)) {
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
  $("btnViewTable").addEventListener("click", () => {
    state.viewMode = "table"; localStorage.setItem("tigertag.view","table");
    $("btnViewTable").classList.add("active"); $("btnViewGrid").classList.remove("active");
    renderInventory();
  });
  $("btnViewGrid").addEventListener("click", () => {
    state.viewMode = "grid"; localStorage.setItem("tigertag.view","grid");
    $("btnViewGrid").classList.add("active"); $("btnViewTable").classList.remove("active");
    renderInventory();
  });
  // Defensive: if a previous build left "rack" in localStorage (Storage feature is gated off
  // in this build), fall back to "table" so users don't get a blank view.
  if (state.viewMode === "rack") { state.viewMode = "table"; localStorage.setItem("tigertag.view", "table"); }
  if (state.viewMode === "grid") { $("btnViewGrid").classList.add("active"); $("btnViewTable").classList.remove("active"); }

  $("searchInv").addEventListener("input", e => { state.search = e.target.value.trim(); renderInventory(); });

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

    const infoHtml = `
      <div class="panel-section">
        <div class="panel-label">${t("sectionDetails")}</div>
        ${infoRows.map(([k,val]) => `<div class="panel-row"><span class="pk">${k}</span><span class="pv">${esc(String(val))}</span></div>`).join("")}
        <div style="margin-top:8px;display:flex;gap:6px">
          ${r.isPlus ? '<span class="tag-plus">TigerTag+</span>' : '<span class="tag-diy">TigerTag</span>'}
          ${r.deleted ? `<span class="badge bad" style="font-size:11px">${t("badgeDeleted")}</span>` : ""}
        </div>
      </div>`;

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
      ${containerHtml}
      ${tempHtml}
      ${videoHtml}
      ${linksHtml}
      ${infoHtml}
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
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDebug(); });

  /* ── diagnostic / report-problem modal ── */
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
      $("diagBody").focus(); $("diagBody").select();
    }
  });
  $("btnDiagClear")?.addEventListener("click", () => {
    _errorLog.length = 0;
    $("diagBody").value = buildDiagnosticReport();
    renderDiagBadge();
  });
  // Pre-load app info so the first open is instant
  loadAppInfo();

  // debug tab switching
  document.querySelectorAll(".dbg-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dbg-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $("dbgPaneApi").classList.toggle("hidden", tab !== "api");
      $("dbgPaneFs").classList.toggle("hidden",  tab !== "fs");
      if (tab === "fs") fsExplRefresh();
    });
  });

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
    $("btnDebug").classList.toggle("hidden", !state.debugEnabled);
    if (!state.debugEnabled) closeDebug();
  }

  /* ── Friends UI ───────────────────────────────────────────────────────── */

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
      const date = f.addedAt ? timeAgo(f.addedAt.seconds ? f.addedAt.seconds * 1000 : f.addedAt) : "";
      return `<div class="fp-friend" data-uid="${esc(f.uid)}" data-name="${esc(f.displayName || f.uid)}" data-color="${esc(color)}">
        <div class="fp-friend-avatar" style="background:${color}">${initials}</div>
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
  function renderFriendBanner() {
    const banner = $("friendViewBanner");
    if (!banner) return;
    if (!state.friendView) { banner.classList.add("hidden"); return; }
    const { displayName, avatarColor, error } = state.friendView;
    const initials = (displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
    banner.innerHTML = `
      <div class="fvb-inner">
        <span class="fvb-avatar" style="background:${avatarColor || "var(--accent)"}">${esc(initials)}</span>
        <span class="fvb-name">${esc(displayName || "—")}</span>
        ${error
          ? `<span class="fvb-badge fvb-badge--error" title="${esc(error)}">⚠ ${t("friendInvErrorBadge")}</span>`
          : `<span class="fvb-badge">${t("friendViewReadOnly")}</span>`}
      </div>
      <button class="fvb-back" id="btnFriendViewBack">
        <span class="icon icon-chevron-l icon-11"></span>
        ${t("friendViewBack")}
      </button>`;
    banner.classList.toggle("fvb--error", !!error);
    banner.classList.remove("hidden");
    $("btnFriendViewBack")?.addEventListener("click", switchBackToOwnView);
  }

  async function switchToFriendView(friendUid, friendName, avatarColor) {
    closeProfilesModal(); closeFriends();
    const ownerUid = state.activeAccountId;  // capture so async errors land on the right account
    state.friendView = { uid: friendUid, displayName: friendName, avatarColor, error: null };
    state.inventory = null; state.rows = [];
    state.invLoading = true;
    renderFriendBanner();
    renderStats(); renderInventory();
    try {
      console.log(`[FriendView] reading users/${friendUid}/inventory as ${ownerUid}`);
      const snap = await fbDb(ownerUid).collection("users").doc(friendUid).collection("inventory").get();
      console.log(`[FriendView] received ${snap.docs.length} docs`);
      const raw = {};
      snap.forEach(doc => { raw[doc.id] = doc.data(); });
      state.inventory = raw;
      state.rows = snap.docs.map(doc => normalizeRow(doc.id, doc.data()));
      await preCacheImages(state.rows);
      // Guard: user might have switched away during the await
      if (state.friendView?.uid !== friendUid) return;
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
    renderFriendBanner();
    const uid = state.activeAccountId;
    if (uid) { state.invLoading = true; renderInventory(); subscribeInventory(uid); }
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
      const date = b.blockedAt ? timeAgo(b.blockedAt.seconds ? b.blockedAt.seconds * 1000 : b.blockedAt) : "";
      return `<div class="fp-friend fp-blocked" data-uid="${esc(b.uid)}">
        <div class="fp-friend-avatar" style="background:${color}">${initials}</div>
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
      const snap = await db.collection("users").doc(uid).get();
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
        // Truly no name anywhere — prompt the user (only for the active account)
        openDisplayNameSetup();
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
