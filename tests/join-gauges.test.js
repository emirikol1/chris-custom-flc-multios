import { describe, expect, it } from 'vitest';
import {
  CACHE_MIN_REQUESTS,
  GAUGES,
  computeFills,
  expectedTotals,
  gaugeColor,
  monotonic,
} from '../electron/join-gauges.js';

const EMPTY_PHASES = {
  login: null,
  pageLoad: null,
  transfers: null,
  worldData: null,
  init: null,
  i18n: null,
  setup: null,
  canvas: null,
};

function emptyTotals() {
  return {
    requests: null,
    docs: null,
    packages: null,
    textures: null,
    phaseMs: { ...EMPTY_PHASES },
  };
}

describe('GAUGES', () => {
  it('lists files, cache, objects, modules, and scene left to right', () => {
    expect(GAUGES.map((gauge) => gauge.id)).toEqual(['files', 'cache', 'objects', 'modules', 'scene']);
    expect(GAUGES.map((gauge) => gauge.shortLabel)).toEqual(['Files', 'Cache', 'Objects', 'Modules', 'Scene']);
    expect(GAUGES[1]).toEqual({ id: 'cache', label: 'Cache hit', shortLabel: 'Cache' });
    expect(CACHE_MIN_REQUESTS).toBe(5);
  });
});

describe('expectedTotals', () => {
  it('returns null totals when the server has no join yet', () => {
    expect(expectedTotals(null)).toEqual(emptyTotals());
    expect(expectedTotals(undefined)).toEqual(emptyTotals());
    expect(expectedTotals('last-join')).toEqual(emptyTotals());
    expect(expectedTotals([])).toEqual(emptyTotals());
    expect(expectedTotals(0)).toEqual(emptyTotals());
  });

  it('reads the flat history record from the last join', () => {
    expect(expectedTotals({
      requests: 318,
      docs: 4312,
      transfersMs: 3100,
      worldDataMs: 2000,
      setupMs: 1200,
      canvasMs: 800,
      loginMs: 400,
      pageLoadMs: 900,
      initMs: 500,
      i18nMs: 300,
      totalMs: 9200,
      cacheHitRatio: 0.71,
    })).toEqual({
      requests: 318,
      docs: 4312,
      packages: null,
      textures: null,
      phaseMs: {
        login: 400,
        pageLoad: 900,
        transfers: 3100,
        worldData: 2000,
        init: 500,
        i18n: 300,
        setup: 1200,
        canvas: 800,
      },
    });
  });

  it('uses the last record when given the server history list', () => {
    expect(expectedTotals([
      { requests: 10, docs: 2, setupMs: 100 },
      { requests: 80, docs: 9, canvasMs: 250 },
    ])).toMatchObject({ requests: 80, docs: 9, phaseMs: { canvas: 250, setup: null } });
  });

  it('reads a snapshot-shaped profile and sums world documents', () => {
    expect(expectedTotals({
      transfers: { requests: 100 },
      world: {
        documents: { actors: 10, items: 5, scenes: 1, label: 'secret' },
        activeModuleCount: 7,
        modules: [{ id: 'a' }, { id: 'b' }],
        hookTime: { packages: 3 },
        textures: 40,
      },
      durations: {
        loginMs: 5,
        pageLoadMs: 15,
        transfersMs: 25,
        worldDataMs: 35,
        initMs: 45,
        i18nMs: 55,
        setupMs: 65,
        canvasMs: 75,
      },
    })).toEqual({
      requests: 100,
      docs: 16,
      packages: 7,
      textures: 40,
      phaseMs: {
        login: 5,
        pageLoad: 15,
        transfers: 25,
        worldData: 35,
        init: 45,
        i18n: 55,
        setup: 65,
        canvas: 75,
      },
    });
  });

  it('does not treat world byte estimates as file, doc, or texture totals', () => {
    const totals = expectedTotals({
      worldBytesEstimate: 43201341,
      worldDataBytes: 6800000,
      transferBytes: 42000000,
      cacheHitRatio: 0.9,
    });
    expect(totals.requests).toBeNull();
    expect(totals.docs).toBeNull();
    expect(totals.packages).toBeNull();
    expect(totals.textures).toBeNull();
  });

  it('falls back through package sources and drops non-positive totals', () => {
    expect(expectedTotals({ world: { modules: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } }).packages).toBe(3);
    expect(expectedTotals({ world: { hookTime: { packages: 4 } } }).packages).toBe(4);
    expect(expectedTotals({ packages: 0, docs: -3, requests: Number.NaN, textures: Number.POSITIVE_INFINITY }).packages).toBeNull();
    expect(expectedTotals({ packages: 0, docs: -3 }).docs).toBeNull();
    expect(expectedTotals({ setupMs: 0, canvasMs: -5, pageLoadMs: Number.NaN }).phaseMs).toEqual(EMPTY_PHASES);
  });

  it('lets durations fill gaps the flat record does not have', () => {
    expect(expectedTotals({
      requests: 10,
      transfersMs: 50,
      durations: { pageLoadMs: 80, setupMs: 90 },
    }).phaseMs).toMatchObject({ pageLoad: 80, transfers: 50, setup: 90, canvas: null });
  });
});

