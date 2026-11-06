import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, atomicWrite, exists, expandPath, id, inside } from './utils.mjs';

export const sdkDirectory = fileURLToPath(new URL('../sdks/', import.meta.url));
export const supportedSdkVersions = ['5.34'];
const validId = value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
export async function inspectSdk(sourceDir) {
  const root = expandPath(sourceDir);
  if (!root || !await exists(root)) throw new AppError('请先解压下载的 DCloud SDK，再选择解压后的文件夹');
  for (const relative of ['HBuilder-Integrate-AS', '', 'HBuilder-HelloUniApp']) {
    const directory = path.join(root, relative);
    const settings = await fs.readFile(path.join(directory, 'settings.gradle'), 'utf8').catch(() => '');
    for (const moduleName of [...settings.matchAll(/['"]:([A-Za-z][A-Za-z0-9_-]*)['"]/g)].map(m => m[1])) {
      if (await exists(path.join(directory, moduleName, 'src/main/AndroidManifest.xml')) && await exists(path.join(directory, 'gradle/wrapper/gradle-wrapper.properties')) && await exists(path.join(directory, moduleName, 'libs/uniapp-v8-release.aar'))) return { template: relative || '.', moduleName };
    }
  }
  throw new AppError('未找到完整的 uni-app 原生模板。请选择包含 HBuilder-Integrate-AS 的 SDK 解压目录，或包含 settings.gradle、uniapp-v8-release.aar 的标准工程');
}
export async function sdkCatalog(defaultId = '', root = sdkDirectory) {
  const items = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'sdk.json'), 'utf8'));
      const template = path.resolve(directory, metadata.template);
      if (!inside(directory, template) || !inside(await fs.realpath(directory), await fs.realpath(template))) continue;
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(metadata.moduleName) || !await exists(path.join(template, metadata.moduleName, 'src/main/AndroidManifest.xml'))) continue;
      items.push({ id: entry.name, name: String(metadata.name || `DCloud ${metadata.version}`), version: metadata.version, hbuilderVersion: metadata.hbuilderVersion || metadata.version, moduleName: metadata.moduleName, androidDir: template, directory, bundled: metadata.bundled === true, supported: supportedSdkVersions.includes(metadata.version) });
    } catch { /* An incomplete import is not selectable. */ }
  }
  items.sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.name.localeCompare(b.name));
  return { directory: root, defaultId: items.find(s => s.id === defaultId && s.supported)?.id || items.find(s => s.bundled && s.supported)?.id || items.find(s => s.supported)?.id || '', items };
}
export function sdkProjectFields(sdk) { return { sdkId: sdk.id, androidDir: sdk.androidDir, moduleName: sdk.moduleName, sdkVersion: sdk.version }; }
export async function importSdk(data, jobs, job, root = sdkDirectory) {
  const source = await fs.realpath(expandPath(data.sourceDir || '')).catch(() => '');
  if (!source) throw new AppError('请先选择已解压的 DCloud SDK 目录');
  if (inside(source, root) || inside(root, source)) throw new AppError('请选择 SDK 库之外的下载目录，已入库的 SDK 无需再次导入');
  const version = String(data.version || '').trim();
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new AppError('请填写下载页面标注的 SDK 版本，例如 5.34');
  const info = await inspectSdk(source), sdkId = `${version}-${id().slice(0, 8)}`;
  const stage = path.join(root, `.import-${job.id}`), destination = path.join(root, sdkId);
  const ignored = new Set(['.git', '.gradle', '.idea', 'build', 'node_modules', 'local.properties', 'signing.properties', 'app.properties', 'appkey-binding.json']);
  jobs.step(job, '复制 SDK 到工具的 sdks 目录', 15);
  try {
    await fs.cp(source, stage, { recursive: true, dereference: false, verbatimSymlinks: true, filter: async file => {
      if (job.controller.signal.aborted) throw new AppError('任务已取消');
      if (ignored.has(path.basename(file)) || path.basename(file).startsWith('.') || /\.(?:jks|keystore|p12|pfx|apk|aab)$/i.test(file)) return false;
      if ((await fs.lstat(file)).isSymbolicLink()) throw new AppError('SDK 中存在符号链接，请使用官方 SDK 解压目录');
      return true;
    } });
    jobs.step(job, '校验 SDK 模板并加入列表', 90);
    await inspectSdk(stage);
    await atomicWrite(path.join(stage, 'sdk.json'), JSON.stringify({ name: `DCloud ${version} · 自行导入`, version, ...info, bundled: false }, null, 2));
    if (job.controller.signal.aborted) throw new AppError('任务已取消');
    await fs.rename(stage, destination);
    return { sdkId, message: `DCloud ${version} 已加入 SDK 库。${supportedSdkVersions.includes(version) ? '可在项目中切换使用。' : '此版本尚无构建预设，当前不能出包；请继续使用 5.34。'}` };
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw new AppError('工具的 sdks 目录不可写，请把 UniPack 放到自己的可写目录（如 codes），再重试');
    throw error;
  } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); }
}
