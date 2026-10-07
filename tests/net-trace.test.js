import { describe, expect, it } from 'vitest';
import {
  MTU_SIZES,
  aggregateSweeps,
  attachReverseNames,
  buildFindings,
  classifyAddress,
  combinePathMtu,
  formatNetTraceText,
  measurePathMtu,
  parseMtuProbe,
  parsePing,
  parseTracepathPmtu,
  parseTraceroute,
  planCommands,
  redactReport,
  runNetTrace,
  spawnCaptured,
} from '../electron/net-trace.js';
import {
  forgetNetTrace,
  redactedNetTraceText,
  registerNetTraceIpc,
} from '../electron/net-trace-ipc.js';

const HOST = '198.51.100.20';

const LINUX_TOO_LONG = `PING ${HOST} (${HOST}) 1472(1500) bytes of data.
ping: local error: Message too long, mtu=1500
From 203.0.113.1 icmp_seq=1 Frag needed and DF set (mtu = 1400)

--- ${HOST} ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
`;

const LINUX_TIMEOUT = `PING ${HOST} (${HOST}) 1472(1500) bytes of data.

--- ${HOST} ping statistics ---
1 packets transmitted, 0 received, 100% packet loss, time 1001ms
`;

const LINUX_SUCCESS = `PING ${HOST} (${HOST}) 1472(1500) bytes of data.
1480 bytes from ${HOST}: icmp_seq=1 ttl=57 time=12.3 ms

--- ${HOST} ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 12.300/12.300/12.300/0.000 ms
`;

const DARWIN_TOO_LONG = `PING ${HOST} (${HOST}): 1472 data bytes
ping: sendto: Message too long
`;

const DARWIN_TIMEOUT = `PING ${HOST} (${HOST}): 1472 data bytes
Request timeout for icmp_seq 0

--- ${HOST} ping statistics ---
1 packets transmitted, 0 packets received, 100.0% packet loss
`;

const DARWIN_SUCCESS = `PING ${HOST} (${HOST}): 1472 data bytes
1480 bytes from ${HOST}: icmp_seq=0 ttl=57 time=11.2 ms

--- ${HOST} ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 11.200/11.200/11.200/0.000 ms
`;

const WIN_TOO_LONG = `Pinging ${HOST} with 1472 bytes of data:
Packet needs to be fragmented but DF set.

Ping statistics for ${HOST}:
    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),
`;

const WIN_TIMEOUT = `Pinging ${HOST} with 1472 bytes of data:
Request timed out.

Ping statistics for ${HOST}:
    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),
`;

const WIN_SUCCESS = `Pinging ${HOST} with 1472 bytes of data:
Reply from ${HOST}: bytes=1472 time=12ms TTL=57

Ping statistics for ${HOST}:
    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 12ms, Maximum = 12ms, Average = 12ms
`;

const LINUX_TRACE = `traceroute to ${HOST} (${HOST}), 30 hops max, 60 byte packets
 1  192.168.1.1  1.234 ms
 2  * * *
 3  2001:db8::1  5.5 ms
 4  ${HOST}  12.0 ms
`;

const TRACEPATH = ` 1?: [LOCALHOST]                                         pmtu 1500
 1:  192.168.1.1                                          0.532ms
 2:  no reply
 3:  2001:db8::9                                          15.210ms
 4:  198.51.100.8                                         22.100ms pmtu 1400
 5:  ${HOST}                                              30.000ms reached
     Resume: pmtu 1400 hops 5 back 4
`;

const WIN_TRACE = `Tracing route to example [${HOST}]
over a maximum of 30 hops:

  1     1 ms    <1 ms     2 ms  192.168.1.1
  2     *        *        *     Request timed out.
  3    12 ms    11 ms    13 ms  2001:db8::55
  4    20 ms    19 ms    21 ms  ${HOST}

Trace complete.
`;

function hop(n, address, rttMs, missed = 0) {
  return { n, address, rttMs, missed };
}

