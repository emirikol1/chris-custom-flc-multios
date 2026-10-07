/**
 * Map a WebGL probe failure string to a fixed log code.
 * The original text may be an exception message and must not be written to a log.
 * Check order matters: the GL-error string also mentions context creation.
 * @param {unknown} reason
 * @returns {'no_context' | 'context_lost' | 'gl_error' | 'exception' | 'probe_failed'}
 */
function classifyWebglReason(reason) {
  const text = String(reason == null ? '' : reason).toLowerCase();
  if (text.includes('context is lost') || text.includes('context lost') || text.includes('context_lost')) {
    return 'context_lost';
  }
  if (text.includes('reported an error') || text.includes('gl_error') || text.includes('gl error')) {
    return 'gl_error';
  }
  if (text.includes('context creation failed') || text.includes('no_context') || text.includes('no context')) {
    return 'no_context';
  }
  if (text.includes('exception')) return 'exception';
  return 'probe_failed';
}

module.exports = {
  classifyWebglReason,
};
