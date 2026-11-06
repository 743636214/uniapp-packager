import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const exists = async p => !!p && fs.access(p).then(() => true, () => false);
export const id = () => crypto.randomUUID();
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
export const expandPath = p => p ? path.resolve(String(p).replace(/^~(?=$|[/\\])/, os.homedir())) : '';
export const inside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${id()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function parseJsonc(input) {
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i], next = input[i + 1];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (c === '/' && next === '/') { while (i < input.length && input[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && next === '*') { i += 2; while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++; i++; out += ' '; }
    else out += c;
  }
  let clean = ''; quoted = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quoted) { clean += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') { quoted = true; clean += c; }
    else if (c !== ',' || !/^\s*[}\]]/.test(out.slice(i + 1))) clean += c;
  }
  return JSON.parse(clean.replace(/^\uFEFF/, ''));
}
const unescapeProp = s => s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, char) => hex ? String.fromCharCode(parseInt(hex, 16)) : ({ n: '\n', r: '\r', t: '\t', f: '\f' })[char] ?? char);
export function parseProperties(input) {
  const result = Object.create(null);
  for (const line of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    const match = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (match) result[unescapeProp(match[1])] = unescapeProp(match[2]);
  }
  return result;
}
export function propertiesText(values) {
  const escape = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/^ /, '\\ ');
  return Object.entries(values).map(([key, value]) => `${key}=${escape(value ?? '')}`).join('\n') + '\n';
}
export async function readProperties(file) { return parseProperties(await fs.readFile(file, 'utf8')); }
export const secretFields = ['dcloudAppKey', 'amapAndroidKey', 'storePassword', 'keyPassword'];
export function validateProject(data, previous = {}) {
  const str = (key, fallback = '') => String(data[key] ?? previous[key] ?? fallback).trim();
  const result = {
    id: previous.id || id(), name: str('name', '未命名项目'),
    sourceDir: expandPath(str('sourceDir')), androidDir: expandPath(str('androidDir')), sdkId: str('sdkId'),
    moduleName: str('moduleName', 'simpleDemo'), appId: str('appId'), packageName: str('packageName'),
    appName: str('appName') || str('name', 'App'), sdkVersion: str('sdkVersion', '5.34'),
    versionName: str('versionName'), versionCode: str('versionCode'),
    certificatePath: expandPath(str('certificatePath')), certificateAlias: str('certificateAlias', 'release'),
    expectedSha1: str('expectedSha1').replace(/[^a-fA-F0-9]/g, '').toUpperCase(),
    minSdk: Number(data.minSdk ?? previous.minSdk ?? 26), targetSdk: Number(data.targetSdk ?? previous.targetSdk ?? 30),
    compileSdk: Number(data.compileSdk ?? previous.compileSdk ?? 36), buildTools: str('buildTools', '36.0.0'),
    frontendMode: str('frontendMode', 'cli-vue3'),
    createdAt: previous.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (!result.name || result.name.length > 100) throw new AppError('项目名称须为 1–100 个字符');
  if (result.sdkId && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(result.sdkId)) throw new AppError('SDK 标识不正确');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result.moduleName)) throw new AppError('Android 模块名格式不正确');
  if (result.appId && !/^[A-Za-z0-9_.-]{4,100}$/.test(result.appId)) throw new AppError('AppID 格式不正确');
  if (result.packageName && !/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(result.packageName)) throw new AppError('Android 包名格式不正确');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(result.sdkVersion)) throw new AppError('SDK 版本格式不正确，例如 5.34');
  if (!/^\d+\.\d+\.\d+$/.test(result.buildTools)) throw new AppError('Build Tools 格式不正确');
  if (result.versionCode && !/^\d+$/.test(result.versionCode)) throw new AppError('版本码必须为整数');
  if (result.expectedSha1 && result.expectedSha1.length !== 40) throw new AppError('预期证书 SHA1 必须为 40 位十六进制');
  if (str('expectedSha1') && !/^[a-fA-F0-9:\s]+$/.test(str('expectedSha1'))) throw new AppError('证书 SHA1 只能包含十六进制字符和分隔冒号');
  if (!['cli-vue3', 'hbuilder'].includes(result.frontendMode)) throw new AppError('不支持的前端模式');
  for (const key of ['minSdk', 'targetSdk', 'compileSdk']) if (!Number.isInteger(result[key]) || result[key] < 21 || result[key] > 100) throw new AppError('Android SDK 等级须为 21–100');
  if (result.minSdk > result.targetSdk || result.targetSdk > result.compileSdk) throw new AppError('SDK 等级需满足 minSdk ≤ targetSdk ≤ compileSdk');
  return result;
}
export function dataDirectory() {
  if (process.env.UNIPACK_DATA_DIR) return expandPath(process.env.UNIPACK_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/UniPack');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'UniPack');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'unipack');
}