describe('computeFills', () => {
  const expected = expectedTotals({
    requests: 100,
    docs: 50,
    packages: 10,
    textures: 20,
    pageLoadMs: 1000,
    transfersMs: 4000,
    setupMs: 2000,
    initMs: 800,
    canvasMs: 1000,
  });

  it('prefers live count over live total, then history, and ignores a zero live total', () => {
    expect(computeFills({
      requests: 20,
      requestsTotal: 40,
      docs: 10,
      docsTotal: 40,
      packages: 2,
      packagesTotal: 8,
      textures: 5,
      texturesTotal: 10,
    }, expected, 0)).toMatchObject({
      files: 0.5,
      objects: 0.25,
      modules: 0.25,
      scene: 0.5,
    });

    expect(computeFills({
      requests: 25,
      docs: 10,
      packages: 4,
      textures: 5,
    }, expected, 0)).toMatchObject({
      files: 0.25,
      objects: 0.2,
      modules: 0.4,
      scene: 0.25,
    });

    expect(computeFills({
      requests: 5,
      requestsTotal: 0,
      files: { count: 30, total: 0 },
    }, expected, 0).files).toBe(0.05);
  });

  it('accepts nested count and total objects', () => {
    expect(computeFills({
      files: { count: 8, total: 16 },
      objects: { count: 3, total: 12 },
      modules: { count: 1, total: 2 },
      scene: { count: 9, total: 9 },
    }, expected, 0)).toMatchObject({
      files: 0.5,
      objects: 0.25,
      modules: 0.5,
      scene: 1,
    });
  });

  it('uses a zero live count instead of the time estimate', () => {
    expect(computeFills({
      requests: 0,
      requestsTotal: 10,
      phases: { pageLoad: { startMs: 0 } },
    }, expected, 500).files).toBe(0);
  });

  it('caps a time estimate at 0.95 until that phase completes', () => {
    const clocks = {
      phases: {
        pageLoad: { startMs: 0 },
        setup: { startMs: 0 },
        canvas: { startMs: 0 },
      },
    };
    expect(computeFills(clocks, expected, 500)).toMatchObject({
      files: 0.5,
      objects: 0.25,
      modules: 0.25,
      scene: 0.5,
    });
    expect(computeFills(clocks, expected, 1000)).toMatchObject({
      files: 0.95,
      objects: 0.5,
      modules: 0.5,
      scene: 0.95,
    });
    const over = computeFills(clocks, expected, 9000);
    expect(over.files).toBe(0.95);
    expect(over.objects).toBe(0.95);
    expect(over.modules).toBe(0.95);
    expect(over.scene).toBe(0.95);
    expect(computeFills({ phases: { pageLoad: { startMs: 500 } } }, expected, 100).files).toBe(0);
    expect(computeFills(clocks, expectedTotals(null), 500).files).toBe(0);
  });

  it('uses transfers duration for files when page-load duration is unknown', () => {
    const totals = expectedTotals({ transfersMs: 2000, initMs: 500 });
    expect(computeFills({
      phases: { pageLoad: { startMs: 0 }, init: { startMs: 0 } },
    }, totals, 1000).files).toBe(0.5);
  });

  it('forces 1 when the matching phase completes, ahead of a low count', () => {
    expect(computeFills({
      requests: 1,
      requestsTotal: 100,
      docs: 1,
      docsTotal: 100,
      packages: 1,
      packagesTotal: 100,
      textures: 1,
      texturesTotal: 100,
      completedPhases: ['socketConnected'],
    }, expected, 0)).toMatchObject({
      files: 1,
      objects: 0.01,
      modules: 0.01,
      scene: 0.01,
    });

    expect(computeFills({
      docs: 1,
      docsTotal: 10,
      packages: 1,
      packagesTotal: 10,
      completedPhases: ['setup'],
    }, expected, 0)).toMatchObject({ objects: 1, modules: 1, scene: 0 });

    expect(computeFills({
      packages: 1,
      packagesTotal: 10,
      completedPhases: ['init'],
    }, expected, 0).modules).toBe(0.1);

    expect(computeFills({
      textures: 1,
      texturesTotal: 10,
      completedPhases: ['canvasReady'],
    }, expected, 0).scene).toBe(1);

    expect(computeFills({ completedPhases: ['ready'] }, expected, 0)).toEqual({
      files: 1,
      cache: null,
      objects: 1,
      modules: 1,
      scene: 1,
    });

    expect(computeFills({
      requests: 2,
      requestsTotal: 10,
      phases: { pageLoad: { startMs: 0, done: true } },
    }, expected, 10).files).toBe(1);
  });

  it('normalizes a history record passed in as expected', () => {
    expect(computeFills(
      { requests: 25, phases: { pageLoad: { startMs: 0 } } },
      { requests: 100, pageLoadMs: 1000 },
      100,
    ).files).toBe(0.25);
  });

  it('keeps cache empty until five requests, then uses cached over seen', () => {
    expect(computeFills({ requests: 4, cachedRequests: 4 }, expected, 0).cache).toBeNull();
    expect(computeFills({ requests: 5, cachedRequests: 2 }, expected, 0).cache).toBe(0.4);
    expect(computeFills({ requests: 5, cachedRequests: 0 }, expected, 0).cache).toBe(0);
    expect(computeFills({ requests: 10 }, expected, 0).cache).toBeNull();
    expect(computeFills({ requests: 8, cachedRequests: 20 }, expected, 0).cache).toBe(1);
    expect(computeFills({ cache: { cached: 3, requests: 4 } }, expected, 0).cache).toBeNull();
    expect(computeFills({ cache: { cached: 3, requests: 6 } }, expected, 0).cache).toBe(0.5);
    expect(computeFills({ completedPhases: ['ready'], requests: 3, cachedRequests: 3 }, expected, 0).cache).toBeNull();
  });

  it('returns an empty join for missing inputs and does not mutate them', () => {
    const live = { requests: 1 };
    const totals = expectedTotals({ requests: 10 });
    const before = JSON.stringify({ live, totals });
    expect(computeFills(null, null, 0)).toEqual({
      files: 0,
      cache: null,
      objects: 0,
      modules: 0,
      scene: 0,
    });
    computeFills(live, totals, Number.NaN);
    expect(JSON.stringify({ live, totals })).toBe(before);
  });
});

