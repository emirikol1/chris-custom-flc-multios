import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../electron/app-version.js';

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('app version source', () => {
  it('reads the version only from package.json', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(APP_VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(read('RELEASE-NOTES.md').startsWith(`# v${pkg.version}\n`)).toBe(true);
  });

  it('does not copy the current version into the app or the install docs', () => {
    const pkg = JSON.parse(read('package.json'));
    const surfaces = [
      'src/index.html',
      'src/app.js',
      'src/styles.css',
      'electron/main.js',
      'electron/preload.js',
      'README.md',
    ];
    for (const rel of surfaces) {
      expect(read(rel).includes(pkg.version), rel).toBe(false);
    }
    const badge = read('src/index.html').match(/id="app-version"[^>]*>/);
    expect(badge).toBeTruthy();
    expect(read('src/index.html')).toMatch(/id="app-version" hidden><\/span>/);
    expect(read('src/app.js')).toContain('window.flc?.version');
    expect(read('electron/preload.js')).toContain("invoke('app:get-version')");
    expect(read('electron/main.js')).toContain("handle('app:get-version'");
    expect(read('electron/main.js')).not.toContain('pkg.version');
    expect(read('electron/main.js')).not.toContain('app.getVersion');
    expect(read('README.md')).not.toMatch(/releases\/download\/v\d/);
    expect(read('README.md')).not.toMatch(/ChrisCustomFLC-MultiOS-\d/);
  });
});