describe('planCommands', () => {
  it('uses numeric flags and the platform probe order', () => {
    const linux = planCommands('linux');
    expect(linux.trace.map((row) => row.cmd)).toEqual(['tracepath', 'traceroute']);
    expect(linux.trace[0].args).toEqual(['-n', '-m', '30', '<host>']);
    expect(linux.trace[1].args).toEqual(['-n', '-q', '1', '-w', '1', '-m', '30', '<host>']);
    expect(linux.ping[0].args).toEqual(['-n', '-c', '10', '-i', '0.2', '-W', '1', '<host>']);
    expect(linux.ping[1].args).toEqual(['-n', '-c', '10', '-W', '1', '<host>']);
    expect(linux.mtu(1472).args).toEqual(['-n', '-c', '1', '-W', '1', '-M', 'do', '-s', '1472', '<host>']);

    const darwin = planCommands('darwin');
    expect(darwin.trace[0].args).toEqual(['-n', '-q', '1', '-w', '1', '-m', '30', '<host>']);
    expect(darwin.ping[0].args).toEqual(['-c', '10', '-i', '0.2', '-W', '1000', '<host>']);
    expect(darwin.mtu(1452).args).toEqual(['-c', '1', '-W', '1000', '-D', '-s', '1452', '<host>']);

    const win = planCommands('win32');
    expect(win.trace[0].args).toEqual(['-d', '-h', '30', '-w', '1000', '<host>']);
    expect(win.ping[0].args).toEqual(['-n', '10', '-w', '1000', '<host>']);
    expect(win.mtu(1392).args).toEqual(['-n', '1', '-w', '1000', '-f', '-l', '1392', '<host>']);
  });
});

describe('classifyAddress', () => {
  it('separates private, cgnat, public, and empty', () => {
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.31.255.255')).toBe('private');
    expect(classifyAddress('172.32.0.1')).toBe('public');
    expect(classifyAddress('192.168.0.1')).toBe('private');
    expect(classifyAddress('169.254.1.1')).toBe('private');
    expect(classifyAddress('127.0.0.1')).toBe('private');
    expect(classifyAddress('100.64.0.1')).toBe('cgnat');
    expect(classifyAddress('100.127.255.255')).toBe('cgnat');
    expect(classifyAddress('100.128.0.1')).toBe('public');
    expect(classifyAddress('8.8.8.8')).toBe('public');
    expect(classifyAddress('::1')).toBe('private');
    expect(classifyAddress('fe80::1')).toBe('private');
    expect(classifyAddress('fd12::1')).toBe('private');
    expect(classifyAddress('2001:db8::1')).toBe('public');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
    expect(classifyAddress('not-an-ip')).toBe('none');
    expect(classifyAddress('')).toBe('none');
    expect(classifyAddress(null)).toBe('none');
  });
});

