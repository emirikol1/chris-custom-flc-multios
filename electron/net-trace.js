'use strict';

/**
 * Opt-in network path trace. Pure helpers plus an injectable runner.
 * Addresses, names, and hosts stay in the returned object only. Callers must
 * not log or persist that object. OS tools are always invoked with numeric
 * flags so they do not perform reverse lookups.
 */

const { spawn } = require('child_process');

const MTU_SIZES = [1472, 1452, 1432, 1392, 1372, 1272, 1232];
const TRACE_TIMEOUT_MS = 75000;
const PING_TIMEOUT_MS = 20000;
const MTU_STAGE_MS = 15000;
const MTU_PROBE_MS = 1000;
const KILL_GRACE_MS = 2000;
const REVERSE_TIMEOUT_MS = 2000;
const SWEEPS = 3;
const DNS_SLOW_MS = 300;

/**
 * @param {string} platform
 * @returns {{ platform: string, ping: { cmd: string, args: string[] }[], trace: { cmd: string, args: string[] }[], mtu: (size: number) => { cmd: string, args: string[] } }}
 */
function planCommands(platform) {
  const plat = platform === 'win32' || platform === 'darwin' ? platform : 'linux';
  if (plat === 'win32') {
    return {
      platform: plat,
      ping: [{ cmd: 'ping', args: ['-n', '10', '-w', '1000', '<host>'] }],
      trace: [{ cmd: 'tracert', args: ['-d', '-h', '30', '-w', '1000', '<host>'] }],
      mtu: (size) => ({ cmd: 'ping', args: ['-n', '1', '-w', '1000', '-f', '-l', String(size), '<host>'] }),
    };
  }
  if (plat === 'darwin') {
    return {
      platform: plat,
      ping: [{ cmd: 'ping', args: ['-c', '10', '-i', '0.2', '-W', '1000', '<host>'] }],
      trace: [{ cmd: 'traceroute', args: ['-n', '-q', '1', '-w', '1', '-m', '30', '<host>'] }],
      mtu: (size) => ({ cmd: 'ping', args: ['-c', '1', '-W', '1000', '-D', '-s', String(size), '<host>'] }),
    };
  }
  return {
    platform: plat,
    ping: [
      { cmd: 'ping', args: ['-n', '-c', '10', '-i', '0.2', '-W', '1', '<host>'] },
      { cmd: 'ping', args: ['-n', '-c', '10', '-W', '1', '<host>'] },
    ],
    trace: [
      { cmd: 'tracepath', args: ['-n', '-m', '30', '<host>'] },
      { cmd: 'traceroute', args: ['-n', '-q', '1', '-w', '1', '-m', '30', '<host>'] },
    ],
    mtu: (size) => ({ cmd: 'ping', args: ['-n', '-c', '1', '-W', '1', '-M', 'do', '-s', String(size), '<host>'] }),
  };
}

/**
 * @param {string[]} args
 * @param {string} host
 * @returns {string[]}
 */
function argsWithHost(args, host) {
  const next = Array.isArray(args) ? args.slice() : [];
  if (next[next.length - 1] === '<host>') next[next.length - 1] = host;
  else next.push(host);
  return next;
}

/**
 * @param {unknown} ip
 * @returns {'private' | 'cgnat' | 'public' | 'none'}
 */
function classifyAddress(ip) {
  if (typeof ip !== 'string') return 'none';
  let raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return 'none';
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) raw = mapped[1];
  if (raw.includes(':')) return classifyV6(raw);
  return classifyV4(raw);
}

/**
 * @param {string} raw
 * @returns {'private' | 'cgnat' | 'public' | 'none'}
 */
function classifyV4(raw) {
  const parts = raw.split('.');
  if (parts.length !== 4) return 'none';
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return 'none';
    const n = Number(part);
    if (n > 255) return 'none';
    octets.push(n);
  }
  const a = octets[0];
  const b = octets[1];
  if (a === 0 || a === 10 || a === 127) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return 'public';
}

/**
 * @param {string} raw
 * @returns {'private' | 'public' | 'none'}
 */
function classifyV6(raw) {
  if (!/^[0-9a-f:]+$/.test(raw)) return 'none';
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return 'private';
  const firstText = raw.split(':')[0] || '0';
  const first = parseInt(firstText || '0', 16);
  if (!Number.isFinite(first)) return 'none';
  if (first >= 0xfe80 && first <= 0xfebf) return 'private';
  if (first >= 0xfc00 && first <= 0xfdff) return 'private';
  return 'public';
}

/**
 * @param {unknown} ip
 * @returns {string}
 */
function canonical(ip) {
  if (typeof ip !== 'string') return '';
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (!err || typeof err !== 'object') return 'Error';
  const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
  if (/^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
  if (name && name !== 'Error') return name;
  return code || name || 'Error';
}

function abortErr() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortErr();
}

/**
 * @param {unknown} host
 * @returns {string | null}
 */
function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (!value || value.length > 253 || value.startsWith('-') || value.includes('..')) return null;
  if (!/^[A-Za-z0-9.:-]+$/.test(value)) return null;
  return value;
}

/**
 * @param {unknown} port
 * @returns {number | null}
 */
function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanHash(value) {
  if (typeof value === 'string' && /^srv:[a-z0-9]{3,16}$/.test(value)) return value;
  return 'srv:none';
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function linesOf(text) {
  return String(text || '').split(/\r?\n/);
}

/**
 * @param {string} text
 * @returns {'tracepath' | 'tracert' | 'traceroute'}
 */
function detectTraceFormat(text) {
  if (/\[LOCALHOST\]/i.test(text) || /^\s*\d+\??:/m.test(text) || /\bno reply\b/i.test(text)) return 'tracepath';
  if (/Tracing route/i.test(text) || /Trace complete/i.test(text) || /Request timed out/i.test(text)) return 'tracert';
  return 'traceroute';
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function headerDestination(text) {
  const paren = text.match(/traceroute to\s+\S+\s+\(([^)]+)\)/i);
  if (paren && classifyAddress(paren[1]) !== 'none') return paren[1];
  const bracket = text.match(/\[([^\]]+)\]/);
  if (bracket && classifyAddress(bracket[1]) !== 'none') return bracket[1];
  return null;
}

