"use strict";

/**
 * Pure display helpers for the World Statistics window.
 * Browser pages read window.flcStatsFormat. Node tests read module.exports.
 */

// Sequential wall-clock spans of one join; fetching time overlaps these and is
// shown in the Transfers section instead.
const PHASES = [
  { key: "login", label: "login", field: "loginMs" },
  { key: "pageLoad", label: "page load", field: "pageLoadMs" },
  { key: "worldData", label: "world data", field: "worldDataMs" },
  { key: "init", label: "init", field: "initMs" },
  { key: "i18n", label: "i18n", field: "i18nMs" },
  { key: "setup", label: "setup", field: "setupMs" },
  { key: "canvas", label: "canvas", field: "canvasMs" },
];

const SYNC_CAUSE = {
  "local-offline": "this computer is offline",
  "server-unreachable": "server unreachable",
  "socket-stalled": "connected, but no data from server",
};

function trimDecimal(text) {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  let abs = Math.abs(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (abs >= 1024 && index < units.length - 1) {
    abs /= 1024;
    index += 1;
  }
  if (index === 0) {
    const rounded = Math.round(abs);
    return `${rounded === 0 ? "" : sign}${rounded} B`;
  }
  const text = trimDecimal(abs.toFixed(1));
  return `${text === "0" ? "" : sign}${text} ${units[index]}`;
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) {
    const rounded = Math.round(abs);
    return `${rounded === 0 ? "" : sign}${rounded} ms`;
  }
  const text = trimDecimal((abs / 1000).toFixed(1));
  return `${text === "0" ? "" : sign}${text} s`;
}

/**
 * @param {number | null | undefined} value ratio 0..1
 * @returns {string}
 */
