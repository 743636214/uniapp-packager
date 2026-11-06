import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.mjs';
import { Jobs } from '../server/jobs.mjs';
import { environmentGuidance } from '../server/guidance.mjs';
import { sdkCatalog, inspectSdk, importSdk } from '../server/sdks.mjs';
import { createApp } from '../server/index.mjs';
const keys = ['node', 'java', 'hbuilder', 'compiler', 'platform', 'buildTools', 'adb', 'sdkManager'];
const checks = ok => keys.map(key => ({ key, name: key, ok }));
async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unipack-setup-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
async function write(file, text = '') { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
async function fixtureSdk(root, version = '5.34') {
  const template = path.join(root, 'HBuilder-Integrate-AS');
  await write(path.join(template, 'settings.gradle'), "include ':simpleDemo'");
  await write(path.join(template, 'gradle/wrapper/gradle-wrapper.properties'), 'distributionUrl=test');
  await write(path.join(template, 'simpleDemo/src/main/AndroidManifest.xml'), '<manifest/>');
  await write(path.join(template, 'simpleDemo/libs/uniapp-v8-release.aar'), 'fixture');
  await write(path.join(root, 'sdk.json'), JSON.stringify({ name: 'Fixture SDK', version, template: 'HBuilder-Integrate-AS', moduleName: 'simpleDemo', bundled: true }));
}
test('环境引导按系统、架构和当前项目生成，自动项与手动项明确区分', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    const r = environmentGuidance(checks(false), { platform, arch, environment: {}, project: { compileSdk: 35, buildTools: '35.0.0', sdkVersion: '5.34' } });
    assert.equal(r.ready, false); assert.equal(r.summary.missing, 7);
    assert.deepEqual(r.summary.automatic, ['java', 'platform', 'buildTools', 'adb']);
    assert(r.summary.manual.includes('hbuilder'));
    assert(r.checks.find(c => c.key === 'platform').guide.reason.includes('35'));
    assert(r.checks.find(c => c.key === 'buildTools').guide.reason.includes('35.0.0'));
    assert(r.checks.find(c => c.key === 'hbuilder').guide.steps.join().includes(platform === 'darwin' ? '/Applications/HBuilderX.app' : platform === 'win32' ? 'HBuilderX.exe' : 'Linux CLI'));
  }
  const armWindows = environmentGuidance(checks(false), { platform: 'win32', arch: 'arm64', environment: {} });
  assert(!armWindows.summary.automatic.includes('java'));
});
test('可选 SDK 管理器和可视化工程编译器缺失不会阻挡构建', () => {
  const list = checks(true).map(c => ['sdkManager', 'compiler'].includes(c.key) ? { ...c, ok: false } : c);
  const r = environmentGuidance(list, { platform: 'darwin', arch: 'arm64', environment: {}, project: { frontendMode: 'hbuilder' } });
  assert.equal(r.ready, true); assert.equal(r.summary.missing, 0);
  assert.equal(r.checks.find(c => c.key === 'sdkManager').required, false);
});
test('新项目默认 SDK，可切换为自定义，密钥更新不会切换已有模板，搬家按 SDK ID 重定位', async t => {
  const root = await temporary(t), sdkRoot = path.join(root, 'sdks'), bundled = path.join(sdkRoot, 'bundled');
  await fixtureSdk(bundled);
  const store = await new Store(path.join(root, 'data'), sdkRoot).init();
  const p = await store.upsert({ name: 'New' });
  assert.equal(p.sdkId, 'bundled'); assert.equal(p.moduleName, 'simpleDemo'); assert(p.androidDir.startsWith(bundled));
  const existing = await store.upsert({ name: 'Existing', androidDir: '/custom/native' });
  await store.upsert({ secrets: { storePassword: 'kept-private' } }, existing.id);
  assert.equal(store.get(existing.id).androidDir, '/custom/native'); assert.equal(store.get(existing.id).sdkId, '');
  await store.upsert({ sdkId: '', androidDir: '/another/native' }, p.id);
  assert.equal(store.get(p.id).androidDir, '/another/native');
  await store.upsert({ sdkId: 'bundled', androidDir: '/ignored/path' }, p.id);
  const moved = path.join(root, 'new-machine/sdks'); await fs.mkdir(path.dirname(moved), { recursive: true }); await fs.rename(sdkRoot, moved);
  const restored = await new Store(store.dir, moved).init();
  assert(restored.get(p.id).androidDir.startsWith(moved));
  assert.equal(restored.get(existing.id).androidDir, '/custom/native');
});
test('SDK 导入可复用完整官方目录，排除私密配置与签名，且不把未支持版本设为默认', async t => {
  const root = await temporary(t), source = path.join(root, 'download'), library = path.join(root, 'library');
  await fixtureSdk(source);
  await write(path.join(source, 'signing.properties'), 'private'); await write(path.join(source, 'release.jks'), 'private');
  const store = await new Store(path.join(root, 'data'), library).init(), jobs = await new Jobs(store).init();
  const j = jobs.start('sdk-import', null, job => importSdk({ sourceDir: source, version: '5.34' }, jobs, job, library));
  await jobs.get(j.id).completion; const result = jobs.get(j.id); assert.equal(result.status, 'succeeded');
  const catalog = await sdkCatalog('', library); assert.equal(catalog.items.length, 1);
  assert.equal((await inspectSdk(catalog.items[0].directory)).moduleName, 'simpleDemo');
  assert.equal(await fs.access(path.join(catalog.items[0].directory, 'release.jks')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(catalog.items[0].directory, 'signing.properties')).then(() => true, () => false), false);
  await store.defaultSdk(catalog.items[0].id);
  const oldSource = path.join(root, 'old'); await fixtureSdk(oldSource, '5.33');
  const old = jobs.start('sdk-import', null, job => importSdk({ sourceDir: oldSource, version: '5.33' }, jobs, job, library)); await jobs.get(old.id).completion;
  await assert.rejects(store.defaultSdk(jobs.get(old.id).result.sdkId), /构建预设/);
  const unsafe = jobs.start('sdk-import', null, job => importSdk({ sourceDir: library, version: '5.34' }, jobs, job, library)); await jobs.get(unsafe.id).completion;
  assert.equal(jobs.get(unsafe.id).status, 'failed');
});
test('SDK 列表拒绝逃逸路径；缺失库有可恢复的空状态', async t => {
  const root = await temporary(t);
  assert.deepEqual((await sdkCatalog('', path.join(root, 'missing'))).items, []);
  await fixtureSdk(path.join(root, 'outside'));
  await write(path.join(root, 'library/unsafe/sdk.json'), JSON.stringify({ version: '5.34', moduleName: 'simpleDemo', template: '../../outside/HBuilder-Integrate-AS' }));
  assert.equal((await sdkCatalog('', path.join(root, 'library'))).items.length, 0);
});
test('HTTP 新建项目默认内置 SDK，检测按当前项目等级，安装仍需明确许可', async t => {
  const root = await temporary(t), sdkRoot = path.join(root, 'sdks'); await fixtureSdk(path.join(sdkRoot, 'bundled'));
  const app = await createApp({ store: new Store(path.join(root, 'data'), sdkRoot), port: 0 }); t.after(() => new Promise(resolve => app.server.close(resolve)));
  const response = await fetch(app.url + '/api/session'), session = await response.json();
  const headers = { 'Content-Type': 'application/json', Cookie: response.headers.get('set-cookie').split(';')[0], 'X-UniPack-Token': session.token };
  const request = async (url, data, method = 'POST') => fetch(app.url + url, { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) });
  const p = await (await request('/api/projects', { name: 'New', compileSdk: 35, buildTools: '35.0.0' })).json(); assert.equal(p.sdkId, 'bundled');
  const report = await (await request('/api/environment/check', { projectId: p.id })).json(); assert(report.checks.some(c => c.name === 'Android Platform 35')); assert(report.summary);
  assert.equal((await request('/api/environment/install', { projectId: p.id })).status, 400);
  assert.equal((await request('/api/sdks/default', { sdkId: '../invalid' }, 'PUT')).status, 400);
});
