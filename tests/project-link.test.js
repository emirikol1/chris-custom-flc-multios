import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_PAGE, launchProjectPage } from '../electron/project-link.js';

const root = path.join(__dirname, '..');

describe('project page link', () => {
  it('opens only the repository landing page', () => {
    const opened = [];
    expect(launchProjectPage(PROJECT_PAGE, (url) => opened.push(url))).toBe(true);
    expect(opened).toEqual([PROJECT_PAGE]);
    expect(launchProjectPage('https://github.com/emirikol1/chris-custom-flc-multios.git', (url) => opened.push(url))).toBe(false);
    expect(launchProjectPage('https://example.com', (url) => opened.push(url))).toBe(false);
    expect(launchProjectPage(PROJECT_PAGE, null)).toBe(false);
    expect(opened).toEqual([PROJECT_PAGE]);
    expect(PROJECT_PAGE.includes('?')).toBe(false);
  });

  it('points the join-window title at that same page', () => {
    const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
    expect(html).toContain(`<a href="${PROJECT_PAGE}">Chris's Custom FLC MultiOS</a>`);
    const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
    expect(main).toContain('launchProjectPage');
    expect(main).toContain('shell.openExternal');
  });
});