/**
 * @param {string} rest
 * @returns {{ address: string | null, rttMs: number[], missed: number }}
 */
function parseProbeRest(rest) {
  const tokens = String(rest || '').trim().split(/\s+/).filter(Boolean);
  /** @type {number[]} */
  const rttMs = [];
  let missed = 0;
  /** @type {string | null} */
  let address = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '*') {
      missed += 1;
      continue;
    }
    if (tok.toLowerCase() === 'ms') continue;
    const bare = tok.replace(/^\(|\)$/g, '');
    if (/^<\s*1(?:ms)?$/i.test(bare)) {
      if (/ms$/i.test(bare) || (tokens[i + 1] && tokens[i + 1].toLowerCase() === 'ms')) {
        rttMs.push(0);
        if (!/ms$/i.test(bare)) i += 1;
        continue;
      }
    }
    const attached = bare.match(/^(\d+(?:\.\d+)?)ms$/i);
    if (attached) {
      rttMs.push(Number(attached[1]));
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(bare) && tokens[i + 1] && tokens[i + 1].toLowerCase() === 'ms') {
      rttMs.push(Number(bare));
      i += 1;
      continue;
    }
    if (!address && classifyAddress(bare) !== 'none') address = bare;
  }
  if (/no reply|timed out|host unreachable/i.test(rest) && rttMs.length === 0 && missed === 0) missed = 1;
  return { address, rttMs, missed };
}

/**
 * Smallest Resume pmtu, else the smallest pmtu printed by tracepath.
 * @param {string} text
 * @returns {number | null}
 */
function parseTracepathPmtu(text) {
  const resumes = [];
  const all = [];
  for (const line of linesOf(text)) {
    const resume = line.match(/Resume:.*\bpmtu\s+(\d+)/i);
    if (resume) resumes.push(Number(resume[1]));
    const found = line.match(/\bpmtu\s+(\d+)/i);
    if (found) all.push(Number(found[1]));
  }
  const pool = resumes.length ? resumes : all;
  const finite = pool.filter((n) => Number.isFinite(n) && n > 0);
  if (!finite.length) return null;
  return Math.min(...finite);
}

/**
 * @param {string} text
 * @param {string} [platform]
 * @returns {{ hops: { n: number, address: string | null, rttMs: number[], missed: number }[], reached: boolean, raw: undefined, pmtuBytes: number | null }}
 */
