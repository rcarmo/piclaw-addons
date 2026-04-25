/**
 * Minimal protobuf encoder/decoder for ESPHome voice assistant messages.
 * No external dependencies — hand-rolled varint + field encoding.
 *
 * Wire types: 0=varint, 2=length-delimited
 * Field tag:  (field_number << 3) | wire_type
 */

// ── Encoding ─────────────────────────────────────────────────────────────────

export function encodeVarint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) {
    buf.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  buf.push(n & 0x7f);
  return new Uint8Array(buf);
}

function tag(field: number, wireType: number): Uint8Array {
  return encodeVarint((field << 3) | wireType);
}

export function encodeUint32(field: number, n: number): Uint8Array {
  if (!n) return new Uint8Array(0);
  const t = tag(field, 0);
  const v = encodeVarint(n);
  const out = new Uint8Array(t.length + v.length);
  out.set(t); out.set(v, t.length);
  return out;
}

export function encodeBool(field: number, b: boolean): Uint8Array {
  return b ? encodeUint32(field, 1) : new Uint8Array(0);
}

export function encodeString(field: number, s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  const data = new TextEncoder().encode(s);
  return encodeBytes(field, data);
}

export function encodeBytes(field: number, data: Uint8Array): Uint8Array {
  if (!data.length) return new Uint8Array(0);
  const t = tag(field, 2);
  const l = encodeVarint(data.length);
  const out = new Uint8Array(t.length + l.length + data.length);
  out.set(t); out.set(l, t.length); out.set(data, t.length + l.length);
  return out;
}

export function encodeEmbedded(field: number, msg: Uint8Array): Uint8Array {
  return encodeBytes(field, msg);
}

export function encodeFixed32(field: number, n: number): Uint8Array {
  const t = encodeVarint((field << 3) | 5); // wire type 5 = 32-bit
  const out = new Uint8Array(t.length + 4);
  out.set(t);
  new DataView(out.buffer).setUint32(t.length, n, true); // little-endian
  return out;
}

export function encodeFloat(field: number, f: number): Uint8Array {
  const t = encodeVarint((field << 3) | 5);
  const out = new Uint8Array(t.length + 4);
  out.set(t);
  new DataView(out.buffer).setFloat32(t.length, f, true);
  return out;
}

export function getFixed32(fields: ParsedField[], tag: number): number {
  const f = fields.find(f => f.tag === tag && f.wire === 5);
  if (!f) return 0;
  const b = f.value as number; // stored as uint32
  return b;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── Decoding ─────────────────────────────────────────────────────────────────

export interface DecodeResult {
  value: number | Uint8Array;
  next: number;
}

export function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) return { value: result, pos };
  }
  return { value: result, pos };
}

export type ParsedField = { tag: number; wire: number; value: number | Uint8Array };

export function parseMessage(buf: Uint8Array): ParsedField[] {
  const fields: ParsedField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagResult = readVarint(buf, pos);
    pos = tagResult.pos;
    const wire = tagResult.value & 0x07;
    const fieldNum = tagResult.value >>> 3;

    if (wire === 0) {
      const { value, pos: next } = readVarint(buf, pos);
      pos = next;
      fields.push({ tag: fieldNum, wire, value });
    } else if (wire === 2) {
      const { value: len, pos: next } = readVarint(buf, pos);
      pos = next;
      fields.push({ tag: fieldNum, wire, value: buf.slice(pos, pos + (len as number)) });
      pos += len as number;
  // Handle wire type 5 (32-bit) in parseMessage
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break;
      const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0, true);
      fields.push({ tag: fieldNum, wire, value: v });
      pos += 4;
    } else {
    }
  }
  return fields;
}

export function getString(fields: ParsedField[], tag: number): string {
  const f = fields.find(f => f.tag === tag && f.wire === 2);
  return f ? new TextDecoder().decode(f.value as Uint8Array) : "";
}

export function getUint32(fields: ParsedField[], tag: number): number {
  const f = fields.find(f => f.tag === tag && f.wire === 0);
  return f ? f.value as number : 0;
}

export function getBool(fields: ParsedField[], tag: number): boolean {
  return getUint32(fields, tag) !== 0;
}

export function getBytes(fields: ParsedField[], tag: number): Uint8Array {
  const f = fields.find(f => f.tag === tag && f.wire === 2);
  return f ? f.value as Uint8Array : new Uint8Array(0);
}

export function getAllBytes(fields: ParsedField[], tag: number): Uint8Array[] {
  return fields.filter(f => f.tag === tag && f.wire === 2).map(f => f.value as Uint8Array);
}