describe('parseTraceroute', () => {
  it('parses linux traceroute, including stars and IPv6', () => {
    const parsed = parseTraceroute(LINUX_TRACE, 'linux');
    expect(parsed.raw).toBeUndefined();
    expect(parsed.reached).toBe(true);
    expect(parsed.hops.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    expect(parsed.hops[0]).toMatchObject({ address: '192.168.1.1', rttMs: [1.234], missed: 0 });
    expect(parsed.hops[1]).toMatchObject({ address: null, rttMs: [], missed: 3 });
    expect(parsed.hops[2].address).toBe('2001:db8::1');
    expect(parsed.hops[3].address).toBe(HOST);
  });

  it('parses darwin traceroute the same way', () => {
    const parsed = parseTraceroute(LINUX_TRACE, 'darwin');
    expect(parsed.reached).toBe(true);
    expect(parsed.hops[1].missed).toBe(3);
  });

  it('parses tracepath no-reply, pmtu, and reached lines', () => {
    const parsed = parseTraceroute(TRACEPATH, 'linux');
    expect(parsed.raw).toBeUndefined();
    expect(parsed.reached).toBe(true);
    expect(parsed.pmtuBytes).toBe(1400);
    expect(parseTracepathPmtu(TRACEPATH)).toBe(1400);
    expect(parsed.hops.map((row) => row.address)).toEqual([
      '192.168.1.1',
      null,
      '2001:db8::9',
      '198.51.100.8',
      HOST,
    ]);
    expect(parsed.hops[0].rttMs).toEqual([0.532]);
    expect(parsed.hops[1]).toMatchObject({ rttMs: [], missed: 1 });
    expect(parsed.hops.some((row) => row.address === '[LOCALHOST]')).toBe(false);
  });

  it('parses Windows tracert with wide spacing', () => {
    const parsed = parseTraceroute(WIN_TRACE, 'win32');
    expect(parsed.reached).toBe(true);
    expect(parsed.hops[0]).toMatchObject({ address: '192.168.1.1', rttMs: [1, 0, 2], missed: 0 });
    expect(parsed.hops[1]).toMatchObject({ address: null, missed: 3, rttMs: [] });
    expect(parsed.hops[2].address).toBe('2001:db8::55');
    expect(parsed.hops[3].address).toBe(HOST);
  });
});

describe('parsePing', () => {
  it('reads linux mdev, darwin stddev, and windows samples', () => {
    const linux = parsePing(`10 packets transmitted, 10 received, 0% packet loss, time 1804ms
rtt min/avg/max/mdev = 11.000/12.000/15.000/4.000 ms
`, 'linux');
    expect(linux).toMatchObject({ sent: 10, received: 10, lossPct: 0, rttMinMs: 11, rttAvgMs: 12, rttMaxMs: 15, jitterMs: 4 });

    const darwin = parsePing(`10 packets transmitted, 9 packets received, 10.0% packet loss
round-trip min/avg/max/stddev = 11.000/12.500/15.000/1.250 ms
`, 'darwin');
    expect(darwin).toMatchObject({ sent: 10, received: 9, lossPct: 10, jitterMs: 1.25 });

    const win = parsePing(`Reply from ${HOST}: bytes=32 time=10ms TTL=57
Reply from ${HOST}: bytes=32 time=12ms TTL=57
Reply from ${HOST}: bytes=32 time=14ms TTL=57
Ping statistics for ${HOST}:
    Packets: Sent = 10, Received = 9, Lost = 1 (10% loss),
Approximate round trip times in milli-seconds:
    Minimum = 10ms, Maximum = 14ms, Average = 12ms
`, 'win32');
    expect(win.sent).toBe(10);
    expect(win.received).toBe(9);
    expect(win.lossPct).toBe(10);
    expect(win.jitterMs).toBeCloseTo(Math.sqrt(8 / 3), 5);
  });
});

describe('parseMtuProbe', () => {
  it('accepts a reply with time= on each platform', () => {
    expect(parseMtuProbe(LINUX_SUCCESS)).toEqual({ ok: true, definite: false });
    expect(parseMtuProbe(DARWIN_SUCCESS)).toEqual({ ok: true, definite: false });
    expect(parseMtuProbe(WIN_SUCCESS)).toEqual({ ok: true, definite: false });
  });

  it('treats fragmentation text as a definite failure', () => {
    expect(parseMtuProbe(LINUX_TOO_LONG)).toEqual({ ok: false, definite: true });
    expect(parseMtuProbe(DARWIN_TOO_LONG)).toEqual({ ok: false, definite: true });
    expect(parseMtuProbe(WIN_TOO_LONG)).toEqual({ ok: false, definite: true });
  });

  it('treats a timeout with no reply as a miss', () => {
    expect(parseMtuProbe(LINUX_TIMEOUT)).toEqual({ ok: false, definite: false });
    expect(parseMtuProbe(DARWIN_TIMEOUT)).toEqual({ ok: false, definite: false });
    expect(parseMtuProbe(WIN_TIMEOUT)).toEqual({ ok: false, definite: false });
  });
});

describe('measurePathMtu', () => {
  it('stops at the first success and maps 1472 to 1500', async () => {
    const calls = [];
    const result = await measurePathMtu(HOST, {
      platform: 'linux',
      spawn: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: LINUX_SUCCESS, stderr: '', code: 0, error: null };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: 'ping',
      args: ['-n', '-c', '1', '-W', '1', '-M', 'do', '-s', '1472', HOST],
    });
    expect(result.mtuBytes).toBe(1500);
    expect(result.method).toBe('ping-df');
    expect(result.error).toBeNull();
    expect(result.probes).toEqual([{ size: 1472, ok: true }]);
  });

  it('uses the first smaller payload that gets a reply', async () => {
    const outs = [LINUX_TOO_LONG, LINUX_SUCCESS];
    const result = await measurePathMtu(HOST, {
      platform: 'linux',
      spawn: async () => ({ stdout: outs.shift(), stderr: '', code: 0, error: null }),
    });
    expect(result.probes).toEqual([{ size: 1472, ok: false }, { size: 1452, ok: true }]);
    expect(result.mtuBytes).toBe(1480);
  });

  it('keeps going through timeouts and reports no MTU when nothing replies', async () => {
    const result = await measurePathMtu(HOST, {
      platform: 'darwin',
      spawn: async (cmd, args) => {
        expect(cmd).toBe('ping');
        expect(args.slice(0, 6)).toEqual(['-c', '1', '-W', '1000', '-D', '-s']);
        return { stdout: DARWIN_TIMEOUT, stderr: '', code: 1, error: null };
      },
    });
    expect(result.probes.map((probe) => probe.size)).toEqual(MTU_SIZES);
    expect(result.probes.every((probe) => probe.ok === false)).toBe(true);
    expect(result.mtuBytes).toBeNull();
  });

  it('builds the Windows dont-fragment command', async () => {
    const calls = [];
    await measurePathMtu(HOST, {
      platform: 'win32',
      spawn: async (cmd, args) => {
        calls.push({ cmd, args });
        return { stdout: WIN_SUCCESS, stderr: '', code: 0, error: null };
      },
    });
    expect(calls[0].args).toEqual(['-n', '1', '-w', '1000', '-f', '-l', '1472', HOST]);
  });

  it('aborts the stage on its own deadline', async () => {
    const result = await measurePathMtu(HOST, {
      platform: 'linux',
      stageMs: 40,
      spawn: (_cmd, _args, opts) => new Promise((resolve) => {
        const finish = () => resolve({ stdout: '', stderr: '', code: null, error: 'AbortError' });
        if (opts.signal && opts.signal.aborted) finish();
        else opts.signal.addEventListener('abort', finish, { once: true });
      }),
    });
    expect(result.error).toBe('TimeoutError');
    expect(result.mtuBytes).toBeNull();
    expect(result.method).toBe('ping-df');
  });
});