function parseTraceroute(text, platform) {
  const body = String(text || '');
  const format = platform === 'win32' ? 'tracert' : detectTraceFormat(body);
  const dest = headerDestination(body);
  /** @type {{ n: number, address: string | null, rttMs: number[], missed: number }[]} */
  const hops = [];
  for (const line of linesOf(body)) {
    if (/\[LOCALHOST\]/i.test(line)) continue;
    let match;
    if (format === 'tracepath') {
      match = line.match(/^\s*(\d+)\??:\s*(.*)$/);
      if (match && line.match(/^\s*\d+\?:/)) continue;
    } else {
      match = line.match(/^\s*(\d+)\s+(.*)$/);
    }
    if (!match) continue;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) continue;
    const parsed = parseProbeRest(match[2]);
    hops.push({ n, address: parsed.address, rttMs: parsed.rttMs, missed: parsed.missed });
  }
  const reached = /\breached\b/i.test(body) || hops.some((hop) => hop.address && dest && canonical(hop.address) === canonical(dest));
  return {
    hops,
    reached,
    raw: undefined,
    pmtuBytes: format === 'tracepath' ? parseTracepathPmtu(body) : null,
  };
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function stddev(values) {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const avg = values.reduce((sum, n) => sum + n, 0) / values.length;
  const variance = values.reduce((sum, n) => sum + ((n - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * @param {string} text
 * @returns {number[]}
 */
function pingSamples(text) {
  /** @type {number[]} */
  const samples = [];
  const re = /time\s*(?:=|<)\s*(\d+(?:\.\d+)?)\s*ms/gi;
  let match = re.exec(text);
  while (match) {
    samples.push(Number(match[1]));
    match = re.exec(text);
  }
  return samples;
}

/**
 * @param {string} text
 * @param {string} [_platform]
 * @returns {{ sent: number | null, received: number | null, lossPct: number | null, rttMinMs: number | null, rttAvgMs: number | null, rttMaxMs: number | null, jitterMs: number | null }}
 */
function parsePing(text, _platform) {
  const body = String(text || '');
  const samples = pingSamples(body);
  let sent = null;
  let received = null;
  let lossPct = null;
  let rttMinMs = null;
  let rttAvgMs = null;
  let rttMaxMs = null;
  let jitterMs = null;

  const unix = body.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received,[^\n]*?([\d.]+)%\s+packet loss/i);
  const win = body.match(/Sent\s*=\s*(\d+)\s*,\s*Received\s*=\s*(\d+)\s*,\s*Lost\s*=\s*(\d+)\s*\(\s*([\d.]+)%\s*loss\s*\)/i);
  if (unix) {
    sent = Number(unix[1]);
    received = Number(unix[2]);
    lossPct = Number(unix[3]);
  } else if (win) {
    sent = Number(win[1]);
    received = Number(win[2]);
    lossPct = Number(win[4]);
  }

  const mdev = body.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/i);
  const winRtt = body.match(/Minimum\s*=\s*(\d+)\s*ms\s*,\s*Maximum\s*=\s*(\d+)\s*ms\s*,\s*Average\s*=\s*(\d+)\s*ms/i);
  if (mdev) {
    rttMinMs = Number(mdev[1]);
    rttAvgMs = Number(mdev[2]);
    rttMaxMs = Number(mdev[3]);
    jitterMs = Number(mdev[4]);
  } else if (winRtt) {
    rttMinMs = Number(winRtt[1]);
    rttMaxMs = Number(winRtt[2]);
    rttAvgMs = Number(winRtt[3]);
    jitterMs = stddev(samples);
  } else if (samples.length) {
    rttMinMs = Math.min(...samples);
    rttMaxMs = Math.max(...samples);
    rttAvgMs = samples.reduce((sum, n) => sum + n, 0) / samples.length;
    jitterMs = stddev(samples);
  }

  return { sent, received, lossPct, rttMinMs, rttAvgMs, rttMaxMs, jitterMs };
}

/**
 * Reply with time= is success. Fragmentation messages are a definite failure.
 * Anything else (including a silent timeout) is a miss.
 * @param {string} text
 * @returns {{ ok: boolean, definite: boolean }}
 */
function parseMtuProbe(text) {
  const body = String(text || '');
  const definite = /message too long|packet needs to be fragmented|frag needed/i.test(body);
  const ok = !definite && /time\s*=\s*\d/i.test(body);
  return { ok, definite };
}

/**
 * @param {{ size: number, ok: boolean }[]} probes
 * @returns {number | null}
 */
function mtuFromProbes(probes) {
  const hit = probes.find((probe) => probe.ok);
  if (!hit) return null;
  if (hit.size === MTU_SIZES[0]) return 1500;
  return hit.size + 28;
}

/**
 * Don't-fragment pings, largest payload first, stop at the first reply.
 * The whole stage is capped at 15 s.
 * @param {string} host
 * @param {{ platform?: string, spawn?: Function, signal?: AbortSignal | null }} [options]
 * @returns {Promise<{ mtuBytes: number | null, pingMtuBytes: number | null, tracepathMtuBytes: number | null, probes: { size: number, ok: boolean }[], method: 'ping-df', error: string | null }>}
 */
async function measurePathMtu(host, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const platform = opts.platform === 'win32' || opts.platform === 'darwin' ? opts.platform : 'linux';
  const plan = planCommands(platform);
  const safeHost = normalizeHost(host);
  /** @type {{ size: number, ok: boolean }[]} */
  const probes = [];
  const empty = (error) => ({
    mtuBytes: null,
    pingMtuBytes: null,
    tracepathMtuBytes: null,
    probes,
    method: /** @type {'ping-df'} */ ('ping-df'),
    error,
  });
  if (!safeHost) return empty('TypeError');
  if (typeof opts.spawn !== 'function') return empty('TypeError');

  const stageMs = typeof opts.stageMs === 'number' && opts.stageMs > 0 ? opts.stageMs : MTU_STAGE_MS;
  const started = Date.now();
  /** @type {string | null} */
  let error = null;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    if (!error) error = 'TimeoutError';
    ac.abort();
  }, stageMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onParentAbort = () => {
    error = 'AbortError';
    ac.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onParentAbort();
    else opts.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    for (const size of MTU_SIZES) {
      if (ac.signal.aborted) break;
      const elapsed = Date.now() - started;
      if (elapsed >= stageMs) {
        if (!error) error = 'TimeoutError';
        break;
      }
      const spec = plan.mtu(size);
      let result;
      try {
        result = await opts.spawn(spec.cmd, argsWithHost(spec.args, safeHost), {
          timeoutMs: Math.min(MTU_PROBE_MS, Math.max(1, stageMs - elapsed)),
          signal: ac.signal,
        });
      } catch (err) {
        if (!error) error = errorName(err);
        probes.push({ size, ok: false });
        continue;
      }
      if (result && result.error === 'AbortError') {
        if (!error) error = 'AbortError';
        break;
      }
      if (result && result.error === 'ENOENT') {
        error = 'ENOENT';
        break;
      }
      if (result && result.error === 'TimeoutError' && ac.signal.aborted && error === 'TimeoutError') break;
      const parsed = parseMtuProbe(`${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`);
      probes.push({ size, ok: parsed.ok });
      if (parsed.ok) break;
    }
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
  }

  const pingMtu = mtuFromProbes(probes);
  return {
    mtuBytes: pingMtu,
    pingMtuBytes: pingMtu,
    tracepathMtuBytes: null,
    probes,
    method: 'ping-df',
    error: pingMtu == null ? error : null,
  };
}

/**
 * Prefer tracepath pmtu when it agrees with the ping probe within 28 bytes.
 * When both exist and disagree, mtuBytes is null and both values are kept.
 * @param {{ mtuBytes: number | null, probes?: { size: number, ok: boolean }[], error?: string | null, pingMtuBytes?: number | null }} pingResult
 * @param {number | null | undefined} tracepathMtuBytes
 */
function combinePathMtu(pingResult, tracepathMtuBytes) {
  const probes = pingResult && Array.isArray(pingResult.probes) ? pingResult.probes : [];
  const pingMtu = pingResult && typeof pingResult.mtuBytes === 'number' ? pingResult.mtuBytes : null;
  const traceMtu = typeof tracepathMtuBytes === 'number' && Number.isFinite(tracepathMtuBytes) ? tracepathMtuBytes : null;
  const pingError = pingResult && typeof pingResult.error === 'string' ? pingResult.error : null;
  if (pingMtu == null && traceMtu == null) {
    return { mtuBytes: null, pingMtuBytes: null, tracepathMtuBytes: null, probes, method: 'ping-df', error: pingError };
  }
  if (pingMtu == null) {
    return { mtuBytes: traceMtu, pingMtuBytes: null, tracepathMtuBytes: traceMtu, probes, method: 'tracepath', error: null };
  }
  if (traceMtu == null) {
    return { mtuBytes: pingMtu, pingMtuBytes: pingMtu, tracepathMtuBytes: null, probes, method: 'ping-df', error: null };
  }
  if (Math.abs(pingMtu - traceMtu) <= 28) {
    return { mtuBytes: traceMtu, pingMtuBytes: pingMtu, tracepathMtuBytes: traceMtu, probes, method: 'both', error: null };
  }
  return { mtuBytes: null, pingMtuBytes: pingMtu, tracepathMtuBytes: traceMtu, probes, method: 'both', error: null };
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function mean(values) {
  const nums = values.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

/**
 * @param {{ hops?: { n: number, address?: string | null, rttMs?: number[], missed?: number }[], reached?: boolean }[]} sweeps
 * @param {{ destinationAddresses?: string[] }} [options]
 */
function aggregateSweeps(sweeps, options) {
  const list = Array.isArray(sweeps) ? sweeps : [];
  const dest = new Set();
  const destList = options && Array.isArray(options.destinationAddresses) ? options.destinationAddresses : [];
  for (const addr of destList) {
    if (classifyAddress(addr) !== 'none') dest.add(canonical(addr));
  }
  const seenN = new Set();
  for (const sweep of list) {
    for (const hop of (sweep && sweep.hops) || []) {
      if (hop && typeof hop.n === 'number' && hop.n >= 1) seenN.add(hop.n);
    }
  }
  const hopNumbers = [...seenN].sort((a, b) => a - b);
  /** @type {object[]} */
  const hops = [];
  for (const n of hopNumbers) {
    /** @type {string[]} */
    const addresses = [];
    /** @type {number[]} */
    const rtts = [];
    /** @type {number[]} */
    const avgs = [];
    let probes = 0;
    let replies = 0;
    for (const sweep of list) {
      const row = ((sweep && sweep.hops) || []).find((hop) => hop && hop.n === n);
      if (!row) continue;
      if (typeof row.address === 'string' && classifyAddress(row.address) !== 'none') {
        if (!addresses.some((addr) => canonical(addr) === canonical(row.address))) addresses.push(row.address);
      }
      const times = Array.isArray(row.rttMs) ? row.rttMs.filter((value) => typeof value === 'number' && Number.isFinite(value)) : [];
      let missed = typeof row.missed === 'number' && Number.isFinite(row.missed) ? row.missed : 0;
      if (missed < 0) missed = 0;
      if (times.length === 0 && missed === 0) missed = 1;
      probes += times.length + missed;
      replies += times.length;
      for (const time of times) rtts.push(time);
      const avg = mean(times);
      if (avg != null) avgs.push(avg);
    }
    const lossPct = probes > 0 ? ((probes - replies) / probes) * 100 : 0;
    let jitterMs = null;
    if (avgs.length >= 2) jitterMs = Math.max(...avgs) - Math.min(...avgs);
    else if (avgs.length === 1) jitterMs = 0;
    hops.push({
      n,
      addresses,
      names: {},
      rttMinMs: rtts.length ? Math.min(...rtts) : null,
      rttAvgMs: mean(rtts),
      rttMaxMs: rtts.length ? Math.max(...rtts) : null,
      jitterMs,
      lossPct,
      consistent: addresses.length <= 1,
      class: 'transit',
    });
  }
  assignClasses(hops, dest);
  return { hops, summary: summarizeHops(hops, list) };
}

/**
 * @param {object[]} hops
 * @param {Set<string>} dest
 */
function assignClasses(hops, dest) {
  let lanExit = null;
  let ispCount = 0;
  let ispClosed = false;
  for (const hop of hops) {
    const addrs = hop.addresses.filter((addr) => classifyAddress(addr) !== 'none');
    if (addrs.length === 0 && hop.rttAvgMs == null) {
      hop.class = 'filtered';
      continue;
    }
    if (addrs.some((addr) => dest.has(canonical(addr)))) {
      hop.class = 'destination';
      continue;
    }
    const kinds = addrs.map((addr) => classifyAddress(addr));
    if (kinds.length && kinds.every((kind) => kind === 'private' || kind === 'cgnat')) {
      hop.class = 'lan';
      if (hop.rttMinMs != null) lanExit = hop.rttMinMs;
      continue;
    }
    const doubled = lanExit != null && hop.rttMinMs != null && hop.rttMinMs >= lanExit * 2;
    if (!ispClosed && ispCount < 3 && hop.n <= 3 && !doubled) {
      hop.class = 'isp';
      ispCount += 1;
      if (ispCount >= 3) ispClosed = true;
    } else {
      hop.class = 'transit';
      if (doubled || hop.n > 3) ispClosed = true;
    }
  }
}

/**
 * @param {object[]} hops
 * @param {object[]} sweeps
 */
function summarizeHops(hops, sweeps) {
  const filtered = hops.find((hop) => hop.class === 'filtered');
  const destHop = hops.find((hop) => hop.class === 'destination') || hops[hops.length - 1] || null;
  const changed = hops.find((hop) => !hop.consistent && hop.addresses.some((addr) => classifyAddress(addr) === 'public'));
  return {
    hopCount: hops.length,
    reached: sweeps.some((sweep) => sweep && sweep.reached === true),
    firstFilteredHop: filtered ? filtered.n : null,
    lossStartsAtHop: lossStart(hops),
    destinationLossPct: destHop ? destHop.lossPct : null,
    pathChanged: Boolean(changed),
    pathChangedHop: changed ? changed.n : null,
  };
}

/**
 * First non-filtered hop whose loss continues through every later non-filtered
 * hop. Filtered hops followed by a clean hop are not the start of loss.
 * @param {object[]} hops
 * @returns {number | null}
 */
function lossStart(hops) {
  if (!hops.length) return null;
  let tail = null;
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (hops[i].class === 'filtered') continue;
    tail = hops[i];
    break;
  }
  if (!tail || !(tail.lossPct > 0)) return null;
  for (let i = 0; i < hops.length; i += 1) {
    let holds = true;
    for (let j = i; j < hops.length; j += 1) {
      if (hops[j].class === 'filtered') continue;
      if (!(hops[j].lossPct > 0)) {
        holds = false;
        break;
      }
    }
    if (holds && hops[i].class !== 'filtered') return hops[i].n;
  }
  return null;
}

/**
 * @param {object | null | undefined} mtu
 * @returns {string | null}
 */
function formatMtuLine(mtu) {
  if (!mtu || typeof mtu !== 'object') return null;
  const warn = '— below 1500: VPN/PPPoE/tunnel likely; large transfers may stall if the server does not honour PMTU';
  if (mtu.method === 'both' && mtu.mtuBytes == null && typeof mtu.pingMtuBytes === 'number' && typeof mtu.tracepathMtuBytes === 'number') {
    const low = Math.min(mtu.pingMtuBytes, mtu.tracepathMtuBytes);
    const detail = `Path MTU ~${mtu.pingMtuBytes} (ping) / ~${mtu.tracepathMtuBytes} (tracepath)`;
    return low < 1500 ? `${detail} ${warn}` : detail;
  }
  if (typeof mtu.mtuBytes !== 'number') return mtu.error ? 'Path MTU unavailable' : null;
  if (mtu.mtuBytes < 1500) return `Path MTU ~${mtu.mtuBytes} ${warn}`;
  return `Path MTU ~${mtu.mtuBytes} (no fragmentation)`;
}

/**
 * @param {object} report
 * @returns {{ severity: 'info' | 'warn', text: string }[]}
 */
function buildFindings(report) {
  /** @type {{ severity: 'info' | 'warn', text: string }[]} */
  const findings = [];
  const summary = report && report.summary ? report.summary : {};
  if (summary.firstFilteredHop != null) {
    findings.push({
      severity: 'info',
      text: `ICMP filtered from hop ${summary.firstFilteredHop} (normal for many routers)`,
    });
  }
  if (summary.lossStartsAtHop != null) {
    findings.push({
      severity: 'warn',
      text: `Loss begins at hop ${summary.lossStartsAtHop} and persists to the destination (${formatPct(summary.destinationLossPct)})`,
    });
  }
  if (summary.pathChanged) {
    const hop = summary.pathChangedHop != null ? summary.pathChangedHop : '?';
    findings.push({ severity: 'info', text: `Path changed between sweeps at hop ${hop}` });
  }
  const dnsMs = report && report.dns && Array.isArray(report.dns.ms) ? report.dns.ms.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
  if (dnsMs.length && Math.max(...dnsMs) >= DNS_SLOW_MS) {
    findings.push({ severity: 'warn', text: `DNS slow: ${Math.round(Math.max(...dnsMs))} ms` });
  }
  const tcp = mean(report && report.connect && Array.isArray(report.connect.tcpMs) ? report.connect.tcpMs : []);
  const tls = mean(report && report.connect && Array.isArray(report.connect.tlsMs) ? report.connect.tlsMs : []);
  if (tcp != null && tcp > 0 && tls != null && tls >= tcp * 2) {
    findings.push({
      severity: 'info',
      text: `TLS handshake ${(tls / tcp).toFixed(1)}× slower than TCP connect suggests server CPU/TLS load`,
    });
  }
  const tcpOk = report && report.connect && Array.isArray(report.connect.tcpMs) && report.connect.tcpMs.some((n) => typeof n === 'number' && Number.isFinite(n));
  if (summary.reached === false && tcpOk) {
    findings.push({
      severity: 'info',
      text: 'Destination not reached by trace but TCP connect succeeded (ICMP blocked at destination)',
    });
  }
  const mtuFinding = mtuFindingFor(report && report.mtu);
  if (mtuFinding) findings.push(mtuFinding);
  return findings;
}

/**
 * @param {object | null | undefined} mtu
 * @returns {{ severity: 'info' | 'warn', text: string } | null}
 */
function mtuFindingFor(mtu) {
  if (!mtu) return null;
  let value = typeof mtu.mtuBytes === 'number' ? mtu.mtuBytes : null;
  if (value == null && typeof mtu.pingMtuBytes === 'number' && typeof mtu.tracepathMtuBytes === 'number') {
    value = Math.min(mtu.pingMtuBytes, mtu.tracepathMtuBytes);
  }
  if (value == null || value >= 1500) return null;
  const text = formatMtuLine(mtu);
  if (!text) return null;
  return { severity: value < 1400 ? 'warn' : 'info', text };
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function formatCell(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value)} ms`;
}

/**
 * @param {unknown[]} values
 * @returns {string}
 */
function joinMs(values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return '—';
  return list.map((value) => (typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—')).join('/');
}

/**
 * @param {object} hop
 * @returns {string}
 */
function formatHopAddress(hop) {
  if (!hop || !Array.isArray(hop.addresses) || !hop.addresses.length) return '';
  return hop.addresses.map((addr) => {
    if (addr === '(private)') return addr;
    const name = hop.names && typeof hop.names === 'object' ? hop.names[addr] : '';
    return name ? `${addr} (${name})` : addr;
  }).join(' / ');
}

/**
 * @param {object | null | undefined} report
 * @returns {string}
 */
function formatNetTraceText(report) {
  const source = report && typeof report === 'object' ? report : {};
  const include = source.includeAddresses === true;
  const when = typeof source.generatedAt === 'string' && source.generatedAt ? source.generatedAt : '—';
  const sweeps = typeof source.sweeps === 'number' ? source.sweeps : SWEEPS;
  const lines = [];
  lines.push(`Network trace — ${cleanHash(source.serverHash)} — ${sweeps} sweeps — ${when} — addresses: ${include ? 'included' : 'hidden'}`);
  lines.push(formatDnsLine(source.dns));
  lines.push(formatConnectLine(source.connect));
  lines.push(formatPingLine(source.ping));
  const mtuLine = formatMtuLine(source.mtu);
  if (mtuLine) lines.push(mtuLine);
  lines.push(formatHopTable(source.hops, include));
  lines.push('Findings');
  const findings = Array.isArray(source.findings) ? source.findings : [];
  if (!findings.length) lines.push('None');
  else {
    for (const finding of findings) {
      if (finding && typeof finding.text === 'string' && finding.text) lines.push(finding.text);
    }
  }
  return lines.join('\n');
}

/**
 * @param {object | null | undefined} dns
 * @returns {string}
 */
function formatDnsLine(dns) {
  if (!dns || typeof dns !== 'object') return 'DNS —';
  const times = joinMs(dns.ms);
  const consistent = dns.consistent === false ? 'changed' : 'consistent';
  const err = typeof dns.error === 'string' && dns.error ? ` · error ${dns.error}` : '';
  const a = typeof dns.a === 'number' ? dns.a : 0;
  const aaaa = typeof dns.aaaa === 'number' ? dns.aaaa : 0;
  return `DNS ${times} ms · A ${a} · AAAA ${aaaa} · ${consistent}${err}`;
}

/**
 * @param {object | null | undefined} connect
 * @returns {string}
 */
function formatConnectLine(connect) {
  if (!connect || typeof connect !== 'object') return 'TCP —';
  const tls = Array.isArray(connect.tlsMs) && connect.tlsMs.length ? ` · TLS ${joinMs(connect.tlsMs)} ms` : '';
  const errors = Array.isArray(connect.errors) && connect.errors.length ? ` · errors ${connect.errors.join(', ')}` : '';
  return `TCP ${joinMs(connect.tcpMs)} ms${tls}${errors}`;
}

/**
 * @param {object | null | undefined} ping
 * @returns {string}
 */
function formatPingLine(ping) {
  if (!ping || ping.available === false) return 'Ping unavailable';
  if (!ping || typeof ping !== 'object') return 'Ping —';
  const loss = formatPct(ping.lossPct);
  const jitter = formatCell(ping.jitterMs);
  const rtt = [ping.rttMinMs, ping.rttAvgMs, ping.rttMaxMs].map((value) => (typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—')).join('/');
  return `Ping loss ${loss} · jitter ${jitter} · rtt ${rtt} ms`;
}

/**
 * @param {object[] | null | undefined} hops
 * @param {boolean} include
 * @returns {string}
 */
function formatHopTable(hops, include) {
  const rows = Array.isArray(hops) ? hops : [];
  const fmtRow = (cols) => [
    String(cols[0]).padStart(3),
    String(cols[1]).padEnd(12),
    String(cols[2]).padStart(8),
    String(cols[3]).padStart(8),
    String(cols[4]).padStart(8),
    String(cols[5]).padStart(8),
    String(cols[6]).padStart(7),
  ].join('  ');
  let header = fmtRow(['hop', 'class', 'min', 'avg', 'max', 'jitter', 'loss']);
  if (include) header += '  address';
  const lines = [header];
  for (const hop of rows) {
    let line = fmtRow([
      hop.n,
      hop.class || 'transit',
      formatCell(hop.rttMinMs),
      formatCell(hop.rttAvgMs),
      formatCell(hop.rttMaxMs),
      formatCell(hop.jitterMs),
      formatPct(hop.lossPct),
    ]);
    if (include) {
      const addr = formatHopAddress(hop);
      if (addr) line += `  ${addr}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * @param {object | null | undefined} report
 * @param {{ includeAddresses?: boolean }} [options]
 * @returns {object}
 */
function redactReport(report, options) {
  const include = Boolean(options && options.includeAddresses);
  const source = report && typeof report === 'object' ? JSON.parse(JSON.stringify(report)) : {};
  source.includeAddresses = include;
  source.serverHash = cleanHash(source.serverHash);
  if (source.dns && typeof source.dns === 'object') delete source.dns.addresses;
  delete source.destinationAddresses;
  const hops = Array.isArray(source.hops) ? source.hops : [];
  for (const hop of hops) {
    const addresses = Array.isArray(hop.addresses) ? hop.addresses : [];
    const names = hop.names && typeof hop.names === 'object' ? hop.names : {};
    if (!include) {
      delete hop.addresses;
      delete hop.names;
      delete hop.address;
      delete hop.name;
      continue;
    }
    /** @type {string[]} */
    const shown = [];
    /** @type {Record<string, string>} */
    const shownNames = {};
    for (const addr of addresses) {
      const kind = classifyAddress(addr);
      if (kind === 'private' || kind === 'cgnat' || kind === 'none') {
        if (!shown.includes('(private)')) shown.push('(private)');
        continue;
      }
      if (!shown.includes(addr)) shown.push(addr);
      if (typeof names[addr] === 'string' && names[addr]) shownNames[addr] = names[addr];
    }
    hop.addresses = shown;
    hop.names = shownNames;
    delete hop.address;
    delete hop.name;
  }
  return source;
}

/**
 * Public hop names only. Never called unless the user opted in.
 * Failures and timeouts become "no name".
 * @param {object} report
 * @param {{ reverse?: Function, timeoutMs?: number }} [options]
 */
async function attachReverseNames(report, options) {
  if (!report || typeof report !== 'object' || report.namesResolved) return report;
  const opts = options && typeof options === 'object' ? options : {};
  const reverse = opts.reverse;
  /** @type {string[]} */
  const addrs = [];
  for (const hop of report.hops || []) {
    for (const addr of hop.addresses || []) {
      if (classifyAddress(addr) === 'public' && !addrs.includes(addr)) addrs.push(addr);
    }
  }
  /** @type {Map<string, string>} */
  const found = new Map();
  if (typeof reverse !== 'function') return report;
  if (addrs.length) {
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : REVERSE_TIMEOUT_MS;
    await Promise.all(addrs.map(async (addr) => {
      const name = await reverseOne(addr, reverse, timeoutMs);
      if (name) found.set(addr, name);
    }));
  }
  for (const hop of report.hops || []) {
    /** @type {Record<string, string>} */
    const names = {};
    for (const addr of hop.addresses || []) {
      if (found.has(addr)) names[addr] = found.get(addr);
    }
    hop.names = names;
  }
  report.namesResolved = true;
  return report;
}

/**
 * @param {string} addr
 * @param {Function} reverse
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
function reverseOne(addr, reverse, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const lookup = Promise.resolve()
    .then(() => reverse(addr))
    .then((names) => {
      const raw = Array.isArray(names) ? names[0] : names;
      return cleanPtr(raw);
    })
    .catch(() => null);
  return Promise.race([lookup, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * @param {unknown} name
 * @returns {string | null}
 */
function cleanPtr(name) {
  if (typeof name !== 'string') return null;
  const value = name.trim().replace(/\.$/, '');
  if (!value || value.length > 253) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(value)) return null;
  if (value.startsWith('-') || value.includes('..')) return null;
  if (classifyAddress(value) !== 'none') return null;
  return value;
}

/**
 * @param {Function} spawnFn
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal | null }} options
 */
async function runCommand(spawnFn, cmd, args, options) {
  throwIfAborted(options && options.signal);
  const result = await spawnFn(cmd, args, {
    timeoutMs: options && options.timeoutMs,
    signal: options && options.signal,
  });
  if (result && result.error === 'AbortError') throw abortErr();
  return result || { stdout: '', stderr: '', code: null, error: 'Error' };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal | null }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, error: string | null }>}
 */