describe('monotonic', () => {
  it('never decreases a gauge within one join', () => {
    const prev = { files: 0.8, cache: 0.5, objects: 0.2, modules: 0.4, scene: 1 };
    const next = { files: 0.3, cache: null, objects: 0.6, modules: 0.1, scene: 0.2 };
    expect(monotonic(prev, next)).toEqual({
      files: 0.8,
      cache: 0.5,
      objects: 0.6,
      modules: 0.4,
      scene: 1,
    });
    expect(monotonic({ cache: null }, { cache: 0.2 }).cache).toBe(0.2);
    expect(monotonic({ cache: 0.2 }, { cache: 0.1 }).cache).toBe(0.2);
    expect(monotonic(null, { files: 0.4, cache: null }).files).toBe(0.4);
    expect(monotonic(null, null)).toEqual({
      files: 0,
      cache: null,
      objects: 0,
      modules: 0,
      scene: 0,
    });
  });

  it('does not mutate the previous or next fills', () => {
    const prev = { files: 0.4, cache: 0.2, objects: 0, modules: 0, scene: 0 };
    const next = { files: 0.1, cache: null, objects: 0.3, modules: 0, scene: 0 };
    const prevJson = JSON.stringify(prev);
    const nextJson = JSON.stringify(next);
    monotonic(prev, next);
    expect(JSON.stringify(prev)).toBe(prevJson);
    expect(JSON.stringify(next)).toBe(nextJson);
  });
});

describe('gaugeColor', () => {
  it('hits red, amber, and green at the empty, half, and full stops', () => {
    expect(gaugeColor(0)).toBe('#d9372b');
    expect(gaugeColor(0.5)).toBe('#e0a100');
    expect(gaugeColor(1)).toBe('#2fb344');
    expect(gaugeColor(-0.2)).toBe('#d9372b');
    expect(gaugeColor(2)).toBe('#2fb344');
    expect(gaugeColor(Number.NaN)).toBe('#d9372b');
  });

  it('steps through HSL between the stops', () => {
    expect(gaugeColor(0.25)).toBe('#e06312');
    expect(gaugeColor(0.75)).toBe('#7bca17');
    expect(gaugeColor(0.25)).not.toBe(gaugeColor(0));
    expect(gaugeColor(0.75)).not.toBe(gaugeColor(1));
  });
});