describe('combinePathMtu', () => {
  it('prefers tracepath when the two values agree within 28 bytes', () => {
    const merged = combinePathMtu({ mtuBytes: 1500, probes: [{ size: 1472, ok: true }], error: null }, 1492);
    expect(merged.method).toBe('both');
    expect(merged.mtuBytes).toBe(1492);
    expect(merged.pingMtuBytes).toBe(1500);
    expect(merged.tracepathMtuBytes).toBe(1492);
  });

  it('keeps both values when they disagree', () => {
    const merged = combinePathMtu({ mtuBytes: 1400, probes: [], error: null }, 1500);
    expect(merged).toMatchObject({
      mtuBytes: null,
      pingMtuBytes: 1400,
      tracepathMtuBytes: 1500,
      method: 'both',
      error: null,
    });
    const findings = buildFindings({
      summary: {},
      dns: { ms: [] },
      connect: { tcpMs: [], tlsMs: [] },
      mtu: merged,
    });
    expect(findings[0].severity).toBe('info');
    expect(findings[0].text).toContain('~1400 (ping)');
    expect(findings[0].text).toContain('~1500 (tracepath)');
  });

  it('warns when the path MTU is under 1400', () => {
    const findings = buildFindings({
      summary: {},
      dns: { ms: [] },
      connect: { tcpMs: [], tlsMs: [] },
      mtu: { mtuBytes: 1260, probes: [], method: 'ping-df', error: null },
    });
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].text).toContain('Path MTU ~1260 — below 1500');
  });
});