function spawnCaptured(cmd, args, options) {
  const opts = options && typeof options === 'object' ? options : {};
  return new Promise((resolve) => {
    let settled = false;
    /** @type {import('child_process').ChildProcess | null} */
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const killChild = () => {
      if (!child || child.killed) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const later = setTimeout(() => {
        try {
          if (child && !child.killed) child.kill('SIGKILL');
        } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      if (typeof later.unref === 'function') later.unref();
    };
    let stdout = '';
    let stderr = '';
    const take = (chunk, prev) => `${prev}${chunk.toString('utf8')}`.slice(-262144);
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish({ stdout: '', stderr: '', code: null, error: err && err.code === 'ENOENT' ? 'ENOENT' : errorName(err) });
      return;
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout = take(chunk, stdout); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr = take(chunk, stderr); });
    child.on('error', (err) => {
      finish({
        stdout,
        stderr,
        code: null,
        error: err && err.code === 'ENOENT' ? 'ENOENT' : errorName(err),
      });
    });
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild();
        finish({ stdout, stderr, code: null, error: 'TimeoutError' });
      }, opts.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const onAbort = () => {
      killChild();
      finish({ stdout, stderr, code: null, error: 'AbortError' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      finish({ stdout, stderr, code, error: null });
    });
  });
}

