import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatWavBuffers, findDataChunk, sanitizeWavHeaders } from './wavConcat.js';

function makeWav(pcmBytes, sampleRate = 24000) {
  const dataSize = pcmBytes.length;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const header = Buffer.alloc(12 + 8 + 16 + 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(4 + (8 + 16) + (8 + dataSize), 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  fmt.copy(header, 20);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBytes]);
}

test('sanitizeWavHeaders clamps oversized data chunk', () => {
  const pcm = Buffer.alloc(200, 1);
  const wav = makeWav(pcm);
  const bad = Buffer.from(wav);
  const dataIdx = findDataChunk(bad);
  bad.writeUInt32LE(999999, dataIdx + 4);

  const fixed = sanitizeWavHeaders(bad);
  const fixedIdx = findDataChunk(fixed);
  assert.equal(fixed.readUInt32LE(fixedIdx + 4), 200);
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8);
  assert.equal(fixed.length, dataIdx + 8 + 200);
});

test('concatWavBuffers rewrites RIFF/data sizes for multi-chunk', () => {
  const a = makeWav(Buffer.alloc(100, 2));
  const b = makeWav(Buffer.alloc(150, 3));
  const out = concatWavBuffers([a, b]);
  const dataIdx = findDataChunk(out);
  assert.equal(out.readUInt32LE(dataIdx + 4), 250);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out.length, dataIdx + 8 + 250);
});

test('concatWavBuffers survives corrupt claimed size on a part', () => {
  const a = makeWav(Buffer.alloc(80, 4));
  const b = makeWav(Buffer.alloc(40, 5));
  const corrupt = Buffer.from(b);
  corrupt.writeUInt32LE(999999, findDataChunk(corrupt) + 4);
  const out = concatWavBuffers([a, corrupt]);
  const dataIdx = findDataChunk(out);
  assert.equal(out.readUInt32LE(dataIdx + 4), 120);
  assert.ok(out.length === dataIdx + 8 + 120);
});
