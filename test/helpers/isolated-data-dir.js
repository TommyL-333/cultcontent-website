'use strict';
/**
 * Every lib/ccc-*.js module resolves its SQLite file path from DATA_DIR at
 * `require()` time. Call this BEFORE requiring any of them, so each test
 * file gets its own throwaway database instead of touching the real one at
 * the repo root (or whatever DATA_DIR the developer has set locally).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function useIsolatedDataDir(prefix = 'ccc-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;
  return function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  };
}

module.exports = { useIsolatedDataDir };
