'use strict';

const fsDefault = require('fs');

const SERVER_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const FINDING_ID = /^[a-z0-9-]{1,80}$/;
const MAX_IDS = 40;
const MAX_SERVERS = 50;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function cleanIds(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < value.length; i += 1) {
    const id = value[i];
    if (typeof id !== 'string' || !FINDING_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_IDS) break;
  }
  return ids;
}

/**
 * Acknowledged performance findings, per server. An id stays hidden across
 * restarts until that finding has been seen again and then goes away.
 * @param {{ filePath: string, fs?: object }} opts
 */
function createIssueAckStore(opts) {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const fs = opts && opts.fs && typeof opts.fs === 'object' ? opts.fs : fsDefault;
  /** @type {Record<string, string[]> | null} */
  let cache = null;

  function load() {
    if (cache) return cache;
    /** @type {Record<string, string[]>} */
    const out = {};
    if (!filePath) {
      cache = out;
      return out;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      for (let i = 0; i < keys.length && Object.keys(out).length < MAX_SERVERS; i += 1) {
        const key = keys[i];
        if (!SERVER_ID.test(key)) continue;
        const ids = cleanIds(parsed[key]);
        if (ids.length) out[key] = ids;
      }
    }
    cache = out;
    return out;
  }

  function save(data) {
    cache = data;
    if (!filePath) return;
    const path = require('path');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * @param {unknown} serverId
   * @returns {string[]}
   */
  function list(serverId) {
    if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) return [];
    const data = load();
    return data[serverId] ? data[serverId].slice() : [];
  }

  /**
   * @param {unknown} serverId
   * @param {unknown} findingId
   * @returns {boolean}
   */
  function ack(serverId, findingId) {
    if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) return false;
    if (typeof findingId !== 'string' || !FINDING_ID.test(findingId)) return false;
    const data = load();
    const ids = data[serverId] ? data[serverId].slice() : [];
    if (ids.includes(findingId)) return true;
    if (ids.length >= MAX_IDS) return false;
    if (!data[serverId] && Object.keys(data).length >= MAX_SERVERS) return false;
    ids.push(findingId);
    data[serverId] = ids;
    save(data);
    return true;
  }

  /**
   * @param {unknown} serverId
   * @param {unknown} findingId
   * @returns {boolean}
   */
  function release(serverId, findingId) {
    if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) return false;
    if (typeof findingId !== 'string' || !FINDING_ID.test(findingId)) return false;
    const data = load();
    const ids = data[serverId];
    if (!ids || !ids.includes(findingId)) return false;
    const next = ids.filter((id) => id !== findingId);
    if (next.length) data[serverId] = next;
    else delete data[serverId];
    save(data);
    return true;
  }

  return { list, ack, release };
}

module.exports = { createIssueAckStore };