/**
 * @param {string} host
 * @param {{ resolver: object, now?: () => number, signal?: AbortSignal | null }} options
 */
async function measureDns(host, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const resolver = opts.resolver;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  /** @type {number[]} */
  const ms = [];
  /** @type {string[]} */
  const sets = [];
  /** @type {string[]} */
  const addresses = [];
  let a = 0;
  let aaaa = 0;
  /** @type {string | null} */
  let error = null;
  for (let i = 0; i < 3; i += 1) {
    throwIfAborted(opts.signal);
    if (typeof opts.onSample === 'function') opts.onSample(i + 1);
    const started = now();
    /** @type {string[]} */
    const found = [];
    try {
      if (!resolver || typeof resolver.lookup !== 'function') throw Object.assign(new Error('lookup'), { name: 'TypeError' });
      const looked = await resolver.lookup(host, { all: true });
      const rows = Array.isArray(looked) ? looked : [looked];
      for (const row of rows) {
        const addr = row && typeof row === 'object' ? row.address : row;
        if (typeof addr === 'string' && classifyAddress(addr) !== 'none') found.push(addr);
      }
      const v4 = await resolveList(resolver, 'resolve4', host);
      const v6 = await resolveList(resolver, 'resolve6', host);
      a = v4.list.length;
      aaaa = v6.list.length;
      if (v4.error && !error) error = v4.error;
      if (v6.error && !error) error = v6.error;
      for (const addr of v4.list.concat(v6.list)) {
        if (!found.includes(addr)) found.push(addr);
      }
    } catch (err) {
      if (!error) error = errorName(err);
    }
    ms.push(Math.max(0, now() - started));
    found.sort();
    sets.push(found.join(','));
    for (const addr of found) {
      if (!addresses.includes(addr)) addresses.push(addr);
    }
  }
  return {
    ms,
    a,
    aaaa,
    consistent: sets.every((set) => set === sets[0]),
    error,
    addresses,
  };
}

