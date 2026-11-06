import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectSource } from '../server/source-config.mjs';
import { planSourceFill } from '../public/source-autofill.js';
import { createApp } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { prepareFrontend, locateResources } from '../server/builder.mjs';
import { validateProject } from '../server/utils.mjs';
async function temp(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unipack-source-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
async function write(root, file, text) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); }
const manifest = { name: '测试应用', appid: '__UNI__TEST01', versionName: '1.2.3', versionCode: 123, 'app-plus': { distribute: { android: { packagename: 'com.example.app' } } } };
test('JSONC 传统项目与 src CLI 项目均提取完整身份，忽略其他平台 AppID、包名与依赖版本', async t => {
  for (const file of ['manifest.json', 'src/manifest.json']) {
    const root = await temp(t);
    await write(root, file, '// comment\n' + JSON.stringify({ ...manifest, 'mp-weixin': { appid: 'wx-secret' }, 'app-harmony': { distribute: { bundleName: 'com.wrong.harmony' } } }).replace(/}$/, ',}'));
    await write(root, 'package.json', '{"name":"cli-package","version":"99.0.0","dependencies":{"@dcloudio/uni-app":"*"}}');
    const info = await inspectSource(root);
    assert.equal(info.appName, '测试应用'); assert.equal(info.appId, '__UNI__TEST01'); assert.equal(info.packageName, 'com.example.app');
    assert.equal(info.versionName, '1.2.3'); assert.equal(info.versionCode, '123'); assert.deepEqual(info.missing, []);
    assert.equal(info.fieldSources.packageName.file, file); assert(!JSON.stringify(info).includes('wx-secret'));
  }
});
test('Vue3 TS 配置与 production dotenv 分层解析优先于旧生成 manifest，未执行源码', async t => {
  const root = await temp(t), marker = path.join(root, 'must-not-exist');
  await write(root, 'src/manifest.json', JSON.stringify({ ...manifest, appid: '__UNI__OLD', versionName: 'old' }));
  await write(root, 'manifest.config.ts', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unsafe');\nconst VERSION = '2.4.0'\nexport default defineManifestConfig({ name: VITE_APP_TITLE, appid: env.VITE_UNI_APPID, versionName: VERSION, versionCode: 240, 'app-plus': { distribute: { android: { packagename: import.meta.env.VITE_ANDROID_PACKAGE_NAME } } } })`);
  await write(root, 'env/.env', 'VITE_APP_TITLE="生产应用"\nVITE_UNI_APPID=__UNI__BASE\nVITE_ANDROID_PACKAGE_NAME=com.example.base\nSECRET_TOKEN=must-never-return\n');
  await write(root, 'env/.env.local', 'VITE_UNI_APPID=__UNI__LOCAL');
  await write(root, 'env/.env.production', 'VITE_UNI_APPID=__UNI__PRODUCTION\nVITE_ANDROID_PACKAGE_NAME=com.example.production');
  await write(root, 'env/.env.production.local', 'VITE_UNI_APPID=__UNI__FINAL');
  const info = await inspectSource(root);
  assert.equal(info.appId, '__UNI__FINAL'); assert.equal(info.versionName, '2.4.0'); assert.equal(info.versionCode, '240'); assert.equal(info.packageName, 'com.example.production');
  assert.equal(info.fieldSources.appId.file, 'manifest.config.ts'); assert.equal(info.fieldSources.appId.envFile, 'env/.env.production.local');
  assert.equal(await fs.access(marker).then(() => true, () => false), false); assert(!JSON.stringify(info).includes('must-never-return'));
});
test('缺失 Android 包名不从 Harmony 或 npm 名称推测；动态属性不回退到旧值', async t => {
  const root = await temp(t);
  await write(root, 'src/manifest.json', JSON.stringify({ ...manifest, 'app-plus': {}, 'app-harmony': { distribute: { bundleName: 'com.wrong.harmony' } } }));
  await write(root, 'manifest.config.ts', "export default defineManifestConfig({ appid: getAppId(), versionCode: Number(process.env.VERSION), versionName: '3.0' })");
  const info = await inspectSource(root);
  assert.equal(info.packageName, ''); assert.equal(info.appId, ''); assert.equal(info.versionCode, ''); assert.equal(info.versionName, '3.0');
  assert(info.missing.includes('packageName')); assert(info.missing.includes('appId')); assert(info.warnings.length >= 2);
});
test('env 变量引用支持展开及安全拒绝循环；无 manifest 目录不当作 UniApp', async t => {
  const root = await temp(t);
  await write(root, 'manifest.json', '{"appid":"", "versionName":"1", "versionCode":"1"}');
  await write(root, '.env', 'BASE=__UNI__EXPANDED\nVITE_UNI_APPID=${BASE}\nVITE_ANDROID_PACKAGE_NAME=${LOOP}\nLOOP=${VITE_ANDROID_PACKAGE_NAME}');
  const info = await inspectSource(root); assert.equal(info.appId, '__UNI__EXPANDED'); assert.equal(info.packageName, '');
  const folder = await temp(t); await write(folder, '.env', 'VITE_UNI_APPID=__UNI__NOT_A_PROJECT');
  assert.equal((await inspectSource(folder)).isUniApp, false);
  await assert.rejects(inspectSource(path.join(folder, 'missing')), /源码文件夹/);
});
test('TS 普通默认对象、注释、转义字符与同名小程序嵌套字段正确读取', async t => {
  const root = await temp(t);
  await write(root, 'manifest.config.js', "// appid: 'wrong'\nexport default {name: '测\\u8bd5 } 应用', appid: '__UNI__RIGHT', versionName: '1.0', versionCode: '10', 'mp-weixin': {appid: 'wrong'}, 'app-plus': {distribute: {android: {packageName: 'com.test.literal'}}}};");
  const info = await inspectSource(root); assert.equal(info.appName, '测试 } 应用'); assert.equal(info.appId, '__UNI__RIGHT'); assert.equal(info.packageName, 'com.test.literal');
});
test('自动回填空白和未改过的自动值，保留手填值并返回差异；缺项清理旧自动值', () => {
  const first = planSourceFill({ appName: '新应用', name: '新项目', appId: '', packageName: 'com.manual.app' }, { appName: '源码应用', name: '源码应用', appId: '__UNI__NEW', packageName: 'com.source.app', versionCode: '10' });
  assert.equal(first.updates.appId, '__UNI__NEW'); assert.equal(first.updates.appName, '源码应用'); assert.equal(first.updates.name, '源码应用');
  assert(!Object.hasOwn(first.updates, 'packageName')); assert(first.conflicts.includes('packageName'));
  const next = planSourceFill({ appId: '__UNI__OLD', versionCode: '99', name: '项目自定义名称' }, { appId: '__UNI__NEW', versionCode: '10', name: '源码名称' }, { previous: { appId: '__UNI__OLD', versionCode: '99' }, touched: new Set(['versionCode']) });
  assert.equal(next.updates.appId, '__UNI__NEW'); assert(!Object.hasOwn(next.updates, 'versionCode')); assert(!Object.hasOwn(next.updates, 'name'));
  const missing = planSourceFill({ appId: '__UNI__OLD', packageName: 'com.manual.app' }, {}, { previous: { appId: '__UNI__OLD' } });
  assert.equal(missing.updates.appId, ''); assert(!Object.hasOwn(missing.updates, 'packageName'));
});
test('读取期间的手动编辑保持，主动使用源码值才替换已填写的身份', () => {
  const p = planSourceFill({ appId: '__UNI__EDITED' }, { appId: '__UNI__SOURCE' }, { snapshot: { appId: '' } });
  assert(!Object.hasOwn(p.updates, 'appId')); assert(p.conflicts.includes('appId'));
  const forced = planSourceFill({ appId: '__UNI__EDITED', name: '工作项目' }, { appId: '__UNI__SOURCE', name: '源码名称' }, { replace: true });
  assert.equal(forced.updates.appId, '__UNI__SOURCE'); assert(!Object.hasOwn(forced.updates, 'name'));
});
test('手填版本只写入构建副本，保留原源码；导出版本不符时停止', async t => {
  const root = await temp(t), source = path.join(root, 'source'), copy = path.join(root, 'copy');
  const json = JSON.stringify(manifest), ts = "export default defineManifestConfig({versionName: '1.2.3', versionCode: '123'})";
  await write(source, 'manifest.json', json); await write(source, 'manifest.config.ts', ts);
  const p = validateProject({ sourceDir: source, appId: '__UNI__TEST01', appName: '测试应用', versionName: '4.5.6', versionCode: '456', frontendMode: 'hbuilder' });
  await prepareFrontend(p, {}, copy);
  assert.equal(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'), json);
  assert.equal(await fs.readFile(path.join(source, 'manifest.config.ts'), 'utf8'), ts);
  const built = JSON.parse(await fs.readFile(path.join(copy, 'manifest.json'), 'utf8'));
  assert.equal(built.versionName, '4.5.6'); assert.equal(built.versionCode, '456');
  const copiedTs = await fs.readFile(path.join(copy, 'manifest.config.ts'), 'utf8'); assert(copiedTs.includes('"4.5.6"')); assert(copiedTs.includes('"456"'));
  const resources = path.join(copy, 'unpackage/resources', p.appId, 'www');
  for (const file of ['app-service.js', 'app-config.js', '__uniappview.html']) await write(resources, file, 'fixture');
  const resource = { id: p.appId, version: { name: 'old', code: '456' }, plus: { 'uni-app': { compilerVersion: '5.34' } } };
  await write(resources, 'manifest.json', JSON.stringify(resource)); await assert.rejects(locateResources(copy, p), /动态版本配置/);
  resource.version.name = '4.5.6'; resource.version.code = '123'; await write(resources, 'manifest.json', JSON.stringify(resource)); await assert.rejects(locateResources(copy, p), /版本码/);
  resource.version.code = '456'; await write(resources, 'manifest.json', JSON.stringify(resource)); assert.equal((await locateResources(copy, p)).manifest.version.name, '4.5.6');
});
test('本机识别 API 返回身份和来源，不返回其他配置或私密值；新前端模块可访问', async t => {
  const root = await temp(t); await write(root, 'manifest.json', JSON.stringify({ ...manifest, secretPassword: 'not-returned' }));
  const app = await createApp({ store: new Store(path.join(root, 'data')), port: 0 }); t.after(() => new Promise(resolve => app.server.close(resolve)));
  const session = await fetch(app.url+'/api/session'), token = (await session.json()).token;
  const response = await fetch(app.url+'/api/source/inspect', { method: 'POST', headers: { Cookie: session.headers.get('set-cookie').split(';')[0], 'X-UniPack-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({sourceDir: root}) });
  assert.equal(response.status, 200); const body = await response.text(); assert(body.includes('com.example.app')); assert(!body.includes('not-returned'));
  assert.equal((await fetch(app.url+'/source-autofill.js')).status, 200);
});
