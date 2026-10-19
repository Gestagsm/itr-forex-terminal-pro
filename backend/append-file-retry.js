'use strict';

const fs = require('fs');

const RETRYABLE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 500];

function appendFileWithRetry(file, data, {
  appendFileSync = fs.appendFileSync,
  wait = ms => Atomics.wait(waitCell, 0, 0, ms),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      appendFileSync(file, data);
      return;
    } catch (error) {
      if (!RETRYABLE_ERRORS.has(error.code) || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      wait(RETRY_DELAYS_MS[attempt]);
    }
  }
}

module.exports = { appendFileWithRetry };