/**
 * ENODATA / ENOTFOUND on one family is an empty answer, not a failed lookup.
 * @param {object} resolver
 * @param {'resolve4' | 'resolve6'} method
 * @param {string} host
 */
async function resolveList(resolver, method, host) {
  if (!resolver || typeof resolver[method] !== 'function') return { list: [], error: null };
  try {
    const rows = await resolver[method](host);
    const list = Array.isArray(rows) ? rows.filter((addr) => typeof addr === 'string') : [];
    return { list, error: null };
  } catch (err) {
    const name = errorName(err);
    if (name === 'ENODATA' || name === 'ENOTFOUND') return { list: [], error: null };
    return { list: [], error: name };
  }
}

/**
 * @param {string} host
 * @param {number} port
 * @param {{ connect?: Function, tlsConnect?: Function, now?: () => number, signal?: AbortSignal | null }} options
 */
async function measureConnect(host, port, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  /** @type {(number | null)[]} */
  const tcpMs = [];
  /** @type {(number | null)[]} */
  const tlsMs = [];
  /** @type {string[]} */
  const errors = [];
  const doTls = port === 443 && typeof opts.tlsConnect === 'function';
  for (let i = 0; i < 3; i += 1) {
    throwIfAborted(opts.signal);
    if (typeof opts.onSample === 'function') opts.onSample(i + 1);
    const started = now();
    try {
      if (typeof opts.connect !== 'function') throw Object.assign(new Error('connect'), { name: 'TypeError' });
      await opts.connect(host, port);
      tcpMs.push(Math.max(0, now() - started));
    } catch (err) {
      tcpMs.push(null);
      const name = errorName(err);
      if (!errors.includes(name)) errors.push(name);
    }
    if (doTls) {
      const tlsStarted = now();
      try {
        await opts.tlsConnect(host, port);
        tlsMs.push(Math.max(0, now() - tlsStarted));
      } catch (err) {
        tlsMs.push(null);
        const name = errorName(err);
        if (!errors.includes(name)) errors.push(name);
      }
    }
  }
  return { tcpMs, tlsMs, errors };
}

