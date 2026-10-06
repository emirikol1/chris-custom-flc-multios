import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkForAppUpdate,
  compareVersions,
  installerDestination,
  parseAllowedUpdateUrl,
  planUpdate,
  prefersDebInstaller,
  resolveAllowedRedirect,
  saveUrlToFile,
} from '../electron/app-update.js';

const EXE = 'ChrisCustomFLC-MultiOS-0.6.0-windows-setup.exe';
const DEB = 'ChrisCustomFLC-MultiOS-0.6.0-linux.deb';
const APPIMAGE = 'ChrisCustomFLC-MultiOS-0.6.0-linux.AppImage';
const GOOD_URL = `https://github.com/emirikol1/chris-custom-flc-multios/releases/download/v0.6.0/${EXE}`;

function release(tag, assets) {
  return { tag_name: tag, assets };
}

describe('compareVersions', () => {
  it('orders dotted versions and ignores a leading v', () => {
    expect(compareVersions('0.5.0', 'v0.6.0')).toBe(-1);
    expect(compareVersions('v0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('nope', '0.5.0')).toBeNull();
  });
});

describe('prefersDebInstaller', () => {
  it('uses the deb for debian-family ids and the AppImage otherwise', () => {
    expect(prefersDebInstaller('ID=linuxmint\nID_LIKE="ubuntu debian"\n')).toBe(true);
    expect(prefersDebInstaller('ID=fedora\nID_LIKE="rhel fedora"\n')).toBe(false);
    expect(prefersDebInstaller('PRETTY_NAME="Ubuntu mention"\nID=arch\n')).toBe(false);
  });
});

describe('update URL allowlist', () => {
  it('accepts only https on the release hosts', () => {
    expect(parseAllowedUpdateUrl(GOOD_URL)?.hostname).toBe('github.com');
    expect(parseAllowedUpdateUrl('https://release-assets.githubusercontent.com/file')).not.toBeNull();
    expect(parseAllowedUpdateUrl('http://github.com/file')).toBeNull();
    expect(parseAllowedUpdateUrl('https://user:pw@github.com/file')).toBeNull();
    expect(parseAllowedUpdateUrl('https://example.com/installer.exe')).toBeNull();
  });

  it('refuses a redirect off the allowlist', () => {
    expect(resolveAllowedRedirect(GOOD_URL, 'https://objects.githubusercontent.com/a')).toMatch(/^https:\/\/objects\.githubusercontent\.com\//);
    expect(resolveAllowedRedirect(GOOD_URL, 'https://example.com/a')).toBeNull();
    expect(resolveAllowedRedirect(GOOD_URL, 'http://github.com/a')).toBeNull();
  });
});

describe('planUpdate', () => {
  it('downloads the windows installer only when the release is newer', () => {
    const planned = planUpdate(release('v0.6.0', [{ name: EXE, browser_download_url: GOOD_URL }]), {
      currentVersion: '0.5.0',
      platform: 'win32',
    });
    expect(planned).toMatchObject({ action: 'download', version: '0.6.0', fileName: EXE });
  });

  it('picks deb or AppImage from the linux id', () => {
    const assets = [
      { name: DEB, browser_download_url: GOOD_URL.replace(EXE, DEB) },
      { name: APPIMAGE, browser_download_url: GOOD_URL.replace(EXE, APPIMAGE) },
    ];
    expect(planUpdate(release('v0.6.0', assets), {
      currentVersion: '0.5.0',
      platform: 'linux',
      osRelease: 'ID=linuxmint\n',
    }).fileName).toBe(DEB);
    expect(planUpdate(release('v0.6.0', assets), {
      currentVersion: '0.5.0',
      platform: 'linux',
      osRelease: 'ID=fedora\n',
    }).fileName).toBe(APPIMAGE);
  });

  it('does not download when this copy is current or newer', () => {
    const body = release('v0.5.0', [{ name: EXE, browser_download_url: GOOD_URL }]);
    expect(planUpdate(body, { currentVersion: '0.5.0', platform: 'win32' }).action).toBe('current');
    expect(planUpdate(release('v0.4.0', []), { currentVersion: '0.5.0', platform: 'win32' }).action).toBe('ahead');
  });

  it('rejects an asset whose address is not on the allowlist', () => {
    const planned = planUpdate(release('v0.6.0', [{
      name: EXE,
      browser_download_url: 'https://example.com/installer.exe',
    }]), { currentVersion: '0.5.0', platform: 'win32' });
    expect(planned).toEqual({ action: 'error', code: 'no-asset' });
  });
});

describe('installerDestination', () => {
  it('stays inside the downloads directory and rejects other names', () => {
    const dir = path.join(os.tmpdir(), 'flc-update-dest');
    expect(installerDestination(dir, EXE)).toBe(path.resolve(dir, EXE));
    expect(() => installerDestination(dir, `../${EXE}`)).toThrow();
    expect(() => installerDestination(dir, 'notes.txt')).toThrow();
  });
});

describe('checkForAppUpdate', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('saves the installer and returns no address or directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-update-'));
    dirs.push(dir);
    const seen = [];
    const result = await checkForAppUpdate({
      currentVersion: '0.5.0',
      platform: 'win32',
      downloadsDir: dir,
      download: true,
      fetchRelease: async () => release('v0.6.0', [{ name: EXE, browser_download_url: GOOD_URL }]),
      request: async (url) => {
        seen.push(url);
        return { statusCode: 200, headers: {}, stream: Readable.from([Buffer.from('installer-bytes')]) };
      },
    });
    expect(seen).toEqual([GOOD_URL]);
    expect(fs.readFileSync(path.join(dir, EXE), 'utf8')).toBe('installer-bytes');
    expect(result.status).toBe('downloaded');
    expect(result.fileName).toBe(EXE);
    expect(result.message).toContain('Close this app');
    expect(result.message).toContain('Downloads folder');
    expect(JSON.stringify(result)).not.toMatch(/https?:|\/home\/|\/tmp\//);
  });

  it('reports a newer release without saving it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-update-'));
    dirs.push(dir);
    let called = false;
    const result = await checkForAppUpdate({
      currentVersion: '0.5.0',
      platform: 'win32',
      downloadsDir: dir,
      fetchRelease: async () => release('v0.6.0', [{ name: EXE, browser_download_url: GOOD_URL }]),
      request: async () => {
        called = true;
        return { statusCode: 200, headers: {}, stream: Readable.from([Buffer.from('installer-bytes')]) };
      },
    });
    expect(called).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(result.status).toBe('available');
    expect(result.version).toBe('0.6.0');
    expect(result.fileName).toBe(EXE);
    expect(result.message).toBe('Version 0.6.0 is available.');
    expect(result.message).not.toContain('Close this app');
    expect(JSON.stringify(result)).not.toMatch(/https?:|\/home\/|\/tmp\//);
  });

  it('does not save a file when already current', async () => {
    let called = false;
    const result = await checkForAppUpdate({
      currentVersion: '0.5.0',
      platform: 'win32',
      downloadsDir: os.tmpdir(),
      fetchRelease: async () => release('v0.5.0', [{ name: EXE, browser_download_url: GOOD_URL }]),
      request: async () => {
        called = true;
        return { statusCode: 200, headers: {}, stream: Readable.from([Buffer.from('nope')]) };
      },
    });
    expect(called).toBe(false);
    expect(result.status).toBe('current');
    expect(result.message).toContain('0.5.0');
  });

  it('follows only an allowlisted redirect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-update-'));
    dirs.push(dir);
    const dest = installerDestination(dir, EXE);
    const calls = [];
    await saveUrlToFile(GOOD_URL, dest, async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return {
          statusCode: 302,
          headers: { location: 'https://objects.githubusercontent.com/pkg' },
          stream: Readable.from([]),
        };
      }
      return { statusCode: 200, headers: {}, stream: Readable.from([Buffer.from('ok')]) };
    });
    expect(calls[1]).toBe('https://objects.githubusercontent.com/pkg');
    expect(fs.readFileSync(dest, 'utf8')).toBe('ok');
  });
});

