import { describe, expect, it } from 'vitest';
import { classifyWebglReason } from '../electron/webgl-reason.js';

describe('classifyWebglReason', () => {
  it('maps the probe strings onto the fixed log codes', () => {
    expect(classifyWebglReason('WebGL context creation failed')).toBe('no_context');
    expect(classifyWebglReason('WebGL context is lost')).toBe('context_lost');
    expect(classifyWebglReason('WebGL reported an error after context creation')).toBe('gl_error');
    expect(classifyWebglReason('WebGL probe failed')).toBe('probe_failed');
  });

  it('treats exception text as exception and anything else as probe_failed', () => {
    expect(classifyWebglReason('uncaught exception in probe')).toBe('exception');
    expect(classifyWebglReason('Cannot read properties of null')).toBe('probe_failed');
    expect(classifyWebglReason('')).toBe('probe_failed');
    expect(classifyWebglReason(undefined)).toBe('probe_failed');
    expect(classifyWebglReason(null)).toBe('probe_failed');
  });

  it('does not let the GL-error wording collapse into no_context', () => {
    expect(classifyWebglReason('GL_ERROR after context creation failed')).toBe('gl_error');
    expect(classifyWebglReason('context_lost during draw')).toBe('context_lost');
    expect(classifyWebglReason('no_context')).toBe('no_context');
  });
});