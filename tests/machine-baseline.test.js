import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachineBaseline, measureSpeedIndex } from '../electron/machine-baseline.js';

const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('measureSpeedIndex', () => {
  it('returns a positive finite ops-per-ms value', () => {
    const small = measureSpeedIndex({ iterations: 40 });
    expect(Number.isFinite(small)).toBe(true);
    expect(small).toBeGreaterThan(0);
    const full = measureSpeedIndex();
    expect(Number.isFinite(full)).toBe(true);
    expect(full).toBeGreaterThan(0);
  });
});

describe('createMachineBaseline', () => {
  it('round-trips speedIndex, measuredAt, and cpuCount', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-baseline-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'machine-baseline.json');
    const first = createMachineBaseline({
      filePath,
      now: () => 1700000000000,
      cpuCount: () => 8,
      measure: () => 123.5,
    });
    expect(first.get()).toBeNull();
    expect(first.refresh()).toEqual({
      speedIndex: 123.5,
      measuredAt: 1700000000000,
      cpuCount: 8,
    });
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['cpuCount', 'measuredAt', 'speedIndex']);
    const second = createMachineBaseline({
      filePath,
      now: () => 1,
      cpuCount: () => 1,
      measure: () => 1,
    });
    expect(second.get()).toEqual({
      speedIndex: 123.5,
      measuredAt: 1700000000000,
      cpuCount: 8,
    });
    expect(second.load()).toEqual(second.get());
  });
});
