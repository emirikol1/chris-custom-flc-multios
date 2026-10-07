(function () {
  "use strict";

  const fmt = window.flcStatsFormat;
  const PHASE_KEYS = ["transfers", "worldData", "init", "i18n", "setup", "canvas"];
  const DOC_KEYS = [
    "actors",
    "items",
    "scenes",
    "journal",
    "tables",
    "macros",
    "playlists",
    "cards",
    "folders",
    "users",
    "messages",
    "packs",
  ];
  const SCENE_KEYS = ["tokens", "tiles", "lights", "walls"];

  const sig = {
    findings: null,
    types: null,
    modules: null,
    packages: null,
    pageErrors: null,
    netErrors: null,
  };

  let serverId = "";
  let unsub = null;
  let prevSample = null;
  let sawLive = false;
  let issueTracker = null;
  let ackedIds = [];
  let resolvedTimer = null;
  const issueCopyTimers = new WeakMap();
  let badUrlCount = null;
  let badPanelOpen = false;
  let badFetchGen = 0;
  let badCopyTimer = null;
  let emailThenSend = false;
  let netUnsub = null;
  let netRunning = false;

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    const next = value == null || value === "" ? "—" : String(value);
    if (el.textContent !== next) el.textContent = next;
  }

  function fmtCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return String(Math.round(value));
  }

  function fmtScalar(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value) return value;
    return "—";
  }

  function fmtCpu(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
  }

  function fmtLoad(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return value.toFixed(2);
  }

  function fmtFps(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function ratio(part, whole) {
    if (typeof part !== "number" || typeof whole !== "number") return null;
    if (!Number.isFinite(part) || !Number.isFinite(whole) || !(whole > 0)) return null;
    return part / whole;
  }

  function setBar(id, value) {
    const el = $(id);
    if (!el || !fmt) return;
    const level = fmt.barLevel(value);
    const width = typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value)) * 100
      : 0;
    el.style.width = `${width}%`;
    if (el.dataset.level !== level) {
      el.dataset.level = level;
      el.className = level;
    }
  }

  function showToast(message, level) {
    const host = $("notifications");
    if (!host) return;
    const kind = level === "error" || level === "warn" ? level : "info";
    const toast = document.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    const p = document.createElement("p");
    p.className = "toast-message";
    p.textContent = message;
    toast.appendChild(p);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());
    toast.appendChild(close);
    host.appendChild(toast);
    if (kind !== "error") {
      window.setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, 5000);
    }
  }

  function copiedToast(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "Copied";
    const kb = bytes / 1024;
    const rounded = Math.round(kb * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `Copied (${text} KB)`;
  }

  function safeError(error) {
    if (typeof error !== "string" || !error || error.includes("://")) return "";
    return error.slice(0, 180);
  }

  function renderSync(sync) {
    const label = fmt.syncLabel(sync);
    const light = $("sync-light");
    if (light) {
      const className = `status-light ${label.state}`;
      if (light.className !== className) light.className = className;
      const aria = label.cause ? `${label.text}. ${label.cause}` : label.text;
      if (light.getAttribute("aria-label") !== aria) light.setAttribute("aria-label", aria);
    }
    setText("sync-text", label.text);
    const cause = $("sync-cause");
    if (cause) {
      cause.hidden = !label.cause;
      if (cause.textContent !== label.cause) cause.textContent = label.cause;
    }
    setText("sync-rtt", fmt.syncLatencyLabel(sync));
    setText("sync-reconnects", fmtCount(sync && sync.reconnects));
    setText("sync-last-request", fmt.formatLastRequest(sync));
    setText("sync-last-message", fmt.formatTraffic(sync));
  }

  function persistAck(id, acknowledged) {
    const api = window.flcStats;
    if (!serverId || !api) return;
    const fn = acknowledged ? api.ackIssue : api.releaseIssue;
    if (typeof fn !== "function") return;
    fn(serverId, id).catch(() => {});
  }

  function issues() {
    if (!issueTracker && fmt && typeof fmt.createIssueTracker === "function") {
      issueTracker = fmt.createIssueTracker({
        now: () => Date.now(),
        dismissed: ackedIds,
        onDismiss: (id) => persistAck(id, true),
        onRelease: (id) => persistAck(id, false),
      });
    }
    return issueTracker;
  }

  function stopResolvedTicker() {
    if (resolvedTimer == null) return;
    window.clearInterval(resolvedTimer);
    resolvedTimer = null;
  }

  function updateResolvedAgo() {
    const list = $("findings-list");
    if (!list || !fmt || typeof fmt.formatResolvedAgo !== "function") return;
    const now = Date.now();
    const items = list.querySelectorAll(".issue.is-resolved");
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const raw = item.getAttribute("data-resolved-at");
      const label = item.querySelector(".issue-state");
      if (!label || raw == null || raw === "") continue;
      const ago = fmt.formatResolvedAgo(Number(raw), now);
      const text = ago ? `resolved ${ago} ago` : "resolved";
      if (label.textContent !== text) label.textContent = text;
    }
  }

  function syncResolvedTicker(rows) {
    let hasResolved = false;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].state === "resolved") {
        hasResolved = true;
        break;
      }
    }
    if (!hasResolved) {
      stopResolvedTicker();
      return;
    }
    if (resolvedTimer != null) return;
    resolvedTimer = window.setInterval(updateResolvedAgo, 1000);
  }

  function flashCopied(article) {
    article.classList.add("copied");
    const previous = issueCopyTimers.get(article);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      article.classList.remove("copied");
      issueCopyTimers.delete(article);
    }, 1200);
    issueCopyTimers.set(article, timer);
  }

  function copyIssueText(article, row) {
    if (!fmt || typeof fmt.formatIssueForClipboard !== "function") return;
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
    if (!clipboard || typeof clipboard.writeText !== "function") return;
    const text = fmt.formatIssueForClipboard(row);
    clipboard.writeText(text).then(() => {
      if (article.isConnected) flashCopied(article);
    }).catch(() => {});
  }

  function issueRowKey(rows) {
    return rows.map((row) => [
      row && row.id,
      row && row.category,
      row && row.severity,
      row && row.title,
      row && row.evidence,
      row && row.suggestion,
      row && row.state,
      row && row.resolvedAt,
    ].join("\u0001")).join("\u0002");
  }

  function appendIssue(list, row) {
    const article = document.createElement("article");
    const active = row.state !== "resolved";
    article.className = active ? "finding issue is-active" : "finding issue is-resolved";
    article.tabIndex = 0;
    article.setAttribute("role", "listitem");
    if (!active && typeof row.resolvedAt === "number" && Number.isFinite(row.resolvedAt)) {
      article.setAttribute("data-resolved-at", String(row.resolvedAt));
    }
    const sev = document.createElement("span");
    const severity = row.severity === "error" || row.severity === "warn" || row.severity === "info"
      ? row.severity
      : "info";
    sev.className = `sev sev-${severity}`;
    sev.textContent = severity;
    const title = document.createElement("p");
    title.className = "finding-title";
    title.textContent = fmtScalar(row.title);
    const evidence = document.createElement("p");
    evidence.className = "finding-evidence";
    evidence.textContent = fmtScalar(row.evidence);
    const suggestion = document.createElement("p");
    suggestion.className = "finding-suggestion";
    suggestion.textContent = fmtScalar(row.suggestion);
    const state = document.createElement("p");
    state.className = "issue-state";
    if (active) state.textContent = "active";
    else {
      const ago = fmt.formatResolvedAgo(row.resolvedAt, Date.now());
      state.textContent = ago ? `resolved ${ago} ago` : "resolved";
    }
    const copied = document.createElement("span");
    copied.className = "issue-copied";
    copied.textContent = "Copied";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "issue-clear";
    clearBtn.title = "Clear this issue";
    clearBtn.setAttribute("aria-label", "Clear this issue");
    clearBtn.textContent = "×";
    clearBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tracker = issues();
      if (!tracker) return;
      tracker.clear(row.id);
      paintIssues(tracker.rows());
    });
    article.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      copyIssueText(article, row);
    });
    article.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "c" || event.key === "C")) {
        event.preventDefault();
        copyIssueText(article, row);
      }
    });
    article.append(sev, title, evidence, suggestion, state, copied, clearBtn);
    list.appendChild(article);
  }

  function paintIssues(rows) {
    const summary = $("findings-summary");
    if (summary && fmt && typeof fmt.formatIssueSummary === "function") {
      const text = fmt.formatIssueSummary(rows);
      if (summary.textContent !== text) summary.textContent = text;
    }
    const clearResolved = $("clear-resolved");
    if (clearResolved) {
      let hasResolved = false;
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].state === "resolved") {
          hasResolved = true;
          break;
        }
      }
      clearResolved.hidden = !hasResolved;
    }
    syncResolvedTicker(rows);
    const list = $("findings-list");
    if (!list) return;
    const key = issueRowKey(rows);
    if (key === sig.findings) return;
    sig.findings = key;
    list.replaceChildren();
    for (let i = 0; i < rows.length; i += 1) appendIssue(list, rows[i]);
  }

  function renderFindings(payload) {
    const baseline = payload.baseline;
    const note = $("baseline-note");
    if (note) {
      const joins = baseline && typeof baseline.joins === "number" ? baseline.joins : null;
      const needed = baseline && typeof baseline.needed === "number" ? baseline.needed : null;
      if (joins != null && needed != null && joins < needed) {
        const text = `Baseline building (${joins} of ${needed} joins)`;
        note.hidden = false;
        if (note.textContent !== text) note.textContent = text;
      } else {
        note.hidden = true;
      }
    }
    const tracker = issues();
    if (!tracker) return;
    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    paintIssues(tracker.apply(findings, Date.now()));
  }

  function renderJoin(payload, snapshot) {
    const segments = fmt.phaseSegments(snapshot);
    const byKey = new Map();
    for (let i = 0; i < segments.length; i += 1) byKey.set(segments[i].key, segments[i]);
    for (let i = 0; i < PHASE_KEYS.length; i += 1) {
      const key = PHASE_KEYS[i];
      const el = $(`phase-${key}`);
      const row = byKey.get(key);
      if (!el) continue;
      if (!row) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      el.style.flexGrow = String(row.ms > 0 ? row.ms : 1);
      setText(`phase-${key}-ms`, fmt.formatMs(row.ms));
    }
    const ready = snapshot.phases && snapshot.phases.ready;
    const loading = $("phase-loading");
    if (loading) loading.hidden = typeof ready === "number" && Number.isFinite(ready);
    const line = fmt.compareLine(payload.compare, payload.baseline);
    const compare = $("compare-line");
    if (compare && compare.textContent !== line) compare.textContent = line;
  }

  function renderTypes(transfers) {
    const body = $("xfer-types");
    if (!body) return;
    const byType = transfers && transfers.byType && typeof transfers.byType === "object"
      ? transfers.byType
      : {};
    const names = Object.keys(byType).sort();
    const key = names.map((name) => {
      const row = byType[name] || {};
      return [name, row.requests, row.transferBytes, row.cachedRequests].join("\u0001");
    }).join("\u0002");
    if (key === sig.types) return;
    sig.types = key;
    body.replaceChildren();
    if (names.length === 0) {
      const tr = document.createElement("tr");
      for (let i = 0; i < 4; i += 1) {
        const td = document.createElement("td");
        td.textContent = "—";
        tr.appendChild(td);
      }
      body.appendChild(tr);
      return;
    }
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const row = byType[name] || {};
      const tr = document.createElement("tr");
      const cells = [
        name,
        fmtCount(row.requests),
        fmt.formatBytes(row.transferBytes),
        fmtCount(row.cachedRequests),
      ];
      for (let c = 0; c < cells.length; c += 1) {
        const td = document.createElement("td");
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function renderRate(payload, snapshot) {
    const transfers = snapshot.transfers || {};
    const at = typeof payload.updatedAt === "number" ? payload.updatedAt : snapshot.updatedAt;
    const next = { transferBytes: transfers.transferBytes, updatedAt: at };
    const valid = typeof next.transferBytes === "number" && Number.isFinite(next.transferBytes)
      && typeof next.updatedAt === "number" && Number.isFinite(next.updatedAt);
    if (valid && prevSample
      && next.updatedAt === prevSample.updatedAt
      && next.transferBytes === prevSample.transferBytes) {
      return;
    }
    const rate = prevSample ? fmt.rateFromSamples(prevSample, next) : null;
    setText("xfer-rate", fmt.formatRate(rate));
    if (valid && (!prevSample || next.updatedAt >= prevSample.updatedAt)) {
      prevSample = { transferBytes: next.transferBytes, updatedAt: next.updatedAt };
    }
  }

  function renderTransfers(payload, snapshot) {
    const transfers = snapshot.transfers || {};
    setText("xfer-requests", fmtCount(transfers.requests));
    setText("xfer-bytes", fmt.formatBytes(transfers.transferBytes));
    setText("xfer-cache", fmt.formatPercent(transfers.cacheHitRatio));
    setText("xfer-ttfb-p50", fmt.formatMs(transfers.ttfbP50Ms));
    setText("xfer-ttfb-p95", fmt.formatMs(transfers.ttfbP95Ms));
    setText("xfer-slow", fmtCount(transfers.slowDownloads));
    setText("xfer-busy", fmt.formatMs(transfers.busyMs));
    renderRate(payload, snapshot);
    renderTypes(transfers);
  }

  function renderModules(world) {
    const modules = world && Array.isArray(world.modules) ? world.modules : [];
    const count = world && typeof world.activeModuleCount === "number" && Number.isFinite(world.activeModuleCount)
      ? world.activeModuleCount
      : (world ? modules.length : null);
    setText("world-modules-count", count == null ? "—" : String(count));
    const list = $("world-modules");
    if (!list) return;
    const key = modules.map((mod) => `${mod && mod.id}\u0001${mod && mod.version}`).join("\u0002");
    if (key === sig.modules) return;
    sig.modules = key;
    list.replaceChildren();
    for (let i = 0; i < modules.length; i += 1) {
      const mod = modules[i] || {};
      const li = document.createElement("li");
      const id = fmtScalar(mod.id);
      const version = fmtScalar(mod.version);
      li.textContent = version === "—" ? id : `${id} ${version}`;
      list.appendChild(li);
    }
  }

  function renderCountGrid(prefix, keys, source) {
    const row = source && typeof source === "object" ? source : {};
    for (let i = 0; i < keys.length; i += 1) {
      setText(`${prefix}-${keys[i]}`, fmtCount(row[keys[i]]));
    }
  }

  function renderWorld(world) {
    const data = world && typeof world === "object" ? world : {};
    const system = data.system && typeof data.system === "object" ? data.system : {};
    setText("world-foundry", fmtScalar(data.foundryVersion));
    setText("world-generation", fmtScalar(data.generation));
    const systemId = fmtScalar(system.id);
    const systemVersion = fmtScalar(system.version);
    if (systemId === "—" && systemVersion === "—") setText("world-system", "—");
    else if (systemVersion === "—") setText("world-system", systemId);
    else if (systemId === "—") setText("world-system", systemVersion);
    else setText("world-system", `${systemId} ${systemVersion}`);
    setText("world-perf", fmtScalar(data.performanceMode));
    setText("world-fps", fmtFps(data.fps));
    renderModules(world && typeof world === "object" ? world : null);
    const counts = data.documents && typeof data.documents === "object" ? data.documents : {};
    const sizes = data.documentBytes && typeof data.documentBytes === "object" ? data.documentBytes : {};
    for (let i = 0; i < DOC_KEYS.length; i += 1) {
      const key = DOC_KEYS[i];
      setText(`doc-${key}`, fmt.formatDocLine(counts[key], sizes[key]));
    }
    renderCountGrid("scene", SCENE_KEYS, data.scene);
    renderSlowPackages(data);
  }

  function renderSlowPackages(world) {
    const btn = $("world-packages-toggle");
    const list = $("world-packages");
    if (!btn || !list) return;
    const lines = fmt && typeof fmt.slowPackageLines === "function" ? fmt.slowPackageLines(world && world.hookTime) : [];
    if (!lines.length) {
      btn.hidden = true;
      list.hidden = true;
      list.replaceChildren();
      sig.packages = "";
      return;
    }
    btn.hidden = false;
    const key = lines.join("\u0001");
    if (key === sig.packages) return;
    sig.packages = key;
    list.replaceChildren();
    for (let i = 0; i < lines.length; i += 1) {
      const li = document.createElement("li");
      li.textContent = lines[i];
      list.appendChild(li);
    }
  }

  function cacheModeLabel(mode) {
    if (mode === "auto") return "· auto-sized";
    if (typeof mode === "string" && mode) return `· auto-sized, ${mode}`;
    return "";
  }

  function renderResources(payload, snapshot) {
    const resources = snapshot.resources && typeof snapshot.resources === "object" ? snapshot.resources : {};
    const cache = payload.cache && typeof payload.cache === "object" ? payload.cache : {};
    setText("heap-used", fmt.formatBytes(resources.rendererHeapUsedBytes));
    setText("heap-limit", fmt.formatBytes(resources.rendererHeapLimitBytes));
    setBar("heap-bar", ratio(resources.rendererHeapUsedBytes, resources.rendererHeapLimitBytes));
    setText("renderer-cpu", fmtCpu(resources.rendererCpuPercent));
    setText("renderer-mem", fmt.formatBytes(resources.rendererMemoryBytes));
    setText("gpu-cpu", fmtCpu(resources.gpuCpuPercent));
    setText("gpu-mem", fmt.formatBytes(resources.gpuMemoryBytes));
    setText("load-avg", fmtLoad(resources.loadAvg1));
    setText("sysmem-free", fmt.formatBytes(resources.systemFreeBytes));
    setText("sysmem-total", fmt.formatBytes(resources.systemTotalBytes));
    const free = resources.systemFreeBytes;
    const total = resources.systemTotalBytes;
    const used = typeof free === "number" && typeof total === "number" ? total - free : null;
    setBar("sysmem-bar", ratio(used, total));
    const cacheBytes = typeof cache.cacheBytes === "number" ? cache.cacheBytes : resources.cacheBytes;
    const limitBytes = typeof cache.limitBytes === "number" ? cache.limitBytes : resources.cacheLimitBytes;
    setText("cache-used", fmt.formatBytes(cacheBytes));
    setText("cache-limit", fmt.formatBytes(limitBytes));
    const mode = $("cache-mode");
    if (mode) {
      const text = cacheModeLabel(cache.mode);
      mode.hidden = !text;
      if (mode.textContent !== text) mode.textContent = text;
    }
    setBar("cache-bar", ratio(cacheBytes, limitBytes));
    const transfers = snapshot.transfers && typeof snapshot.transfers === "object" ? snapshot.transfers : {};
    setText("cache-read", fmt.formatThroughput(transfers.cacheReadBytes, transfers.cacheReadMs));
  }

  function renderNameCounts(id, sigKey, record) {
    const el = $(id);
    if (!el) return;
    const obj = record && typeof record === "object" ? record : {};
    const names = Object.keys(obj).sort();
    const key = names.map((name) => `${name}\u0001${obj[name]}`).join("\u0002");
    if (key === sig[sigKey]) return;
    sig[sigKey] = key;
    el.replaceChildren();
    if (names.length === 0) {
      el.textContent = "—";
      return;
    }
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const row = document.createElement("div");
      row.className = "name-count";
      const label = document.createElement("span");
      label.textContent = name;
      const value = document.createElement("span");
      value.textContent = fmtCount(obj[name]);
      row.append(label, value);
      el.appendChild(row);
    }
  }

  function renderGpuGone(client) {
    const row = $("gpu-gone-row");
    if (!row) return;
    const value = client.gpuGone;
    if (value == null) {
      row.hidden = true;
      return;
    }
    let text = "";
    if (typeof value === "number" && Number.isFinite(value)) text = fmtCount(value);
    else if (typeof value === "string" && value) text = value;
    else if (typeof value === "object") {
      const count = fmtCount(value.count);
      const reason = typeof value.lastReason === "string" && value.lastReason ? value.lastReason : "";
      text = reason && count !== "—" ? `${count} · ${reason}` : (reason || count);
    }
    if (!text || text === "—") {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    setText("gpu-gone", text);
  }

  function renderClient(snapshot) {
    const client = snapshot.client && typeof snapshot.client === "object" ? snapshot.client : {};
    const gone = client.rendererGone && typeof client.rendererGone === "object" ? client.rendererGone : {};
    const tasks = client.longTasks && typeof client.longTasks === "object" ? client.longTasks : {};
    const pageErrors = client.pageErrors && typeof client.pageErrors === "object" ? client.pageErrors : {};
    const net = snapshot.net && typeof snapshot.net === "object" ? snapshot.net : {};
    const http = net.httpStatus && typeof net.httpStatus === "object" ? net.httpStatus : {};
    setText("crash-count", fmtCount(gone.count));
    setText("crash-reason", fmtScalar(gone.lastReason));
    setText("unresponsive", fmtCount(client.unresponsive));
    setText("long-count", fmtCount(tasks.count));
    setText("long-worst", fmt.formatMs(tasks.worstMs));
    setText("webgl-mode", fmtScalar(client.webglMode));
    const reason = $("webgl-reason");
    if (reason) {
      const text = typeof client.webglFallbackReason === "string" ? client.webglFallbackReason : "";
      reason.hidden = !text;
      if (reason.textContent !== text) reason.textContent = text;
    }
    setText("update-status", fmtScalar(client.updateStatus));
    setText("http-4xx", fmtCount(http["4xx"]));
    setText("http-5xx", fmtCount(http["5xx"]));
    setText("clock-skew", fmt.formatMs(net.clockSkewMs));
    renderGpuGone(client);
    renderNameCounts("page-errors", "pageErrors", pageErrors.byName);
    renderNameCounts("net-errors", "netErrors", net.errors);
  }

  function renderSystem(system) {
    if (!system || typeof system !== "object") {
      setText("sys-os", "—");
      setText("sys-cpu", "—");
      setText("sys-mem", "—");
      setText("sys-gpu", "—");
      setText("sys-displays", "—");
      setText("sys-versions", "—");
      return;
    }
    let os = "—";
    if (typeof system.osPrettyName === "string" && system.osPrettyName) os = system.osPrettyName;
    else {
      const bits = [system.platform, system.osRelease, system.osVersion].filter((part) => (
        typeof part === "string" && part
      ));
      if (bits.length) os = bits.join(" ");
    }
    setText("sys-os", os);
    const cpuParts = [];
    if (typeof system.cpuModel === "string" && system.cpuModel) cpuParts.push(system.cpuModel);
    if (typeof system.cpuCount === "number" && Number.isFinite(system.cpuCount)) {
      cpuParts.push(`${fmtCount(system.cpuCount)} cores`);
    }
    if (typeof system.loadAvg1 === "number" && Number.isFinite(system.loadAvg1)) {
      cpuParts.push(`load ${system.loadAvg1.toFixed(2)}`);
    }
    setText("sys-cpu", cpuParts.length ? cpuParts.join(" · ") : "—");
    const memParts = [];
    if (typeof system.memTotalBytes === "number") memParts.push(`${fmt.formatBytes(system.memTotalBytes)} total`);
    if (typeof system.memAvailableBytes === "number") {
      memParts.push(`${fmt.formatBytes(system.memAvailableBytes)} available`);
    }
    if (typeof system.memFreeBytes === "number") memParts.push(`${fmt.formatBytes(system.memFreeBytes)} free`);
    setText("sys-mem", memParts.length ? memParts.join(" · ") : "—");
    const gpu = system.gpu && typeof system.gpu === "object" ? system.gpu : null;
    if (!gpu) setText("sys-gpu", "—");
    else {
      const device = [gpu.vendor, gpu.device].filter((part) => typeof part === "string" && part).join(" ");
      const driver = [gpu.driverVendor, gpu.driverVersion].filter((part) => typeof part === "string" && part).join(" ");
      const parts = [];
      if (device) parts.push(device);
      if (driver) parts.push(driver);
      if (typeof gpu.glRenderer === "string" && gpu.glRenderer && gpu.glRenderer !== gpu.device) {
        parts.push(gpu.glRenderer);
      }
      setText("sys-gpu", parts.length ? parts.join(" · ") : "—");
    }
    const displays = Array.isArray(system.displays) ? system.displays : [];
    if (displays.length === 0) setText("sys-displays", "—");
    else {
      const text = displays.map((display) => {
        const width = fmtCount(display && display.width);
        const height = fmtCount(display && display.height);
        const scale = display && typeof display.scaleFactor === "number" && Number.isFinite(display.scaleFactor)
          ? ` @${display.scaleFactor}x`
          : "";
        return `${width}×${height}${scale}`;
      }).join(", ");
      setText("sys-displays", text);
    }
    const versions = [];
    if (typeof system.clientVersion === "string" && system.clientVersion) versions.push(`client ${system.clientVersion}`);
    if (typeof system.electronVersion === "string" && system.electronVersion) versions.push(`Electron ${system.electronVersion}`);
    if (typeof system.chromeVersion === "string" && system.chromeVersion) versions.push(`Chromium ${system.chromeVersion}`);
    if (typeof system.nodeVersion === "string" && system.nodeVersion) versions.push(`Node ${system.nodeVersion}`);
    setText("sys-versions", versions.length ? versions.join(" · ") : "—");
  }

  function renderLive(live) {
    if (!live || typeof live.sampling !== "boolean") return;
    sawLive = true;
    const box = $("live-sampling");
    if (!box || document.activeElement === box) return;
    if (box.checked !== live.sampling) box.checked = live.sampling;
  }

  function paintBadUrls(entries) {
    const list = $("bad-urls-list");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    const rows = Array.isArray(entries) ? entries : [];
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "bad-url-empty";
      empty.textContent = "No failing files";
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < rows.length; i += 1) {
      const view = fmt && typeof fmt.formatBadUrlLine === "function" ? fmt.formatBadUrlLine(rows[i]) : null;
      if (!view) continue;
      const block = document.createElement("div");
      block.className = "bad-url-entry";
      const line = document.createElement("div");
      line.className = "bad-url-line";
      line.textContent = view.line;
      if (view.title) line.title = view.title;
      const refs = document.createElement("div");
      refs.className = "bad-url-refs";
      refs.textContent = view.refs;
      if (view.refs) refs.title = view.refs;
      block.appendChild(line);
      block.appendChild(refs);
      list.appendChild(block);
    }
  }

  async function loadBadUrls() {
    const gen = ++badFetchGen;
    const api = window.flcStats;
    if (!serverId || !api || typeof api.badUrls !== "function") return;
    try {
      const data = await api.badUrls(serverId);
      if (gen !== badFetchGen || !badPanelOpen) return;
      paintBadUrls(data && data.entries);
    } catch {
      if (gen !== badFetchGen || !badPanelOpen) return;
      showToast("Could not load failing files", "error");
    }
  }

  function setBadPanel(open) {
    badPanelOpen = open === true;
    const panel = $("bad-urls-panel");
    const btn = $("btn-bad-urls");
    if (panel) panel.hidden = !badPanelOpen;
    if (btn) btn.setAttribute("aria-expanded", badPanelOpen ? "true" : "false");
    if (!badPanelOpen) badFetchGen += 1;
  }

  function renderBadUrlCount(data) {
    if (!data || typeof data.badUrlCount !== "number" || !Number.isFinite(data.badUrlCount)) return;
    const next = data.badUrlCount > 0 ? Math.floor(data.badUrlCount) : 0;
    const changed = badUrlCount !== null && next !== badUrlCount;
    badUrlCount = next;
    const btn = $("btn-bad-urls");
    if (btn && fmt && typeof fmt.formatBadUrlButton === "function") {
      btn.disabled = next === 0;
      btn.textContent = fmt.formatBadUrlButton(next);
    }
    if (badPanelOpen && changed) loadBadUrls();
  }

  function render(payload) {
    if (!fmt) return;
    const data = payload && typeof payload === "object" ? payload : {};
    if (data.serverId && serverId && data.serverId !== serverId) return;
    const snapshot = data.snapshot && typeof data.snapshot === "object" ? data.snapshot : {};
    renderSync(snapshot.sync);
    renderFindings(data);
    renderJoin(data, snapshot);
    renderTransfers(data, snapshot);
    renderWorld(snapshot.world);
    renderResources(data, snapshot);
    renderClient(snapshot);
    renderSystem(data.system);
    renderLive(data.live);
    renderBadUrlCount(data);
  }

  function closeConfirms() {
    const clear = $("confirm-clear");
    const refresh = $("confirm-refresh");
    const clearBtn = $("btn-clear");
    const refreshBtn = $("btn-refresh");
    if (clear) clear.hidden = true;
    if (refresh) refresh.hidden = true;
    if (clearBtn) clearBtn.hidden = false;
    if (refreshBtn) refreshBtn.hidden = false;
  }

  function setEmailPanel(open) {
    const panel = $("email-admin-panel");
    const editBtn = $("btn-email-admin-edit");
    const show = open === true;
    if (panel) panel.hidden = !show;
    if (editBtn) editBtn.setAttribute("aria-expanded", show ? "true" : "false");
    if (!show) emailThenSend = false;
  }

  async function loadEmailPanel(thenSend) {
    const api = window.flcStats;
    const input = $("email-admin-input");
    const clearBtn = $("email-admin-clear");
    if (!serverId || !api || typeof api.getAdminEmail !== "function" || !input) return;
    let email = "";
    let saved = "";
    try {
      const info = await api.getAdminEmail(serverId);
      email = info && typeof info.email === "string" ? info.email : "";
      saved = info && typeof info.saved === "string" ? info.saved : "";
    } catch {
      showToast("Could not load the admin email", "error");
    }
    input.value = email;
    if (clearBtn) clearBtn.hidden = !saved;
    setEmailPanel(true);
    emailThenSend = thenSend === true;
    input.focus();
  }

  async function sendAdminEmail() {
    const api = window.flcStats;
    const btn = $("btn-email-admin");
    if (!serverId || !api || typeof api.emailAdmin !== "function") return;
    if (btn) btn.disabled = true;
    try {
      const result = await api.emailAdmin(serverId);
      if (result && result.ok) {
        setEmailPanel(false);
        showToast("Mail draft opened. The full report is on the clipboard.");
        return;
      }
      if (result && result.reason === "need-email") {
        await loadEmailPanel(true);
        return;
      }
      showToast("Could not open the mail client", "error");
    } catch {
      showToast("Could not open the mail client", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveAdminEmail() {
    const api = window.flcStats;
    const input = $("email-admin-input");
    const saveBtn = $("email-admin-save");
    if (!serverId || !api || typeof api.setAdminEmail !== "function" || !input) return;
    const value = input.value.trim();
    if (!value) {
      showToast("Enter an admin email", "warn");
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    try {
      const result = await api.setAdminEmail(serverId, value);
      if (!result || !result.ok) {
        if (result && result.reason === "invalid-email") showToast("That email address is not valid", "warn");
        else if (result && result.reason === "no-profile") showToast("This server has no saved profile for an admin email", "warn");
        else showToast("Could not save the admin email", "error");
        return;
      }
      const sendAfter = emailThenSend;
      setEmailPanel(false);
      if (sendAfter) await sendAdminEmail();
      else showToast("Admin email saved");
    } catch {
      showToast("Could not save the admin email", "error");
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function clearAdminEmail() {
    const api = window.flcStats;
    const input = $("email-admin-input");
    const clearBtn = $("email-admin-clear");
    if (!serverId || !api || typeof api.setAdminEmail !== "function") return;
    if (clearBtn) clearBtn.disabled = true;
    try {
      const result = await api.setAdminEmail(serverId, "");
      if (!result || !result.ok) {
        showToast("Could not clear the admin email", "error");
        return;
      }
      let email = "";
      let saved = "";
      if (typeof api.getAdminEmail === "function") {
        try {
          const info = await api.getAdminEmail(serverId);
          email = info && typeof info.email === "string" ? info.email : "";
          saved = info && typeof info.saved === "string" ? info.saved : "";
        } catch {
          email = "";
          saved = "";
        }
      }
      if (input) input.value = email;
      if (clearBtn) clearBtn.hidden = !saved;
      showToast("Admin email cleared");
    } catch {
      showToast("Could not clear the admin email", "error");
    } finally {
      if (clearBtn) clearBtn.disabled = false;
    }
  }

  function bindActions() {
    const clearResolvedBtn = $("clear-resolved");
    if (clearResolvedBtn) {
      clearResolvedBtn.addEventListener("click", () => {
        const tracker = issues();
        if (!tracker) return;
        tracker.clearResolved();
        paintIssues(tracker.rows());
      });
    }

    const modulesBtn = $("world-modules-toggle");
    if (modulesBtn) {
      modulesBtn.addEventListener("click", () => {
        const list = $("world-modules");
        if (!list) return;
        const open = list.hidden;
        list.hidden = !open;
        modulesBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    const packagesBtn = $("world-packages-toggle");
    if (packagesBtn) {
      packagesBtn.addEventListener("click", () => {
        const list = $("world-packages");
        if (!list) return;
        const open = list.hidden;
        list.hidden = !open;
        packagesBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }

    const live = $("live-sampling");
    if (live) {
      live.addEventListener("change", () => {
        const api = window.flcStats;
        if (!serverId || !api || typeof api.setSampling !== "function") return;
        const enabled = live.checked;
        api.setSampling(serverId, enabled).catch(() => {
          live.checked = !enabled;
          showToast("Could not change live sampling", "error");
        });
      });
    }

    const badBtn = $("btn-bad-urls");
    if (badBtn) {
      badBtn.addEventListener("click", () => {
        if (badBtn.disabled) return;
        const open = !badPanelOpen;
        setBadPanel(open);
        if (open) loadBadUrls();
      });
    }
    const emailBtn = $("btn-email-admin");
    if (emailBtn) emailBtn.addEventListener("click", () => { sendAdminEmail(); });
    const emailEdit = $("btn-email-admin-edit");
    if (emailEdit) {
      emailEdit.addEventListener("click", () => {
        const panel = $("email-admin-panel");
        if (panel && !panel.hidden) {
          setEmailPanel(false);
          return;
        }
        loadEmailPanel(false);
      });
    }
    const emailSave = $("email-admin-save");
    if (emailSave) emailSave.addEventListener("click", () => { saveAdminEmail(); });
    const emailClear = $("email-admin-clear");
    if (emailClear) emailClear.addEventListener("click", () => { clearAdminEmail(); });
    const emailCancel = $("email-admin-cancel");
    if (emailCancel) emailCancel.addEventListener("click", () => setEmailPanel(false));
    const emailInput = $("email-admin-input");
    if (emailInput) {
      emailInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          saveAdminEmail();
        }
      });
    }
    const badClose = $("bad-urls-close");
    if (badClose) badClose.addEventListener("click", () => setBadPanel(false));
    const badCopy = $("bad-urls-copy");
    if (badCopy) {
      badCopy.addEventListener("click", async () => {
        const api = window.flcStats;
        if (!serverId || !api || typeof api.copyBadUrls !== "function") return;
        badCopy.disabled = true;
        try {
          const result = await api.copyBadUrls(serverId);
          const n = result && typeof result.count === "number" && Number.isFinite(result.count)
            ? Math.max(0, Math.floor(result.count))
            : 0;
          if (result && result.ok) {
            badCopy.textContent = `Copied ${n}`;
            if (badCopyTimer) window.clearTimeout(badCopyTimer);
            badCopyTimer = window.setTimeout(() => {
              badCopy.textContent = "Copy";
              badCopyTimer = null;
            }, 1600);
          } else {
            showToast("Could not copy failing files", "error");
          }
        } catch {
          showToast("Could not copy failing files", "error");
        } finally {
          badCopy.disabled = false;
        }
      });
    }

    const copyBtn = $("btn-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const api = window.flcStats;
        if (!serverId || !api) return;
        copyBtn.disabled = true;
        try {
          const addresses = $("net-trace-addresses");
          const result = await api.copyReport(serverId, {
            includeAddresses: Boolean(addresses && addresses.checked),
          });
          if (result && result.ok) showToast(copiedToast(result.bytes));
          else showToast("Could not copy troubleshooting info", "error");
        } catch {
          showToast("Could not copy troubleshooting info", "error");
        } finally {
          copyBtn.disabled = false;
        }
      });
    }

    const saveBtn = $("btn-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const api = window.flcStats;
        if (!serverId || !api) return;
        saveBtn.disabled = true;
        try {
          const result = await api.saveDiagnostics(serverId);
          if (!result || result.canceled) return;
          if (result.ok) showToast("Diagnostics saved");
          else showToast(safeError(result.error) || "Could not save diagnostics", "error");
        } catch {
          showToast("Could not save diagnostics", "error");
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const clearBtn = $("btn-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        closeConfirms();
        clearBtn.hidden = true;
        const confirm = $("confirm-clear");
        if (confirm) confirm.hidden = false;
      });
    }
    const clearNo = $("confirm-clear-no");
    if (clearNo) clearNo.addEventListener("click", closeConfirms);
    const clearYes = $("confirm-clear-yes");
    if (clearYes) {
      clearYes.addEventListener("click", async () => {
        const api = window.flcStats;
        if (!serverId || !api) return;
        clearYes.disabled = true;
        try {
          const cleared = await api.clearCache(serverId);
          closeConfirms();
          if (typeof cleared === "number" && Number.isFinite(cleared)) {
            showToast(`Cleared ${fmt.formatBytes(cleared)}`);
          } else {
            showToast("Could not clear this server's cache", "error");
          }
        } catch {
          showToast("Could not clear this server's cache", "error");
        } finally {
          clearYes.disabled = false;
        }
      });
    }

    const refreshBtn = $("btn-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        closeConfirms();
        refreshBtn.hidden = true;
        const confirm = $("confirm-refresh");
        if (confirm) confirm.hidden = false;
      });
    }
    const refreshNo = $("confirm-refresh-no");
    if (refreshNo) refreshNo.addEventListener("click", closeConfirms);
    const refreshYes = $("confirm-refresh-yes");
    if (refreshYes) {
      refreshYes.addEventListener("click", async () => {
        const api = window.flcStats;
        if (!serverId || !api) return;
        refreshYes.disabled = true;
        try {
          const result = await api.fullRefresh(serverId);
          closeConfirms();
          if (result && result.ok) {
            showToast("Full refresh started");
            paintNetTrace(null);
          } else showToast("Could not start a full refresh", "error");
        } catch {
          showToast("Could not start a full refresh", "error");
        } finally {
          refreshYes.disabled = false;
        }
      });
    }
    bindNetTrace();
  }

  function includeHopAddresses() {
    const box = $("net-trace-addresses");
    return Boolean(box && box.checked);
  }

  function paintNetTrace(view) {
    const summary = $("net-trace-summary");
    const output = $("net-trace-output");
    const copy = $("net-trace-copy");
    const report = view && view.report ? view.report : null;
    const text = view && typeof view.text === "string" ? view.text : "";
    if (summary) {
      summary.textContent = fmt && typeof fmt.formatNetTraceSummary === "function"
        ? fmt.formatNetTraceSummary(report)
        : (report ? "trace ready" : "not run");
    }
    if (output) output.textContent = text;
    if (copy) copy.disabled = !text;
  }

  async function loadNetTrace() {
    const api = window.flcStats && window.flcStats.netTrace;
    if (!serverId || !api || typeof api.get !== "function") return;
    try {
      paintNetTrace(await api.get(serverId, { includeAddresses: includeHopAddresses() }));
    } catch {
      /* keep the last view */
    }
  }

  function bindNetTrace() {
    const toggle = $("net-trace-toggle");
    const body = $("net-trace-body");
    if (toggle && body) {
      toggle.addEventListener("click", () => {
        const open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    const runBtn = $("net-trace-run");
    if (runBtn) {
      runBtn.addEventListener("click", async () => {
        const api = window.flcStats && window.flcStats.netTrace;
        if (!serverId || !api || typeof api.run !== "function") return;
        if (netRunning) {
          if (typeof api.cancel === "function") {
            try { await api.cancel(serverId); } catch { /* the run settles on its own */ }
          }
          return;
        }
        netRunning = true;
        runBtn.textContent = "Cancel";
        const progress = $("net-trace-progress");
        if (progress) {
          progress.hidden = false;
          progress.textContent = "Starting";
        }
        try {
          const result = await api.run(serverId);
          if (result && result.ok) {
            paintNetTrace(result);
            if (includeHopAddresses()) await loadNetTrace();
          } else if (result && result.reason === "busy") {
            showToast("A network trace is already running", "error");
          } else if (!result || result.reason !== "cancelled") {
            showToast("Could not run the network trace", "error");
          }
        } catch {
          showToast("Could not run the network trace", "error");
        } finally {
          netRunning = false;
          runBtn.textContent = "Run trace (3 sweeps)";
          if (progress) progress.hidden = true;
        }
      });
    }
    const copy = $("net-trace-copy");
    if (copy) {
      copy.addEventListener("click", async () => {
        const api = window.flcStats && window.flcStats.netTrace;
        if (!serverId || !api || typeof api.copy !== "function") return;
        copy.disabled = true;
        try {
          const result = await api.copy(serverId, { includeAddresses: includeHopAddresses() });
          if (result && result.ok) showToast("Network trace copied");
          else showToast("Could not copy the network trace", "error");
        } catch {
          showToast("Could not copy the network trace", "error");
        } finally {
          const output = $("net-trace-output");
          copy.disabled = !(output && output.textContent);
        }
      });
    }
    const box = $("net-trace-addresses");
    if (box) box.addEventListener("change", () => { loadNetTrace(); });
  }

  async function init() {
    bindActions();
    if (!fmt || !window.flcStats) {
      showToast("Statistics are unavailable", "error");
      return;
    }
    let ctx = null;
    try {
      ctx = await window.flcStats.getContext();
    } catch {
      showToast("Statistics are unavailable", "error");
      return;
    }
    serverId = ctx && typeof ctx.serverId === "string" ? ctx.serverId : "";
    const label = ctx && typeof ctx.label === "string" && ctx.label ? ctx.label : "—";
    document.title = label === "—" ? "World Statistics" : `${label} — World Statistics`;
    const labelEl = $("stats-label");
    if (labelEl) labelEl.textContent = label;
    if (!serverId) {
      showToast("Statistics are unavailable", "error");
      return;
    }
    if (typeof window.flcStats.listIssueAcks === "function") {
      try {
        const listed = await window.flcStats.listIssueAcks(serverId);
        if (Array.isArray(listed)) ackedIds = listed.filter((id) => typeof id === "string" && id);
      } catch {
        ackedIds = [];
      }
    }
    let samplingOn = false;
    try {
      await window.flcStats.setSampling(serverId, true);
      samplingOn = true;
    } catch {
      showToast("Live sampling could not start", "warn");
    }
    try {
      render(await window.flcStats.getSnapshot(serverId));
    } catch {
      showToast("Could not load statistics", "error");
    }
    const live = $("live-sampling");
    if (live && samplingOn) live.checked = true;
    else if (live && !samplingOn && !sawLive) live.checked = false;
    unsub = window.flcStats.onUpdate((payload) => {
      render(payload);
    });
    const netApi = window.flcStats.netTrace;
    if (netApi && typeof netApi.onProgress === "function") {
      netUnsub = netApi.onProgress((payload) => {
        if (!payload || payload.serverId !== serverId) return;
        const progress = $("net-trace-progress");
        if (!progress) return;
        progress.hidden = false;
        progress.textContent = payload.label || "Working";
      });
    }
    await loadNetTrace();
  }

  window.addEventListener("beforeunload", () => {
    stopResolvedTicker();
    if (typeof unsub === "function") unsub();
    if (typeof netUnsub === "function") netUnsub();
    if (serverId && window.flcStats && typeof window.flcStats.setSampling === "function") {
      window.flcStats.setSampling(serverId, false).catch(() => {});
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
