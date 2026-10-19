'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { readHistoryBlock } = require('../history-block-reader');

test('recovers valid rows from NUL-padded and partially corrupt journal lines', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'itr-history-reader-'));
  try {
    const file = path.join(root, 'TAQ_EURUSD_13Oct2026_1200_to_1600.ndjson');
    await fs.writeFile(file, [
      JSON.stringify({ Timestamp: '2026-10-13 12:00:00', BID: 1.1 }),
      '\0\0',
      '{"broken":',
      JSON.stringify({ Timestamp: '2026-10-13 12:00:01', BID: 1.2 }),
      '',
    ].join('\n'));
    const warnings = [];
    const rows = readHistoryBlock({ file, gz: false }, message => warnings.push(message));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].BID, 1.1);
    assert.equal(rows[1].BID, 1.2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /NUL padding bytes removed/);
    assert.match(warnings[0], /invalid lines skipped/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the archived block when a journal contains no recoverable rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'itr-history-fallback-'));
  try {
    const journalDir = path.join(root, 'EURUSD', '.journal');
    const archiveDir = path.join(root, 'EURUSD', '.archive');
    const filename = 'TAQ_EURUSD_13Oct2026_1200_to_1600.ndjson';
    const journal = path.join(journalDir, filename);
    const archive = path.join(archiveDir, `${filename}.gz`);
    await fs.mkdir(journalDir, { recursive: true });
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(journal, Buffer.from([0, 0, 0, 0]));
    const archivedRow = { Timestamp: '2026-10-13 12:00:00', BID: 1.3 };
    await fs.writeFile(archive, zlib.gzipSync(`${JSON.stringify(archivedRow)}\n`));
    const warnings = [];
    const rows = readHistoryBlock({ file: journal, gz: false }, message => warnings.push(message));
    assert.deepEqual(rows, [archivedRow]);
    assert.match(warnings.join('\n'), /Used archived copy/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps the original block and reports when neither source has valid rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'itr-history-invalid-'));
  try {
    const file = path.join(root, 'TAQ_EURUSD_13Oct2026_1200_to_1600.ndjson');
    const original = Buffer.from([0, 0, 0, 0]);
    await fs.writeFile(file, original);
    assert.throws(
      () => readHistoryBlock({ file, gz: false }),
      /No valid JSON rows/
    );
    assert.deepEqual(await fs.readFile(file), original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
