'use strict';

/** Public landing page for this repository. No query string. */
const PROJECT_PAGE = 'https://github.com/emirikol1/chris-custom-flc-multios';

/**
 * Open the project page in the OS browser when the target is that page.
 * Any other address is refused. `openExternal` is the OS launcher
 * (xdg-open, open, or the Windows shell association).
 * @param {unknown} target
 * @param {(url: string) => unknown} openExternal
 * @returns {boolean}
 */
function launchProjectPage(target, openExternal) {
  if (target !== PROJECT_PAGE || typeof openExternal !== 'function') return false;
  openExternal(PROJECT_PAGE);
  return true;
}

module.exports = {
  PROJECT_PAGE,
  launchProjectPage,
};
