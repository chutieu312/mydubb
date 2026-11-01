// A minimal ZIP writer and reader (deflate, UTF-8 names, no directories, no ZIP64) so that the
// upload package can be made, and read back, without a dependency.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const DOS_DATE = (1 << 5) | 1; // 1980-01-01, fixed so the same files give the same ZIP

/** @param {{ name: string, data: Buffer }[]} entries @returns {Buffer} */
export function writeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(central.reduce((n, b) => n + b.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Reads a ZIP through its central directory and checks every CRC. @returns {{ name: string, data: Buffer }[]} */
export function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a ZIP: no end-of-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const packed = buffer.subarray(dataAt, dataAt + packedSize);
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported method ${method}`);
    const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