/**
 * @param {string} blob
 * @param {object | null} parsed
 * @returns {boolean}
 */
function pingOptionFailed(blob, parsed) {
  if (parsed && parsed.sent != null) return false;
  return /invalid|unknown option|unrecognized option|permission denied|operation not permitted/i.test(blob);
}

/**
 * @param {object} opts
 */
async function runNetTrace(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const host = normalizeHost(options.host);
  if (!host) {
    const err = new Error('Invalid host');
    err.name = 'TypeError';
    throw err;
  }
  const port = normalizePort(options.port);
  const platform = options.platform === 'win32' || options.platform === 'darwin' ? options.platform : 'linux';
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : spawnCaptured;
  const signal = options.signal || null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const plan = planCommands(platform);
  const steps = 3 + 3 + 1 + 1 + SWEEPS;
  let step = 0;
  const tick = (label) => {
    step += 1;
    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress({ step, of: steps, label });
      } catch {
        /* progress is best-effort */
      }
    }
  };

  throwIfAborted(signal);
  const dns = await measureDns(host, {
    resolver: options.dns,
    now,
    signal,
    onSample: (index) => tick(`DNS ${index}/3`),
  });
  const connectFn = pickConnect(options);
  const tlsFn = pickTls(options);
  const connect = await measureConnect(host, port || 0, {
    connect: connectFn,
    tlsConnect: port === 443 ? tlsFn : null,
    now,
    signal,
    onSample: (index) => tick(`TCP ${index}/3`),
  });

  throwIfAborted(signal);
  tick('Ping');
  const pingRun = await runPing(host, plan, spawnFn, signal);
  throwIfAborted(signal);
  tick('Path MTU');
  const pingMtu = await measurePathMtu(host, { platform, spawn: spawnFn, signal });

  /** @type {{ tool: string, available: boolean }[]} */
  const tools = [];
  /** @type {object[]} */
  const sweepParses = [];
  /** @type {number[]} */
  const pmtus = [];
  let traceMissing = false;
  /** @type {ReturnType<typeof planCommands>['trace'] | null} */
  let traceTools = null;
  for (let i = 1; i <= SWEEPS; i += 1) {
    throwIfAborted(signal);
    tick(`Trace sweep ${i}/3`);
    if (traceMissing) continue;
    const sweepPlan = traceTools ? { ...plan, trace: traceTools } : plan;
    const sweep = await runTraceOnce(host, sweepPlan, spawnFn, signal);
    for (const name of sweep.missing || []) {
      if (!tools.some((tool) => tool.tool === name)) tools.push({ tool: name, available: false });
    }
    if (!sweep.available) {
      traceMissing = true;
      continue;
    }
    traceTools = plan.trace.filter((spec) => spec.cmd === sweep.tool);
    if (!tools.some((tool) => tool.tool === sweep.tool && tool.available)) {
      tools.push({ tool: sweep.tool, available: true });
    }
    sweepParses.push(sweep.parsed);
    if (typeof sweep.parsed.pmtuBytes === 'number') pmtus.push(sweep.parsed.pmtuBytes);
  }

  const tracePmtu = pmtus.length ? Math.min(...pmtus) : null;
  const mtu = combinePathMtu(pingMtu, tracePmtu);
  const aggregated = aggregateSweeps(sweepParses, { destinationAddresses: dns.addresses });
  const ping = pingRun.parsed ? { ...pingRun.parsed, available: pingRun.available !== false } : {
    sent: null,
    received: null,
    lossPct: null,
    rttMinMs: null,
    rttAvgMs: null,
    rttMaxMs: null,
    jitterMs: null,
    available: false,
  };
  if (pingRun.error && ping.available !== false) ping.error = pingRun.error;
  /** @type {object} */
  const report = {
    serverHash: cleanHash(options.serverHash),
    generatedAt: new Date(now()).toISOString(),
    sweeps: SWEEPS,
    dns,
    connect,
    ping,
    mtu,
    tools,
    hops: aggregated.hops,
    summary: aggregated.summary,
    namesResolved: false,
    destinationAddresses: dns.addresses,
  };
  report.findings = buildFindings(report);
  return report;
}