describe('aggregateSweeps', () => {
  it('classes lan, isp, transit, filtered, and destination', () => {
    const { hops } = aggregateSweeps([{
      reached: true,
      hops: [
        hop(1, '10.0.0.1', [2]),
        hop(2, '100.64.0.1', [2]),
        hop(3, '203.0.113.1', [3]),
        hop(4, '198.51.100.8', [3]),
        hop(5, null, [], 1),
        hop(6, HOST, [20]),
      ],
    }], { destinationAddresses: [HOST] });
    expect(hops.map((row) => row.class)).toEqual(['lan', 'lan', 'isp', 'transit', 'filtered', 'destination']);
  });

  it('ends the isp class when RTT jumps or the hop index passes 3', () => {
    const doubled = aggregateSweeps([{
      reached: false,
      hops: [hop(1, '192.168.0.1', [2]), hop(2, '203.0.113.1', [5])],
    }]);
    expect(doubled.hops.map((row) => row.class)).toEqual(['lan', 'transit']);

    const indexed = aggregateSweeps([{
      reached: false,
      hops: [
        hop(1, '192.168.0.1', [1]),
        hop(2, '192.168.1.1', [1]),
        hop(3, '203.0.113.1', [1.2]),
        hop(4, '203.0.113.2', [1.2]),
      ],
    }]);
    expect(indexed.hops.map((row) => row.class)).toEqual(['lan', 'lan', 'isp', 'transit']);
  });

  it('caps isp at the first three public hops', () => {
    const { hops } = aggregateSweeps([{
      reached: false,
      hops: [
        hop(1, '203.0.113.1', [1]),
        hop(2, '203.0.113.2', [1]),
        hop(3, '203.0.113.3', [1]),
        hop(4, '203.0.113.4', [1]),
      ],
    }]);
    expect(hops.map((row) => row.class)).toEqual(['isp', 'isp', 'isp', 'transit']);
  });

  it('measures sweep jitter and ignores filtered gaps when finding loss', () => {
    const jitter = aggregateSweeps([
      { reached: true, hops: [hop(1, '203.0.113.1', [10, 10])] },
      { reached: true, hops: [hop(1, '203.0.113.1', [14, 14])] },
    ]);
    expect(jitter.hops[0].jitterMs).toBe(4);
    expect(jitter.hops[0].rttMinMs).toBe(10);
    expect(jitter.hops[0].rttMaxMs).toBe(14);
    expect(jitter.summary.pathChanged).toBe(false);

    const changed = aggregateSweeps([
      { reached: true, hops: [hop(6, '203.0.113.1', [10])] },
      { reached: true, hops: [hop(6, '203.0.113.9', [12])] },
    ]);
    expect(changed.summary.pathChanged).toBe(true);
    expect(changed.summary.pathChangedHop).toBe(6);
    expect(changed.hops).toHaveLength(1);
    expect(changed.hops[0].consistent).toBe(false);

    const loss = aggregateSweeps([{
      reached: true,
      hops: [
        hop(7, null, [], 1),
        hop(8, '198.51.100.8', [10]),
        hop(9, '198.51.100.9', [], 1),
        hop(10, HOST, Array(29).fill(12), 1),
      ],
    }], { destinationAddresses: [HOST] });
    expect(loss.summary.firstFilteredHop).toBe(7);
    expect(loss.summary.lossStartsAtHop).toBe(9);
    expect(loss.summary.destinationLossPct).toBeCloseTo(100 / 30, 5);
    const findings = buildFindings({
      summary: loss.summary,
      dns: { ms: [420] },
      connect: { tcpMs: [20], tlsMs: [42] },
      mtu: { mtuBytes: 1500, method: 'ping-df', error: null },
    });
    expect(findings.map((row) => row.text)).toEqual([
      'ICMP filtered from hop 7 (normal for many routers)',
      'Loss begins at hop 9 and persists to the destination (3.3%)',
      'DNS slow: 420 ms',
      'TLS handshake 2.1× slower than TCP connect suggests server CPU/TLS load',
    ]);
  });
});

describe('redactReport and reverse names', () => {
  const raw = {
    serverHash: 'srv:abc123',
    generatedAt: '2026-10-06T22:00:00.000Z',
    sweeps: 3,
    dns: { ms: [12], a: 1, aaaa: 0, consistent: true, error: null, addresses: [HOST] },
    destinationAddresses: [HOST],
    connect: { tcpMs: [20], tlsMs: [], errors: [] },
    ping: { sent: 10, received: 10, lossPct: 0, rttMinMs: 11, rttAvgMs: 12, rttMaxMs: 15, jitterMs: 4, available: true },
    mtu: { mtuBytes: 1500, probes: [{ size: 1472, ok: true }], method: 'ping-df', error: null },
    hops: [
      { n: 1, class: 'lan', addresses: ['192.168.0.1', '100.64.0.1'], names: {}, rttMinMs: 1, rttAvgMs: 1, rttMaxMs: 1, jitterMs: 0, lossPct: 0, consistent: false },
      { n: 2, class: 'isp', addresses: ['203.0.113.5'], names: { '203.0.113.5': 'edge.example.net' }, rttMinMs: 4, rttAvgMs: 4, rttMaxMs: 4, jitterMs: 0, lossPct: 0, consistent: true },
    ],
    summary: { hopCount: 2, reached: true, firstFilteredHop: null, lossStartsAtHop: null, destinationLossPct: 0, pathChanged: false },
    findings: [],
  };

  it('strips addresses and names unless the user opted in', () => {
    const hidden = redactReport(raw, { includeAddresses: false });
    const hiddenText = JSON.stringify(hidden) + formatNetTraceText(hidden);
    expect(hiddenText).not.toContain('192.168.0.1');
    expect(hiddenText).not.toContain('100.64.0.1');
    expect(hiddenText).not.toContain('203.0.113.5');
    expect(hiddenText).not.toContain('edge.example.net');
    expect(hiddenText).not.toContain(HOST);
    expect(formatNetTraceText(hidden)).toContain('addresses: hidden');

    const shown = redactReport(raw, { includeAddresses: true });
    const text = formatNetTraceText(shown);
    expect(text).toContain('addresses: included');
    expect(text).toContain('203.0.113.5 (edge.example.net)');
    expect(text).toContain('(private)');
    expect(text).not.toContain('192.168.0.1');
    expect(text).not.toContain('100.64.0.1');
    expect(JSON.stringify(shown)).not.toContain(HOST);
  });

  it('looks up only distinct public hops, and only when asked', async () => {
    const report = {
      namesResolved: false,
      hops: [
        { n: 1, addresses: ['192.168.0.1', '100.64.0.1', 'fe80::1'] },
        { n: 2, addresses: ['203.0.113.5', '198.51.100.8', '203.0.113.5'] },
      ],
    };
    const calls = [];
    const reverse = (addr) => {
      calls.push(addr);
      if (addr === '203.0.113.5') return Promise.resolve(['edge.example.net']);
      if (addr === '198.51.100.8') return Promise.reject(Object.assign(new Error('miss'), { code: 'ENOTFOUND' }));
      return new Promise(() => {});
    };
    await attachReverseNames(report, { reverse, timeoutMs: 30 });
    expect(calls.sort()).toEqual(['198.51.100.8', '203.0.113.5']);
    expect(report.hops[1].names['203.0.113.5']).toBe('edge.example.net');
    expect(report.hops[1].names['198.51.100.8']).toBeUndefined();
    expect(report.hops[0].names).toEqual({});
    calls.length = 0;
    await attachReverseNames(report, { reverse, timeoutMs: 30 });
    expect(calls).toEqual([]);
  });
});

