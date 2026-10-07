'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The running app version. package.json "version" is the only place it is written.
 * Electron's packaged app, the installer names, and the GitHub release tag all
 * read that same field. Do not copy the number into another file.
 */
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

if (typeof APP_VERSION !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(APP_VERSION)) {
  throw new Error('package.json version is missing');
}

module.exports = { APP_VERSION };
