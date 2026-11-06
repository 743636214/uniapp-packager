import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppError, exists, expandPath, readProperties } from './utils.mjs';
import { inspectSource } from './source-config.mjs';
export { inspectSource } from './source-config.mjs';

export async function importAndroid(store, { androidDir, sourceDir, name }) {
  const root = expandPath(androidDir);
  if (!await exists(path.join(root, 'settings.gradle')) && !await exists(path.join(root, 'settings.gradle.kts'))) throw new AppError('所选目录不是 Android 工程根目录');
  const app = await readProperties(path.join(root, 'app.properties')).catch(() => ({}));
  const signing = await readProperties(path.join(root, 'signing.properties')).catch(() => ({}));
  let source = sourceDir;
  if (!source) {
    const old = await fs.readFile(path.join(root, 'prepare_frontend.py'), 'utf8').catch(() => '');
    source = old.match(/^SOURCE\s*=\s*Path\(['"]([^'"]+)['"]\)/m)?.[1] || '';
  }
  const info = source && await exists(source) ? await inspectSource(source) : {};
  const binding = JSON.parse(await fs.readFile(path.join(root, 'appkey-binding.json'), 'utf8').catch(() => '{}'));
  return store.upsert({ name: name || app.appName || info.name || path.basename(root), sourceDir: source, androidDir: root,
    appName: app.appName || info.appName, appId: app.dcloudAppId || info.appId, packageName: app.applicationId || info.packageName || '',
    versionName: app.versionName || info.versionName, versionCode: app.versionCode || info.versionCode,
    minSdk: Number(app.minSdkVersion || 26), targetSdk: Number(app.targetSdkVersion || 30),
    certificateAlias: signing.keyAlias || 'release', certificatePath: signing.storeFile ? path.resolve(root, signing.storeFile) : '',
    expectedSha1: binding.certificateSha1 || '', frontendMode: info.frontendMode || 'cli-vue3',
    secrets: { dcloudAppKey: app.dcloudAppKey || '', amapAndroidKey: app.amapAndroidKey || '', storePassword: signing.storePassword || '', keyPassword: signing.keyPassword || '' } });
}
export async function browseDirectory(requested, kind = 'directory') {
  const current = expandPath(requested || os.homedir());
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => { throw new AppError('无法读取该目录，请检查路径与访问权限'); });
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(current, entry.name);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) directory = (await fs.stat(full).catch(() => null))?.isDirectory() || false;
    if (!directory && kind === 'directory') continue;
    if (!directory && kind === 'certificate' && !/\.(jks|keystore|p12|pfx)$/i.test(entry.name)) continue;
    items.push({ name: entry.name, path: full, directory });
    if (items.length >= 500) break;
  }
  items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'));
  return { current, parent: path.dirname(current), items };
}
export function exportProject(project) {
  const { secretBox, secrets, sourceDir, androidDir, certificatePath, id, createdAt, updatedAt, ...portable } = project;
  return { format: 'unipack-project', version: 1, project: portable, instructions: '导入后重新选择本机源码、Android 模板和原签名文件，并填写该项目的 Key 与密码。此文件不包含这些私密值。' };
}