describe('runNetTrace', () => {
  it('runs DNS, connect, ping, path MTU, then three sweeps, with no reverse lookup', async () => {
    let clock = Date.parse('2026-10-06T22:00:00.000Z');
    const now = () => clock;
    const dnsDelays = [12, 18, 420];
    let dnsN = 0;
    const tcpDelays = [20, 21, 22];
    const tlsDelays = [48, 50, 52];
    let tcpN = 0;
    let tlsN = 0;
    const labels = [];
    const calls = [];
    const trace = `PROBE-BANNER-9f3c
 1?: [LOCALHOST] pmtu 1500
 1:  192.168.1.1  1.0ms
 2:  203.0.113.1  1.4ms
 3:  no reply
 4:  2001:db8::9  12.0ms
 5:  ${HOST}  20.0ms reached
     Resume: pmtu 1500 hops 5 back 4
`;
    const report = await runNetTrace({
      host: HOST,
      port: 443,
      platform: 'linux',
      serverHash: 'srv:abc123',
      now,
      onProgress: (progress) => labels.push(progress.label),
      dns: {
        lookup: async () => {
          clock += dnsDelays[dnsN] || 0;
          dnsN += 1;
          return [{ address: HOST, family: 4 }];
        },
        resolve4: async () => [HOST],
        resolve6: async () => {
          const err = new Error('miss');
          err.code = 'ENODATA';
          throw err;
        },
      },
      connect: async () => {
        clock += tcpDelays[tcpN] || 0;
        tcpN += 1;
      },
      tlsConnect: async () => {
        clock += tlsDelays[tlsN] || 0;
        tlsN += 1;
      },
      spawn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes('10')) {
          return {
            stdout: '10 packets transmitted, 10 received, 0% packet loss, time 20ms\nrtt min/avg/max/mdev = 11.000/12.000/15.000/4.000 ms\n',
            stderr: '',
            code: 0,
            error: null,
          };
        }
        if (args.includes('-M')) return { stdout: LINUX_SUCCESS, stderr: '', code: 0, error: null };
        if (cmd === 'tracepath') return { stdout: trace, stderr: '', code: 0, error: null };
        return { stdout: '', stderr: '', code: null, error: 'ENOENT' };
      },
    });

    expect(labels).toEqual([
      'DNS 1/3', 'DNS 2/3', 'DNS 3/3',
      'TCP 1/3', 'TCP 2/3', 'TCP 3/3',
      'Ping', 'Path MTU',
      'Trace sweep 1/3', 'Trace sweep 2/3', 'Trace sweep 3/3',
    ]);
    expect(calls.filter((row) => row[0] === 'tracepath')).toHaveLength(3);
    expect(calls.some((row) => row[0] === 'traceroute')).toBe(false);
    expect(calls[0].slice(1, 8)).toEqual(['-n', '-c', '10', '-i', '0.2', '-W', '1']);
    expect(JSON.stringify(report)).not.toContain('PROBE-BANNER-9f3c');
    expect(report.mtu).toMatchObject({ mtuBytes: 1500, method: 'both', pingMtuBytes: 1500, tracepathMtuBytes: 1500 });
    expect(report.summary.reached).toBe(true);
    expect(report.summary.firstFilteredHop).toBe(3);
    expect(report.hops.map((row) => row.class)).toEqual(['lan', 'isp', 'filtered', 'transit', 'destination']);
    expect(report.namesResolved).toBe(false);
    const hidden = formatNetTraceText(redactReport(report, { includeAddresses: false }));
    expect(hidden).toContain('addresses: hidden');
    expect(hidden).toContain('Path MTU ~1500 (no fragmentation)');
    expect(hidden).toContain('DNS slow: 420 ms');
    expect(hidden).not.toContain('192.168.1.1');
    expect(hidden).not.toContain('203.0.113.1');
    expect(hidden).not.toContain('2001:db8::9');
    expect(hidden).not.toContain(HOST);
  });

  it('falls back when the timed ping interval is rejected and when tracepath is missing', async () => {
    const calls = [];
    const report = await runNetTrace({
      host: HOST,
      port: 80,
      platform: 'linux',
      serverHash: 'srv:abc123',
      now: () => Date.parse('2026-10-06T22:00:00.000Z'),
      dns: {
        lookup: async () => [{ address: HOST, family: 4 }],
        resolve4: async () => [HOST],
        resolve6: async () => [],
      },
      connect: async () => {},
      spawn: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'ping' && args.includes('-i')) {
          return { stdout: '', stderr: 'ping: invalid argument', code: 1, error: null };
        }
        if (cmd === 'ping' && args.includes('10')) {
          return {
            stdout: '10 packets transmitted, 9 received, 10% packet loss, time 20ms\nrtt min/avg/max/mdev = 1/2/3/0.5 ms\n',
            stderr: '',
            code: 1,
            error: null,
          };
        }
        if (cmd === 'ping') return { stdout: LINUX_TIMEOUT, stderr: '', code: 1, error: null };
        if (cmd === 'tracepath') return { stdout: '', stderr: '', code: null, error: 'ENOENT' };
        return { stdout: LINUX_TRACE, stderr: '', code: 0, error: null };
      },
    });
    expect(calls.filter((row) => row[0] === 'ping' && row.includes('10'))).toHaveLength(2);
    expect(report.tools).toEqual([
      { tool: 'tracepath', available: false },
      { tool: 'traceroute', available: true },
    ]);
    expect(report.summary.reached).toBe(true);
    expect(report.findings.some((row) => row.text.includes('ICMP blocked at destination'))).toBe(false);
  });

  it('records a missing traceroute and still reports a successful TCP connect', async () => {
    const report = await runNetTrace({
      host: HOST,
      port: 443,
      platform: 'darwin',
      now: () => 1_700_000_000_000,
      dns: {
        lookup: async () => [{ address: HOST, family: 4 }],
        resolve4: async () => [],
        resolve6: async () => [],
      },
      connect: async () => {},
      tlsConnect: async () => {},
      spawn: async () => ({ stdout: '', stderr: '', code: null, error: 'ENOENT' }),
    });
    expect(report.tools).toEqual([{ tool: 'traceroute', available: false }]);
    expect(report.summary.reached).toBe(false);
    expect(report.findings.some((row) => row.text.includes('ICMP blocked at destination'))).toBe(true);
  });
});

