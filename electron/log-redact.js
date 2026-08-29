/**
 * @param {object | string} serverOrUrl
 * @returns {object | string}
 */
function redactForLog(serverOrUrl) {
  if (typeof serverOrUrl === 'string') {
    try {
      const parsed = new URL(serverOrUrl);
      if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
        return parsed.href;
      }
      return serverOrUrl;
    } catch {
      return serverOrUrl;
    }
  }
  if (serverOrUrl && typeof serverOrUrl === 'object') {
    const copy = { ...serverOrUrl };
    if ('password' in copy) {
      copy.password = '[REDACTED]';
    }
    if ('username' in copy) {
      copy.username = '[REDACTED]';
    }
    return copy;
  }
  return serverOrUrl;
}

module.exports = {
  redactForLog,
};