describe('update check is request-only', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');

  it('registers the check and download on the button and not at startup', () => {
    expect(main).toMatch(/ipcMain\.handle\('app:check-update'/);
    expect(main).toMatch(/ipcMain\.handle\('app:download-update'/);
    expect(preload).toContain("download: () => ipcRenderer.invoke('app:download-update')");
    const startup = main.slice(main.indexOf('app.whenReady'));
    expect(startup).not.toMatch(/checkForAppUpdate|app:check-update|app:download-update|releases\/latest/);
    const init = appJs.slice(appJs.indexOf('function init'));
    expect(init).not.toContain('handleCheckUpdate');
    expect(init).not.toContain('handleDownloadUpdate');
    expect(appJs).toContain('addEventListener("click", onUpdateButtonClick)');
    const checkFn = appJs.slice(appJs.indexOf('async function handleCheckUpdate'), appJs.indexOf('async function handleDownloadUpdate'));
    expect(checkFn).toContain('update?.check');
    expect(checkFn).not.toContain('update?.download');
    expect(checkFn).toContain('setUpdateButton("download")');
    const downloadFn = appJs.slice(appJs.indexOf('async function handleDownloadUpdate'), appJs.indexOf('function onUpdateButtonClick'));
    expect(downloadFn).toContain('update?.download');
    expect(downloadFn).toContain('persist: true');
    expect(downloadFn).toContain('status === "downloaded"');
  });
});
