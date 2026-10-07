'use strict';

/**
 * IPC channel names for the slow-server notice. The strings live here so the
 * join window, the black-screen notice, and the main process stay in lockstep.
 */

const IPC = Object.freeze({
  message: 'slowcache:message',
  copy: 'slowcache:copy',
  list: 'slowcache:list',
  dismiss: 'slowcache:dismiss',
  updated: 'slowcache:updated',
});

module.exports = { IPC };
