import { inflateRawSync } from 'node:zlib';
import { AppError } from './utils.mjs';

// Read selected small entries from a normal APK/ZIP without extracting arbitrary paths.
export function zipEntry(data, name, maxBytes = 8 * 1024 * 1024) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0) throw new AppError('APK ZIP 目录不完整');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw new AppError('APK ZIP 目录结构异常');
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20), size = data.readUInt32LE(offset + 24);
    const length = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const entryName = data.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (entryName === name) {
      if ((flags & 1) || size > maxBytes || compressed > maxBytes * 2) throw new AppError('APK 资源无法安全读取');
      if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new AppError('APK 资源头损坏');
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      if (start + compressed > data.length) throw new AppError('APK 资源不完整');
      const bytes = data.subarray(start, start + compressed);
      const result = method === 0 ? bytes : method === 8 ? inflateRawSync(bytes, { maxOutputLength: maxBytes }) : null;
      if (!result || result.length !== size) throw new AppError('APK 资源大小或压缩格式异常');
      return result;
    }
    offset += 46 + length + extra + comment;
  }
  throw new AppError(`APK 缺少资源：${name}`);
}
