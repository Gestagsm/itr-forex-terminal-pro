'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const warnedFiles = new Set();

function parseRows(buffer, gz, filename) {
  const data = gz ? zlib.gunzipSync(buffer) : buffer;
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  const nulBytes = (text.match(/\0/g) || []).length;
  const lines = text.replace(/\0/g, '').split(/\r?\n/);
  const rows = [];
  let invalidLines = 0;

  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    try {
      const row = JSON.parse(cleaned);
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        invalidLines++;
        continue;
      }
      rows.push(row);
    } catch {
      invalidLines++;
    }
  }

  if (buffer.length && !rows.length) {
    throw new Error(`No valid JSON rows in ${path.basename(filename)}`);
  }
  return { rows, nulBytes, invalidLines };
}

function readSource(file, gz) {
  return parseRows(fs.readFileSync(file), gz, file);
}

function readHistoryBlock(block, onWarning = () => {}) {
  let parsed;
  try {
    parsed = readSource(block.file, block.gz);
  } catch (primaryError) {
    if (block.gz) throw primaryError;
    const filename = path.basename(block.file);
    const archivePath = path.join(
      path.dirname(path.dirname(block.file)),
      '.archive',
      `${filename}.gz`
    );
    if (!fs.existsSync(archivePath)) throw primaryError;
    parsed = readSource(archivePath, true);
    warnOnce(block.file, `Used archived copy for unreadable journal ${filename}`, onWarning);
  }

  if (parsed.nulBytes || parsed.invalidLines) {
    const filename = path.basename(block.file);
    const details = [];
    if (parsed.nulBytes) details.push(`${parsed.nulBytes} NUL padding bytes removed`);
    if (parsed.invalidLines) details.push(`${parsed.invalidLines} invalid lines skipped`);
    warnOnce(block.file, `Recovered ${filename}: ${details.join(', ')}`, onWarning);
  }
  return parsed.rows;
}

function warnOnce(file, message, onWarning) {
  if (warnedFiles.has(file)) return;
  warnedFiles.add(file);
  onWarning(message);
}

module.exports = { readHistoryBlock };
