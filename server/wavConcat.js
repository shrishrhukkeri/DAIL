/**
 * Concatenate PCM WAV buffers into one file with correct RIFF/data sizes.
 * Clamps claimed chunk sizes to remaining bytes so corrupt headers cannot
 * over-read past the buffer.
 */
export function concatWavBuffers(parts) {
  if (!parts?.length) return Buffer.alloc(0);
  if (parts.length === 1) return sanitizeWavHeaders(parts[0]);

  const pcmParts = [];
  let totalPcm = 0;
  let header = null;

  for (const buf of parts) {
    const dataIdx = findDataChunk(buf);
    if (dataIdx < 0) continue;
    const claimed = buf.readUInt32LE(dataIdx + 4);
    const maxPcm = Math.max(0, buf.length - (dataIdx + 8));
    const dataSize = Math.min(claimed, maxPcm);
    const pcm = buf.subarray(dataIdx + 8, dataIdx + 8 + dataSize);
    if (!header) header = Buffer.from(buf.subarray(0, dataIdx));
    pcmParts.push(pcm);
    totalPcm += pcm.length;
  }

  if (!header || !pcmParts.length) return sanitizeWavHeaders(parts[0]);

  const out = Buffer.alloc(header.length + 8 + totalPcm);
  header.copy(out, 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write('data', header.length);
  out.writeUInt32LE(totalPcm, header.length + 4);
  let offset = header.length + 8;
  for (const p of pcmParts) {
    p.copy(out, offset);
    offset += p.length;
  }
  return out;
}

/** Find the PCM `data` chunk (skip `fmt ` / other RIFF chunks). */
export function findDataChunk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return -1;
  let offset = 12; // after RIFF....WAVE
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return offset;
    // RIFF chunk sizes are even-padded
    offset += 8 + size + (size % 2);
  }
  // Fallback: first literal "data" that looks like a chunk header
  let idx = buf.indexOf(Buffer.from('data'));
  while (idx >= 0 && idx + 8 <= buf.length) {
    if (idx >= 12) return idx;
    idx = buf.indexOf(Buffer.from('data'), idx + 4);
  }
  return -1;
}

/** Rewrite RIFF and data sizes to match the actual buffer length. */
export function sanitizeWavHeaders(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  const dataIdx = findDataChunk(buf);
  if (dataIdx < 0) return buf;
  const out = Buffer.from(buf);
  const maxPcm = Math.max(0, out.length - (dataIdx + 8));
  const claimed = out.readUInt32LE(dataIdx + 4);
  const dataSize = Math.min(claimed, maxPcm);
  out.writeUInt32LE(dataSize, dataIdx + 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out.subarray(0, dataIdx + 8 + dataSize);
}