/**
 * @param {object} options
 * @returns {Function | null}
 */
function pickConnect(options) {
  if (typeof options.connect === 'function') return options.connect;
  if (options.net && typeof options.net.connect === 'function') {
    return (host, port) => options.net.connect(host, port);
  }
  if (typeof options.net === 'function') return options.net;
  return null;
}

/**
 * @param {object} options
 * @returns {Function | null}
 */
function pickTls(options) {
  if (typeof options.tlsConnect === 'function') return options.tlsConnect;
  if (options.tls && typeof options.tls.connect === 'function') {
    return (host, port) => options.tls.connect(host, port);
  }
  return null;
}

/**
 * @param {string} host
 * @param {ReturnType<typeof planCommands>} plan
 * @param {Function} spawnFn
 * @param {AbortSignal | null} signal
 */
async function runPing(host, plan, spawnFn, signal) {
  let lastError = null;
  for (let i = 0; i < plan.ping.length; i += 1) {
    const spec = plan.ping[i];
    const result = await runCommand(spawnFn, spec.cmd, argsWithHost(spec.args, host), {
      timeoutMs: PING_TIMEOUT_MS,
      signal,
    });
    if (result.error === 'ENOENT') return { available: false, tool: spec.cmd, parsed: null, error: 'ENOENT' };
    const blob = `${result.stdout || ''}\n${result.stderr || ''}`;
    const parsed = parsePing(blob, plan.platform);
    if (i < plan.ping.length - 1 && pingOptionFailed(blob, parsed)) {
      lastError = result.error;
      continue;
    }
    return {
      available: true,
      tool: spec.cmd,
      parsed,
      error: result.error === 'TimeoutError' ? 'TimeoutError' : lastError,
    };
  }
  return { available: false, tool: 'ping', parsed: null, error: 'ENOENT' };
}

/**
 * @param {string} host
 * @param {ReturnType<typeof planCommands>} plan
 * @param {Function} spawnFn
 * @param {AbortSignal | null} signal
 */
async function runTraceOnce(host, plan, spawnFn, signal) {
  /** @type {string[]} */
  const missing = [];
  for (const spec of plan.trace) {
    const result = await runCommand(spawnFn, spec.cmd, argsWithHost(spec.args, host), {
      timeoutMs: TRACE_TIMEOUT_MS,
      signal,
    });
    if (result.error === 'ENOENT') {
      missing.push(spec.cmd);
      continue;
    }
    const blob = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { available: true, tool: spec.cmd, missing, parsed: parseTraceroute(blob, plan.platform) };
  }
  return {
    available: false,
    tool: missing[missing.length - 1] || 'traceroute',
    missing,
    parsed: { hops: [], reached: false, raw: undefined, pmtuBytes: null },
  };
}

module.exports = {
  planCommands,
  classifyAddress,
  parseTraceroute,
  parsePing,
  parseMtuProbe,
  parseTracepathPmtu,
  measurePathMtu,
  combinePathMtu,
  aggregateSweeps,
  measureDns,
  measureConnect,
  redactReport,
  formatNetTraceText,
  formatMtuLine,
  buildFindings,
  attachReverseNames,
  runNetTrace,
  spawnCaptured,
  MTU_SIZES,
  MTU_STAGE_MS,
  TRACE_TIMEOUT_MS,
  PING_TIMEOUT_MS,
};
