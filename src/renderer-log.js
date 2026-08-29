(function initRendererLogForwarding() {
  if (!window.flc || typeof window.flc.log !== 'function') {
    return;
  }

  const sendToMain = window.flc.log.bind(window.flc);
  let forwarding = false;

  /**
   * @param {string} level
   * @param {unknown[]} args
   */
  function forward(level, args) {
    if (forwarding) {
      return;
    }
    forwarding = true;
    try {
      sendToMain(level, ...args);
    } finally {
      forwarding = false;
    }
  }

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = function patchedConsoleError(...args) {
    originalError(...args);
    forward('error', args);
  };

  console.warn = function patchedConsoleWarn(...args) {
    originalWarn(...args);
    forward('warn', args);
  };

  forward('info', ['Renderer log forwarding enabled']);
})();
