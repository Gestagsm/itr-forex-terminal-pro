'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { appendFileWithRetry } = require('../append-file-retry');

test('retries transient busy-file errors and succeeds without losing the append', () => {
  let attempts = 0;
  const waits = [];
  appendFileWithRetry('busy.ndjson', '{"ok":true}\n', {
    appendFileSync(file, data) {
      attempts++;
      assert.equal(file, 'busy.ndjson');
      assert.equal(data, '{"ok":true}\n');
      if (attempts < 3) {
        const error = new Error('temporarily locked');
        error.code = 'EBUSY';
        throw error;
      }
    },
    wait: ms => waits.push(ms),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [20, 40]);
});

test('does not retry permanent filesystem errors', () => {
  let attempts = 0;
  assert.throws(() => appendFileWithRetry('disk.ndjson', 'data', {
    appendFileSync() {
      attempts++;
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    },
    wait() {
      assert.fail('permanent errors must not be retried');
    },
  }), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
});
