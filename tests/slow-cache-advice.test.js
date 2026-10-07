import { describe, expect, it } from 'vitest';
import { buildAdminMessage } from '../electron/slow-cache-advice.js';
import { buildTroubleshootingReport } from '../electron/ts-report.js';

describe('buildAdminMessage', () => {
  it('gives an nginx admin the two-line fix', () => {
    const text = buildAdminMessage({ proxy: 'nginx' });
    expect(text).toContain('stale-while-revalidate');
    expect(text).toContain('http2');
    expect(text).toContain('nginx -t');
    expect(text).toContain('listen 443 ssl http2;');
    expect(text).toContain("Sent from Chris's Custom FLC MultiOS (Foundry Light Client).");
    expect(text).toContain('Subject: Faster Foundry loads — small nginx tweak');
  });

  it('uses a shorter note for any other proxy', () => {
    const text = buildAdminMessage({ proxy: 'other' });
    expect(text).toContain('Your reverse proxy should enable HTTP/2 and send Cache-Control: public, max-age=0, stale-while-revalidate=604800 for those asset paths instead of no-cache');
    expect(text).not.toContain('nginx -t');
    expect(text).not.toContain('listen 443 ssl http2');
    expect(buildAdminMessage({ proxy: 'apache' })).toBe(text);
    expect(buildAdminMessage({})).toBe(text);
    expect(buildAdminMessage({ proxy: 'nginx', productName: 'Test Client' })).toContain('Sent from Test Client (Foundry Light Client).');
  });
});

describe('troubleshooting report cache line', () => {
  it('says slow (nginx) or ok', () => {
    const slow = buildTroubleshootingReport({ slowCache: { slow: true, proxy: 'nginx' } });
    expect(slow).toContain('Server cache config: slow (nginx)');
    const other = buildTroubleshootingReport({ slowCache: { slow: true, proxy: 'other' } });
    expect(other).toContain('Server cache config: slow (other)');
    const ok = buildTroubleshootingReport({});
    expect(ok).toContain('Server cache config: ok');
    expect(ok).not.toContain('slow (nginx)');
  });
});
