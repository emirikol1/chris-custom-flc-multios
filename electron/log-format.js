const { redactForLog } = require('./log-redact');

/**
 * @param {unknown} arg
 * @returns {boolean}
 */
function shouldRedactArg(arg) {
  if (arg && typeof arg === 'object' && ('password' in arg || 'username' in arg)) {
    return true;
  }
  if (typeof arg === 'string' && /^https?:\/\//i.test(arg) && arg.includes('@')) {
    return true;
  }
  return false;
}

/**
 * @param {unknown} arg
 * @returns {unknown}
 */
function safeLogArg(arg) {
  if (shouldRedactArg(arg)) {
    return redactForLog(/** @type {object | string} */ (arg));
  }
  return arg;
}

/**
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
function safeLogArgs(args) {
  return args.map(safeLogArg);
}

module.exports = {
  shouldRedactArg,
  safeLogArg,
  safeLogArgs,
};