function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${trimDecimal((value * 100).toFixed(1))}%`;
}

/**
 * @param {number | null | undefined} bytesPerSec
 * @returns {string}
 */
function formatRate(bytesPerSec) {
  if (typeof bytesPerSec !== "number" || !Number.isFinite(bytesPerSec)) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * @param {object | null | undefined} snapshot
 * @returns {Array<{ key: string, label: string, ms: number, fraction: number }>}
 */
function phaseSegments(snapshot) {
  const durations = snapshot && snapshot.durations && typeof snapshot.durations === "object"
    ? snapshot.durations
    : null;
  if (!durations) return [];
  const rows = [];
  for (let i = 0; i < PHASES.length; i += 1) {
    const phase = PHASES[i];
    const ms = durations[phase.field];
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
    rows.push({ key: phase.key, label: phase.label, ms });
  }
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    ms: row.ms,
    fraction: total > 0 ? row.ms / total : 0,
  }));
}

/**
 * @param {object | null | undefined} sync
 * @returns {{ state: 'ok' | 'bad' | 'unknown', text: string, cause: string }}
 */
function syncLabel(sync) {
  const state = sync && sync.state;
  if (state === "synced") return { state: "ok", text: "Synced", cause: "" };
  if (state === "out-of-sync") {
    const cause = sync && Object.prototype.hasOwnProperty.call(SYNC_CAUSE, sync.cause)
      ? SYNC_CAUSE[sync.cause]
      : "";
    return { state: "bad", text: "Out of sync", cause };
  }
  return { state: "unknown", text: "Unknown", cause: "" };
}

/**
 * Lower ranks sort first: error, warn, info, then anything else.
 * @param {string} severity
 * @returns {number}
 */
function severityOrder(severity) {
  if (severity === "error") return 0;
  if (severity === "warn") return 1;
  if (severity === "info") return 2;
  return 3;
}

/**
 * Amber over 70%, red over 85%. The boundary itself stays in the lower band.
 * @param {number | null | undefined} ratio
 * @returns {'ok' | 'warn' | 'bad'}
 */
function barLevel(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "ok";
  if (ratio > 0.85) return "bad";
  if (ratio > 0.7) return "warn";
  return "ok";
}

/**
 * @param {object | null | undefined} sample
 * @returns {{ bytes: number, at: number } | null}
 */
function readSample(sample) {
  if (!sample || typeof sample !== "object") return null;
  let bytes = sample.transferBytes;
  let at = sample.updatedAt;
  const snapshot = sample.snapshot;
  if (typeof bytes !== "number" && snapshot && snapshot.transfers) {
    bytes = snapshot.transfers.transferBytes;
  }
  if (typeof at !== "number" && snapshot && typeof snapshot.updatedAt === "number") {
    at = snapshot.updatedAt;
  }
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { bytes, at };
}

/**
 * @param {object | null | undefined} prev
 * @param {object | null | undefined} next
 * @returns {number | null} bytes per second
 */
function rateFromSamples(prev, next) {
  const older = readSample(prev);
  const newer = readSample(next);
  if (!older || !newer) return null;
  const seconds = (newer.at - older.at) / 1000;
  if (!(seconds > 0)) return null;
  const delta = newer.bytes - older.bytes;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta / seconds;
}

/**
 * @param {object | null | undefined} baseline
 * @returns {boolean}
 */
function baselineReady(baseline) {
  if (!baseline || typeof baseline !== "object") return true;
  if (typeof baseline.joins === "number" && typeof baseline.needed === "number") {
    return baseline.joins >= baseline.needed;
  }
  return true;
}

/**
 * @param {unknown} url
 * @returns {string}
 */
function badUrlPathname(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const parsed = new URL(url);
    let path = parsed.pathname || "/";
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the encoded pathname */
    }
    return path || "/";
  } catch {
    const cut = url.split("?")[0].split("#")[0];
    const slash = cut.indexOf("/");
    const path = slash >= 0 ? cut.slice(slash) : cut;
    return path.length > 2048 ? path.slice(0, 2048) : path;
  }
}

/**
 * Footer button label. Count is omitted at zero.
 * @param {unknown} count
 * @returns {string}
 */
function formatBadUrlButton(count) {
  const n = typeof count === "number" && Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : 0;
  return n > 0 ? `Bad URLs · ${n}` : "Bad URLs";
}

/**
 * Two display lines for one failing file. `title` is the full URL for hover.
 * @param {object | null | undefined} entry
 * @returns {{ line: string, title: string, refs: string }}
 */
function formatBadUrlLine(entry) {
  const row = entry && typeof entry === "object" ? entry : {};
  let status = "—";
  if (typeof row.status === "number" && Number.isFinite(row.status)) status = String(row.status);
  else if (typeof row.error === "string" && row.error.trim()) status = row.error.replace(/[\r\n]+/g, " ").trim();
  const type = typeof row.resourceType === "string" && row.resourceType.trim()
    ? row.resourceType.replace(/[\r\n]+/g, " ").trim()
    : "—";
  const url = typeof row.url === "string" ? row.url : "";
  const path = badUrlPathname(url) || "—";
  const refs = Array.isArray(row.refs)
    ? row.refs
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 5)
      .map((item) => item.replace(/[\r\n]+/g, " ").trim())
    : [];
  const refText = refs.length
    ? refs.join(", ")
    : "(no in-world reference found; may be CSS/module asset)";
  return {
    line: `${status} ${type}  ${path}`,
    title: url.length > 2048 ? url.slice(0, 2048) : url,
    refs: `referenced by: ${refText}`,
  };
}

/**
 * @param {object | null | undefined} compare
 * @param {object | null | undefined} baseline
 * @returns {string}
 */
function compareLine(compare, baseline) {
  const row = compare && typeof compare === "object" ? compare : {};
  const typical = baselineReady(baseline) ? row.typicalMs : null;
  return `this join ${formatMs(row.thisMs)} · typical ${formatMs(typical)} · first ${formatMs(row.firstMs)} · fastest ${formatMs(row.fastestMs)}`;
}

function clipText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
function formatIssueForClipboard(row) {
  const source = row && typeof row === "object" ? row : {};
  const severity = clipText(source.severity).toUpperCase();
  const status = source.state === "resolved" ? "resolved" : "active";
  return `[${severity}] ${clipText(source.category)} — ${clipText(source.title)}\nevidence: ${clipText(source.evidence)}\nsuggestion: ${clipText(source.suggestion)}\nstatus: ${status}`;
}

/**
 * @param {Array<{ state?: string }> | null | undefined} rows
 * @returns {string}
 */
function formatIssueSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let active = 0;
  let resolved = 0;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!row || typeof row !== "object") continue;
    if (row.state === "resolved") resolved += 1;
    else if (row.state === "active") active += 1;
  }
  if (active === 0 && resolved === 0) return "No issues detected";
  return `${active} active · ${resolved} resolved`;
}

/**
 * Elapsed time since a finding resolved, as m:ss or h:mm:ss.
 * @param {number | null | undefined} resolvedAt
 * @param {number | null | undefined} now
 * @returns {string}
 */
function formatResolvedAgo(resolvedAt, now) {
  if (typeof resolvedAt !== "number" || !Number.isFinite(resolvedAt)) return "";
  if (typeof now !== "number" || !Number.isFinite(now)) return "";
  let seconds = Math.floor((now - resolvedAt) / 1000);
  if (seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const ss = String(secs).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

function issueText(value) {
  return typeof value === "string" ? value : "";
}

function copyIssueRow(row) {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    evidence: row.evidence,
    suggestion: row.suggestion,
    state: row.state,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
  };
}

function compareIssueRows(a, b) {
  const aActive = a.state === "active";
  const bActive = b.state === "active";
  if (aActive !== bActive) return aActive ? -1 : 1;
  if (aActive) {
    const bySeverity = severityOrder(a.severity) - severityOrder(b.severity);
    if (bySeverity !== 0) return bySeverity;
  } else {
    const aAt = typeof a.resolvedAt === "number" ? a.resolvedAt : 0;
    const bAt = typeof b.resolvedAt === "number" ? b.resolvedAt : 0;
    if (aAt !== bAt) return bAt - aAt;
  }
  if (a.title < b.title) return -1;
  if (a.title > b.title) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Remembers active and resolved findings across payloads.
 * Clearing an active id hides it until that id is absent and then detected again.
 * @param {{ now?: () => number }} [options]
 * @returns {{
 *   apply: (findings: object[] | null | undefined, at?: number) => object[],
 *   clear: (id: string) => void,
 *   clearResolved: () => void,
 *   rows: () => object[],
 * }}
 */
function createIssueTracker(options) {
  const clock = options && typeof options.now === "function" ? options.now : () => Date.now();
  const byId = new Map();
  const dismissed = new Set();

  function stamp(at) {
    if (typeof at === "number" && Number.isFinite(at)) return at;
    const value = clock();
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function ordered() {
    const rows = [];
    const values = Array.from(byId.values());
    for (let i = 0; i < values.length; i += 1) rows.push(copyIssueRow(values[i]));
    rows.sort(compareIssueRows);
    return rows;
  }

  function indexFindings(findings) {
    const present = new Map();
    const list = Array.isArray(findings) ? findings : [];
    for (let i = 0; i < list.length; i += 1) {
      const finding = list[i];
      if (!finding || typeof finding !== "object") continue;
      const id = finding.id;
      if (typeof id !== "string" || !id) continue;
      present.set(id, {
        id,
        category: issueText(finding.category),
        severity: issueText(finding.severity),
        title: issueText(finding.title),
        evidence: issueText(finding.evidence),
        suggestion: issueText(finding.suggestion),
      });
    }
    return present;
  }

  function apply(findings, at) {
    const when = stamp(at);
    const present = indexFindings(findings);
    const dismissedIds = Array.from(dismissed);
    for (let i = 0; i < dismissedIds.length; i += 1) {
      if (!present.has(dismissedIds[i])) dismissed.delete(dismissedIds[i]);
    }
    const presentIds = Array.from(present.keys());
    for (let i = 0; i < presentIds.length; i += 1) {
      const id = presentIds[i];
      if (dismissed.has(id)) continue;
      const finding = present.get(id);
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          id,
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          evidence: finding.evidence,
          suggestion: finding.suggestion,
          state: "active",
          firstSeenAt: when,
          lastSeenAt: when,
          resolvedAt: null,
        });
        continue;
      }
      existing.category = finding.category;
      existing.severity = finding.severity;
      existing.title = finding.title;
      existing.evidence = finding.evidence;
      existing.suggestion = finding.suggestion;
      existing.state = "active";
      existing.lastSeenAt = when;
      existing.resolvedAt = null;
    }
    const known = Array.from(byId.keys());
    for (let i = 0; i < known.length; i += 1) {
      const id = known[i];
      if (present.has(id)) continue;
      const row = byId.get(id);
      if (row && row.state === "active") {
        row.state = "resolved";
        row.resolvedAt = when;
      }
    }
    return ordered();
  }

  function clear(id) {
    if (typeof id !== "string" || !id) return;
    const row = byId.get(id);
    if (!row) return;
    byId.delete(id);
    if (row.state === "active") dismissed.add(id);
  }

  function clearResolved() {
    const ids = Array.from(byId.keys());
    for (let i = 0; i < ids.length; i += 1) {
      const row = byId.get(ids[i]);
      if (row && row.state === "resolved") byId.delete(ids[i]);
    }
  }

  return {
    apply,
    clear,
    clearResolved,
    rows: ordered,
  };
}

/**
 * Header latency: the floor (fastest real RTT or ack) with an optional server ack.
 * @param {object | null | undefined} sync
 * @returns {string}
 */
function syncLatencyLabel(sync) {
  const row = sync && typeof sync === "object" ? sync : {};
  const floor = typeof row.latencyFloorMs === "number" && Number.isFinite(row.latencyFloorMs) ? row.latencyFloorMs : null;
  const rtt = typeof row.rttMs === "number" && Number.isFinite(row.rttMs) ? row.rttMs : null;
  const latency = floor != null ? floor : rtt;
  const ack = typeof row.ackP95Ms === "number" && Number.isFinite(row.ackP95Ms) ? row.ackP95Ms : null;
  if (latency == null && ack == null) return "—";
  const parts = [];
  if (latency != null) parts.push(`latency ~${formatMs(latency)}`);
  if (ack != null) parts.push(`server ack p95 ${formatMs(ack)}`);
  return parts.join(" · ");
}

function formatDocLine(count, bytes) {
  const hasCount = typeof count === "number" && Number.isFinite(count);
  const hasBytes = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0;
  if (!hasCount && !hasBytes) return "—";
  const countText = hasCount ? Math.round(count).toLocaleString("en-US") : "—";
  if (!hasBytes) return countText;
  return `${countText} · ${formatBytes(bytes)}`;
}

function formatThroughput(bytes, ms) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  const perSec = bytes / (ms / 1000);
  return `cache served ${formatBytes(bytes)} in ${formatMs(ms)} (${formatRate(perSec)})`;
}

function formatAgo(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  return `${formatMs(ms)} ago`;
}

function formatPerMin(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  const text = trimDecimal(Math.abs(rounded).toFixed(1));
  return `${rounded < 0 ? "-" : ""}${text}/min`;
}

function formatLastRequest(sync) {
  const req = sync && sync.lastRequest && typeof sync.lastRequest === "object" ? sync.lastRequest : null;
  if (!req) return "—";
  const name = typeof req.name === "string" && req.name ? req.name : null;
  const hasMs = typeof req.ms === "number" && Number.isFinite(req.ms) && req.ms >= 0;
  const hasAge = typeof req.ageMs === "number" && Number.isFinite(req.ageMs) && req.ageMs >= 0;
  if (!name && !hasMs && !hasAge) return "—";
  const bits = [name || "—"];
  if (hasMs) bits.push(formatMs(req.ms));
  if (hasAge) bits.push(formatAgo(req.ageMs));
  return `Last request: ${bits.join(" · ")}`;
}

const PACKAGE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Top packages by join-hook time. Empty when there is nothing to show.
 * @param {unknown} hookTime
 * @returns {string[]}
 */
function slowPackageLines(hookTime) {
  const row = hookTime && typeof hookTime === "object" ? hookTime : null;
  const source = row && Array.isArray(row.byPackage) ? row.byPackage : [];
  const ranked = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item.id !== "string" || !PACKAGE_ID.test(item.id)) continue;
    if (typeof item.ms !== "number" || !Number.isFinite(item.ms) || item.ms < 0) continue;
    ranked.push({ id: item.id, ms: item.ms });
  }
  ranked.sort((a, b) => b.ms - a.ms);
  const lines = [];
  for (let i = 0; i < ranked.length && lines.length < 8; i += 1) {
    lines.push(`${ranked[i].id} ${formatMs(ranked[i].ms)}`);
  }
  return lines;
}

function formatTraffic(sync) {
  const row = sync && typeof sync === "object" ? sync : {};
  const hasAge = typeof row.lastMessageAgeMs === "number" && Number.isFinite(row.lastMessageAgeMs) && row.lastMessageAgeMs >= 0;
  const hasReq = typeof row.requestsPerMin === "number" && Number.isFinite(row.requestsPerMin);
  const hasMsg = typeof row.messagesPerMin === "number" && Number.isFinite(row.messagesPerMin);
  if (!hasAge && !hasReq && !hasMsg) return "—";
  return `Last server message: ${hasAge ? formatAgo(row.lastMessageAgeMs) : "—"} · requests ${formatPerMin(row.requestsPerMin)} · messages ${formatPerMin(row.messagesPerMin)}`;
}

/**
 * Collapsed-header summary for a redacted network trace.
 * @param {object | null | undefined} report
 * @returns {string}
 */
function formatNetTraceSummary(report) {
  const summary = report && typeof report === "object" ? report.summary : null;
  const hops = summary && typeof summary.hopCount === "number" && Number.isFinite(summary.hopCount) ? summary.hopCount : null;
  if (hops == null) return "not run";
  const reached = summary.reached ? "reached" : "not reached";
  const ping = report.ping && typeof report.ping === "object" ? report.ping : {};
  const loss = typeof ping.lossPct === "number" && Number.isFinite(ping.lossPct) ? ping.lossPct : null;
  const jitter = typeof ping.jitterMs === "number" && Number.isFinite(ping.jitterMs) ? ping.jitterMs : null;
  const lossText = loss == null ? "—" : `${trimDecimal((Math.round(loss * 10) / 10).toFixed(1))}%`;
  const jitterText = jitter == null ? "—" : `${Math.round(jitter)} ms`;
  return `${reached} in ${Math.round(hops)} hops · ${lossText} loss · jitter ${jitterText}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    formatBytes,
    formatMs,
    formatPercent,
    formatRate,
    phaseSegments,
    syncLabel,
    severityOrder,
    barLevel,
    rateFromSamples,
    compareLine,
    formatBadUrlButton,
    formatBadUrlLine,
    createIssueTracker,
    formatIssueForClipboard,
    formatIssueSummary,
    formatResolvedAgo,
    syncLatencyLabel,
    formatDocLine,
    formatThroughput,
    formatAgo,
    formatLastRequest,
    formatTraffic,
    slowPackageLines,
    formatNetTraceSummary,
  };
}

if (typeof window !== "undefined") {
  window.flcStatsFormat = {
    formatBytes,
    formatMs,
    formatPercent,
    formatRate,
    phaseSegments,
    syncLabel,
    severityOrder,
    barLevel,
    rateFromSamples,
    compareLine,
    formatBadUrlButton,
    formatBadUrlLine,
    createIssueTracker,
    formatIssueForClipboard,
    formatIssueSummary,
    formatResolvedAgo,
    syncLatencyLabel,
    formatDocLine,
    formatThroughput,
    formatAgo,
    formatLastRequest,
    formatTraffic,
    slowPackageLines,
    formatNetTraceSummary,
  };
}