describe('spawnCaptured', () => {
  it('kills a command that exceeds its timeout', async () => {
    const started = Date.now();
    const result = await spawnCaptured(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150 });
    expect(result.error).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('nettrace ipc', () => {
  const logs = [];
  const info = (msg, fields) => logs.push({ level: 'info', msg, fields });
  const warn = (msg, fields) => logs.push({ level: 'warn', msg, fields });

  function handlersOf() {
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
    return { handlers, ipcMain };
  }

  function deps(extra) {
    return {
      windowForServer: () => ({}),
      getServerHost: () => ({ host: HOST, port: 443, serverHash: 'srv:abc123' }),
      platform: 'linux',
      log: { info, warn },
      dns: {
        lookup: async () => [{ address: HOST, family: 4 }],
        resolve4: async () => [HOST],
        resolve6: async () => [],
      },
      connect: async () => {},
      tlsConnect: async () => {},
      spawn: async (cmd, args) => {
        if (args.includes('10')) {
          return {
            stdout: '10 packets transmitted, 10 received, 0% packet loss, time 1ms\nrtt min/avg/max/mdev = 1/1/1/0 ms\n',
            stderr: '',
            code: 0,
            error: null,
          };
        }
        if (args.includes('-M')) return { stdout: LINUX_SUCCESS, stderr: '', code: 0, error: null };
        if (cmd === 'tracepath') {
          return {
            stdout: `1:  203.0.113.5  2.0ms\n2:  ${HOST}  4.0ms reached\n`,
            stderr: '',
            code: 0,
            error: null,
          };
        }
        return { stdout: '', stderr: '', code: null, error: 'ENOENT' };
      },
      ...extra,
    };
  }

  it('redacts by default, looks up names only after opt-in, and does not log the path', async () => {
    forgetNetTrace('s1');
    logs.length = 0;
    const seen = [];
    const { handlers, ipcMain } = handlersOf();
    const clipboard = { writeText: (text) => seen.push(text) };
    registerNetTraceIpc({
      ...deps(),
      ipcMain,
      clipboard,
      reverse: async (addr) => {
        seen.push(`rev:${addr}`);
        return ['edge.example.net'];
      },
    });
    const progress = [];
    const event = { sender: { send: (_channel, payload) => progress.push(payload) } };
    const run = await handlers.get('nettrace:run')(event, 's1');
    expect(run.ok).toBe(true);
    expect(run.text).toContain('addresses: hidden');
    expect(run.text).not.toContain('203.0.113.5');
    expect(run.text).not.toContain(HOST);
    expect(seen.filter((row) => String(row).startsWith('rev:'))).toEqual([]);
    expect(progress.some((row) => row.label === 'Path MTU')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(HOST);
    expect(JSON.stringify(logs)).not.toContain('203.0.113.5');
    expect(logs[0].fields).toEqual(expect.objectContaining({ hops: 2, reached: true }));

    const hidden = await handlers.get('nettrace:get')({}, 's1', { includeAddresses: false });
    expect(hidden.text).not.toContain('edge.example.net');
    expect(seen.filter((row) => String(row).startsWith('rev:'))).toEqual([]);

    const shown = await handlers.get('nettrace:get')({}, 's1', { includeAddresses: true });
    expect(shown.text).toContain('203.0.113.5 (edge.example.net)');
    expect(seen.filter((row) => String(row).startsWith('rev:'))).toEqual(['rev:203.0.113.5', `rev:${HOST}`]);

    const copied = await handlers.get('nettrace:copy')({}, 's1', { includeAddresses: true });
    expect(copied).toEqual({ ok: true });
    expect(seen.filter((row) => String(row).startsWith('rev:'))).toEqual(['rev:203.0.113.5', `rev:${HOST}`]);
    expect(seen.at(-1)).toContain('203.0.113.5 (edge.example.net)');

    const reportText = await redactedNetTraceText('s1', { includeAddresses: false });
    expect(reportText).not.toContain('203.0.113.5');
    expect(reportText).not.toContain('edge.example.net');
    forgetNetTrace('s1');
    expect(await handlers.get('nettrace:get')({}, 's1', {})).toBeNull();
  });

  it('rejects a second run while one is in progress', async () => {
    forgetNetTrace('s2');
    let release;
    const { handlers, ipcMain } = handlersOf();
    registerNetTraceIpc({
      ...deps({
        spawn: () => new Promise((resolve) => {
          release = () => resolve({ stdout: '', stderr: '', code: null, error: 'AbortError' });
        }),
      }),
      ipcMain,
      clipboard: { writeText() {} },
      reverse: async () => [],
    });
    const first = handlers.get('nettrace:run')({ sender: { send() {} } }, 's2');
    for (let i = 0; i < 30 && !release; i += 1) await Promise.resolve();
    expect(typeof release).toBe('function');
    const busy = await handlers.get('nettrace:run')({ sender: { send() {} } }, 's2');
    expect(busy).toEqual({ ok: false, reason: 'busy' });
    release();
    await expect(first).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    forgetNetTrace('s2');
  });
});
