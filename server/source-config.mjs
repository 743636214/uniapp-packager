import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, exists, expandPath, parseJsonc } from './utils.mjs';

const definitions = {
  appName: { paths: [['name']], env: ['VITE_APP_TITLE', 'VITE_APP_NAME'], valid: v => v.length <= 100 },
  appId: { paths: [['appid']], env: ['VITE_UNI_APPID'], valid: v => /^[A-Za-z0-9_.-]{4,100}$/.test(v) },
  packageName: { paths: [['app-plus', 'distribute', 'android', 'packagename'], ['app-plus', 'distribute', 'android', 'packageName'], ['app-plus', 'distribute', 'android', 'package']], env: ['VITE_ANDROID_PACKAGE_NAME', 'VITE_APP_ANDROID_PACKAGE_NAME', 'VITE_ANDROID_PACKAGENAME', 'ANDROID_PACKAGE_NAME'], valid: v => /^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/.test(v) },
  versionName: { paths: [['versionName']], env: ['VITE_APP_VERSION_NAME', 'VITE_APP_VERSION'], valid: v => v.length <= 100 },
  versionCode: { paths: [['versionCode']], env: ['VITE_APP_VERSION_CODE'], valid: v => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 2100000000 },
};
export const identityFields = Object.keys(definitions);
async function readSmall(root, file) {
  const full = path.join(root, file), stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) return '';
  if (stat.size > 2 * 1024 * 1024) throw new AppError(`${file} 超过 2 MB，无法自动识别，请手动填写应用身份`);
  return fs.readFile(full, 'utf8');
}
// Only tokens and literal object properties are inspected. Source modules are never imported/evaluated.
function tokens(text) {
  const result = [];
  for (let i = 0; i < text.length;) {
    const start = i, c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) { i = text.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (['"', "'", '`'].includes(c)) {
      let value = '', dynamic = false; i++;
      while (i < text.length && text[i] !== c) {
        if (c === '`' && text.startsWith('${', i)) dynamic = true;
        if (text[i] === '\\') {
          const next = text[++i];
          if (next === 'u' && /^[a-fA-F0-9]{4}$/.test(text.slice(i + 1, i + 5))) { value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 5; }
          else { value += ({ n: '\n', r: '\r', t: '\t' })[next] ?? next ?? ''; i++; }
        } else value += text[i++];
      }
      if (i >= text.length) break;
      i++; result.push({ type: dynamic ? 'unknown' : 'string', value, start, end: i }); continue;
    }
    const word = text.slice(i).match(/^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/);
    if (word) { i += word[0].length; result.push({ type: /^\d/.test(word[0]) ? 'number' : 'identifier', value: word[0], start, end: i }); continue; }
    result.push({ type: 'punct', value: c, start, end: ++i });
  }
  return result;
}
function staticManifest(text, env) {
  const ts = tokens(text), constants = new Map();
  function resolve(expression, seen = new Set()) {
    if (expression.length === 1 && ['string', 'number'].includes(expression[0].type)) return { value: expression[0].value };
    const reference = expression.map(t => t.value).join('');
    const match = reference.match(/^(?:env\.|import\.meta\.env\.|process\.env\.)?([A-Za-z_$][\w$]*)$/);
    if (!match) return {};
    const key = match[1];
    if (expression.length === 1 && constants.has(key) && !seen.has(key)) return resolve(constants.get(key), new Set([...seen, key]));
    return env.get(key) || {};
  }
  for (let i = 0; i < ts.length - 3; i++) {
    if (['const', 'let', 'var'].includes(ts[i].value) && ts[i + 1].type === 'identifier' && ts[i + 2].value === '=') {
      let end = i + 3;
      while (end < ts.length && ![';', ','].includes(ts[end].value) && !(end > i + 3 && /[\r\n]/.test(text.slice(ts[end - 1].end, ts[end].start)))) end++;
      constants.set(ts[i + 1].value, ts.slice(i + 3, end));
    }
  }
  let start = -1;
  for (let i = 0; i < ts.length - 2; i++) {
    if (ts[i].value !== 'export' || ts[i + 1].value !== 'default') continue;
    if (ts[i + 2].value === '{') start = i + 2;
    else if (ts[i + 2].value === 'defineManifestConfig' && ts[i + 3]?.value === '(' && ts[i + 4]?.value === '{') start = i + 4;
    break;
  }
  if (start < 0) return null;
  let index = start;
  const skipValue = () => {
    const beginning = index, stack = [];
    for (; index < ts.length; index++) {
      const value = ts[index].type === 'punct' ? ts[index].value : '';
      if (!stack.length && [',', '}'].includes(value)) break;
      if (['{', '[', '('].includes(value)) stack.push(value);
      if (['}', ']', ')'].includes(value)) stack.pop();
    }
    return ts.slice(beginning, index);
  };
  function object(depth = 0) {
    const result = new Map(); index++;
    if (depth > 30) throw new AppError('配置层级过深，请手动填写应用身份');
    while (index < ts.length && ts[index].value !== '}') {
      if (ts[index].value === ',') { index++; continue; }
      const key = ts[index++];
      if (!['identifier', 'string'].includes(key.type)) { skipValue(); continue; }
      if (ts[index]?.value !== ':') { result.set(key.value, resolve([key])); skipValue(); continue; }
      index++;
      result.set(key.value, ts[index]?.value === '{' ? { object: object(depth + 1) } : resolve(skipValue()));
    }
    index++;
    return result;
  }
  return object();
}
function lookup(root, keys, staticTree = false) {
  let value = root;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (staticTree) {
      if (!value?.has(key)) return { present: false };
      const node = value.get(key);
      if (index === keys.length - 1) return { present: true, ...node };
      value = node.object;
      if (!value) return { present: true };
    } else {
      if (!value || !Object.hasOwn(value, key)) return { present: false };
      value = value[key];
    }
  }
  return { present: true, value };
}
async function environmentValues(root, manifestText) {
  const vite = await readSmall(root, 'vite.config.ts') || await readSmall(root, 'vite.config.js');
  const envFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];
  const mentionsEnvDirectory = /(?:envDir\s*:\s*['"]\.?\/?env['"]|(?:resolve|join)\([^\n]*['"]env['"])/.test(manifestText + '\n' + vite);
  const useEnvDirectory = mentionsEnvDirectory || !await exists(path.join(root, '.env')) && await exists(path.join(root, 'env/.env'));
  const values = new Map();
  for (const name of envFiles) {
    const file = useEnvDirectory ? `env/${name}` : name, text = await readSmall(root, file);
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let raw = match[2], quote = raw[0];
      if (["'", '"'].includes(quote)) {
        const end = raw.lastIndexOf(quote); if (end <= 0) continue;
        raw = raw.slice(1, end); if (quote === '"') raw = raw.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
      } else raw = raw.replace(/\s*#.*$/, '').trim();
      values.set(match[1], { value: raw, envFile: file, variable: match[1] });
    }
  }
  function expand(key, seen = new Set()) {
    if (seen.has(key) || seen.size > 10 || !values.has(key)) return undefined;
    let invalid = false;
    const value = values.get(key).value.replace(/(?<!\\)\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_, a, b) => {
      const replacement = expand(a || b, new Set([...seen, key]));
      if (replacement === undefined) invalid = true;
      return replacement || '';
    }).replace(/\\\$/g, '$');
    return invalid ? undefined : value;
  }
  return new Map([...values].map(([key, data]) => [key, { ...data, value: expand(key) }]));
}
export async function inspectSource(sourceDir) {
  const root = expandPath(sourceDir);
  if (!root || !(await fs.stat(root).catch(() => null))?.isDirectory()) throw new AppError('请选择存在的 UniApp 源码文件夹');
  const warnings = [], manifests = [], sources = {}, values = {}, missing = [];
  let pkg = {};
  const packageText = await readSmall(root, 'package.json');
  if (packageText) try { pkg = parseJsonc(packageText); } catch { warnings.push('package.json 格式无法识别，请检查配置。'); }
  for (const file of ['src/manifest.json', 'manifest.json']) {
    const text = await readSmall(root, file);
    if (text) try {
      const data = parseJsonc(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) manifests.push({ file, data });
    } catch { warnings.push(`${file} 格式无法识别，请检查配置或手动填写。`); }
  }
  const configFile = await exists(path.join(root, 'manifest.config.ts')) ? 'manifest.config.ts' : 'manifest.config.js';
  const configText = await readSmall(root, configFile), env = await environmentValues(root, configText);
  const dynamic = configText ? staticManifest(configText, env) : null;
  if (configText && !dynamic) warnings.push(`${configFile} 使用了暂不支持的动态结构；请确认识别值，必要时手动填写。`);
  const recognized = manifests.length > 0 || !!configText || !!pkg.dependencies?.['@dcloudio/uni-app'] || !!pkg.devDependencies?.['@dcloudio/uni-app'];
  for (const [field, definition] of Object.entries(definitions)) {
    let candidate, file, property, fromDynamic = false;
    for (const manifestPath of definition.paths) {
      const node = dynamic && lookup(dynamic, manifestPath, true);
      if (node?.present) { candidate = node; file = configFile; property = manifestPath.join('.'); fromDynamic = true; break; }
    }
    if (!candidate) for (const item of manifests) {
      for (const manifestPath of definition.paths) {
        const node = lookup(item.data, manifestPath);
        if (node.present) { candidate = node; file = item.file; property = manifestPath.join('.'); break; }
      }
      if (candidate) break;
    }
    // Explicit dynamic properties cannot silently fall back to stale generated JSON or unrelated env values.
    if ((!candidate || !fromDynamic && candidate.value === '') && recognized) for (const key of definition.env) if (env.has(key)) { candidate = env.get(key); file = candidate.envFile; property = key; break; }
    const value = ['string', 'number'].includes(typeof candidate?.value) ? String(candidate.value).trim() : '';
    if (value && definition.valid(value)) {
      values[field] = value;
      sources[field] = { file, property, ...(candidate.envFile ? { envFile: candidate.envFile, variable: candidate.variable } : {}) };
    } else { values[field] = ''; missing.push(field); if (candidate) warnings.push(`${field} 未能解析为有效的固定值，请手动确认。`); }
  }
  const name = values.appName || pkg.name || path.basename(root);
  return { ...values, name, fieldSources: sources, missing, warnings, sourceDir: root,
    frontendMode: packageText && (await exists(path.join(root, 'vite.config.ts')) || await exists(path.join(root, 'vite.config.js')) || pkg.dependencies?.['@dcloudio/uni-app'] || pkg.devDependencies?.['@dcloudio/uni-app']) ? 'cli-vue3' : 'hbuilder',
    hasDependencies: await exists(path.join(root, 'node_modules')), isUniApp: recognized };
}
