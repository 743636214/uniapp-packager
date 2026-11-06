import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { Store } from '../server/store.mjs';
import { Jobs } from '../server/jobs.mjs';
import { parseJsonc, parseProperties, propertiesText, validateProject } from '../server/utils.mjs';
import { exportProject } from '../server/projects.mjs';
import { androidArchive, validateArchiveNames } from '../server/install.mjs';
import { locateResources, patchManifest, prepareFrontend, verifyApk } from '../server/builder.mjs';
import { createApp } from '../server/index.mjs';
import { zipEntry } from '../server/zip.mjs';

async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unipack-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const appkey = '1234567890abcdef1234567890abcdef';

test('Key 和密码密文落盘，空输入保留，配置导出不携带私密值和本机路径', async t => {
  const dir = await temp(t), store = await new Store(dir).init();
  const p = await store.upsert({ name: '示例', sourceDir: '/private/source', androidDir: '/private/android', certificatePath: '/private/release.jks', appId: '__UNI__TEST', packageName: 'com.example.app', secrets: { dcloudAppKey: appkey, storePassword: 'password-for-tests' } });
  const raw = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
  assert(!raw.includes(appkey)); assert(!raw.includes('password-for-tests'));
  assert(!JSON.stringify(p).includes(appkey)); assert.equal(p.hasSecrets.dcloudAppKey, true);
  await store.upsert({ name: '更新', secrets: { dcloudAppKey: '' } }, p.id);
  assert.equal(store.get(p.id).secrets.dcloudAppKey, appkey);
  const exported = JSON.stringify(exportProject(store.get(p.id)));
  assert(!exported.includes('/private/')); assert(!exported.includes(appkey)); assert(!exported.includes('password-for-tests')); assert(!exported.includes('secretBox'));
  const restored = await new Store(dir).init(); assert.equal(restored.get(p.id).secrets.dcloudAppKey, appkey);
});
test('配置校验拒绝包名、模块注入和不合理 SDK 等级', () => {
  assert.throws(() => validateProject({ packageName: 'com.a; echo bad' }));
  assert.throws(() => validateProject({ moduleName: 'app:other' }));
  assert.throws(() => validateProject({ minSdk: 36, targetSdk: 30 }));
  assert.throws(() => validateProject({ appId: '../../escape' }));
  assert.throws(() => validateProject({ expectedSha1: 'abc' }));
});
test('Properties 保留密码中的等号、反斜线、换行、前导空格和中文', () => {
  const input = { password: ' p=word:\\a\n中文', path: 'C:/Program Files/JDK' };
  assert.deepEqual({ ...parseProperties(propertiesText(input)) }, input);
});
test('JSONC 可读取注释和尾逗号，URL 和字符串中的标点保持原值', () => {
  const json = parseJsonc('{ // app\n "url":"https://a.test/x", "value":",}", "arr":[1,2,], /*x*/ }');
  assert.deepEqual(json, { url: 'https://a.test/x', value: ',}', arr: [1, 2] });
});
test('任务日志对跨数据块的 Key 脱敏，并保留 UTF-8 中文', async t => {
  const dir = await temp(t), store = await new Store(dir).init(), jobs = await new Jobs(store).init();
  const job = { secretValues: [appkey], logs: [], controller: new AbortController() };
  await jobs.run(job, process.execPath, ['-e', `process.stdout.write('${appkey.slice(0, 12)}');setTimeout(()=>process.stdout.write('${appkey.slice(12)} 中文\\n'),30)`]);
  const text = job.logs.map(l => l.text).join('\n'); assert(!text.includes(appkey)); assert(text.includes('•••••• 中文'));
});
test('取消任务会终止所属进程并让等待方退出', async t => {
  const store = await new Store(await temp(t)).init(), jobs = await new Jobs(store).init();
  const job = { secretValues: [], logs: [], controller: new AbortController() };
  const promise = jobs.run(job, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  setTimeout(() => job.controller.abort(), 50);
  await assert.rejects(promise, /任务已取消/);
});
test('Android 下载匹配指定平台和固定命令行版本，拒绝压缩包路径穿越', () => {
  const metadata = `<remotePackage path="cmdline-tools;19.0"><archives><archive><host-os>windows</host-os><complete><checksum type="sha1">${'a'.repeat(40)}</checksum><url>commandlinetools-win-123_latest.zip</url></complete></archive></archives></remotePackage>`;
  assert.equal(androidArchive(metadata, 'windows').url, 'https://dl.google.com/android/repository/commandlinetools-win-123_latest.zip');
  assert.throws(() => androidArchive(metadata, 'linux'));
  assert.throws(() => validateArchiveNames(['../../outside'])); assert.throws(() => validateArchiveNames(['C:\\outside']));
  validateArchiveNames(['./cmdline-tools/bin/sdkmanager', 'cmdline-tools/lib/a.jar']);
});
test('前端副本使用所选编译器，源码和原依赖保持原样', async t => {
  const root = await temp(t), source = path.join(root, 'source'), target = path.join(root, 'copy');
  const hbuilder = path.join(root, process.platform === 'darwin' ? 'HBuilderX.app' : 'HBuilderX');
  const compiler = process.platform === 'darwin' ? path.join(hbuilder, 'Contents/HBuilderX/plugins/uniapp-cli-vite/node_modules') : path.join(hbuilder, 'plugins/uniapp-cli-vite/node_modules');
  const write = async (p, value) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, value); };
  await write(path.join(source, 'package.json'), JSON.stringify({ dependencies: { '@dcloudio/uni-app': 'old', vendor: '1' } }));
  await write(path.join(source, 'src/manifest.json'), '{"appid":"__UNI__OLD","name":"old"}');
  await write(path.join(source, 'node_modules/@dcloudio/uni-app/package.json'), '{"version":"old"}');
  await write(path.join(source, 'node_modules/vendor/index.js'), 'module.exports=1');
  await write(path.join(compiler, '@dcloudio/uni-app/package.json'), '{"version":"new"}');
  await write(path.join(compiler, '@dcloudio/vite-plugin-uni/bin/uni.js'), 'console.log(1)');
  const p = validateProject({ name: '示例', appName: '新名字', sourceDir: source, appId: '__UNI__NEW', versionName: '1.2', versionCode: '12' });
  await prepareFrontend(p, { hbuilderPath: hbuilder }, target);
  assert.equal(JSON.parse(await fs.readFile(path.join(source, 'src/manifest.json'), 'utf8')).appid, '__UNI__OLD');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'src/manifest.json'), 'utf8')).appid, '__UNI__NEW');
  assert.equal(await fs.realpath(path.join(target, 'node_modules/@dcloudio/uni-app')), await fs.realpath(path.join(compiler, '@dcloudio/uni-app')));
  assert.equal(await fs.realpath(path.join(target, 'node_modules/vendor')), await fs.realpath(path.join(source, 'node_modules/vendor')));
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8')).dependencies['@dcloudio/uni-app'], 'new');
});
test('导出资源的 AppID、版本、完整性不匹配时会阻止后续打包', async t => {
  const root = await temp(t), dir = path.join(root, 'unpackage/resources/__UNI__TEST/www');
  await fs.mkdir(dir, { recursive: true });
  const manifest = { id: '__UNI__TEST', version: { name: '1.0', code: 1 }, plus: { 'uni-app': { compilerVersion: '4.36' } } };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(locateResources(root, { appId: '__UNI__TEST', sdkVersion: '5.34' }), /资源编译器/);
  manifest.plus['uni-app'].compilerVersion = '5.34'; await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(locateResources(root, { appId: '__UNI__TEST', sdkVersion: '5.34' }), /资源不完整/);
});
test('Manifest 仅保留一项 AppKey，并保留模板的明文网络选择', () => {
  const input = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="false" android:extractNativeLibs="true"><meta-data android:name="dcloud_appkey" android:value="old" /></application></manifest>';
  const output = patchManifest(input, {});
  assert.equal(output.match(/android:name="dcloud_appkey"/g).length, 1);
  assert(output.includes('${dcloudAppKey}')); assert(!output.includes('extractNativeLibs'));
  assert(output.includes('android:usesCleartextTraffic="false"')); assert(output.includes('tools:replace="android:usesCleartextTraffic"'));
});
test('APK 校验会拒绝签名不符和漏写 AppKey 的产物', async () => {
  const p = { packageName: 'com.example.app', secrets: { dcloudAppKey: appkey }, buildTools: '36.0.0' };
  const mock = stdout => ({ run: async () => ({ stdout }) , log() {} });
  await assert.rejects(verifyApk(p, { sdkRoot: '/tmp', javaHome: '/tmp' }, '/tmp/app.apk', { sha1: 'AA:BB' }, mock('Signer #1 certificate SHA-1 digest: deadbeef'), {}), /签名/);
  let calls = 0;
  const jobs = { run: async () => ({ stdout: ['Signer #1 certificate SHA-1 digest: aabb', "package: name='com.example.app' versionCode='1' versionName='1.0'", 'no appkey'][calls++] }), log() {} };
  await assert.rejects(verifyApk(p, { sdkRoot: '/tmp', javaHome: '/tmp' }, '/tmp/app.apk', { sha1: 'AA:BB' }, jobs, {}), /AppKey/);
});
test('APK ZIP 读取支持压缩资源，并拒绝缺项、截断和超限资源', () => {
  const name = Buffer.from('assets/manifest.json'), content = Buffer.from('{"name":"中文"}'), compressed = deflateRawSync(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  const zip = Buffer.concat([local, name, compressed, central, name, end]);
  assert.deepEqual(zipEntry(zip, 'assets/manifest.json'), content);
  assert.throws(() => zipEntry(zip, 'missing'), /缺少资源/);
  assert.throws(() => zipEntry(zip, 'assets/manifest.json', 1), /无法安全读取/);
  assert.throws(() => zipEntry(zip.subarray(0, zip.length - 3), 'assets/manifest.json'), /目录不完整/);
});
test('本机 API 拒绝无令牌、跨站和 DNS 重绑定，项目配置不返回私密值', async t => {
  const store = new Store(await temp(t)); const app = await createApp({ store, port: 0 });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const session = await fetch(app.url + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0], token = (await session.json()).token;
  assert.equal((await fetch(app.url + '/api/state')).status, 401);
  assert.equal((await fetch(app.url + '/api/state', { headers: { Origin: 'https://other.example', cookie, 'X-UniPack-Token': token } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(app.url + '/api/state', { headers: { Host: 'attacker.example', cookie, 'X-UniPack-Token': token } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
  assert.equal(badHost, 403);
  const headers = { cookie, 'X-UniPack-Token': token, 'Content-Type': 'application/json' };
  const created = await fetch(app.url + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: '测试', secrets: { dcloudAppKey: appkey } }) });
  assert.equal(created.status, 201); const p = await created.json(); assert(!JSON.stringify(p).includes(appkey));
  const exported = await (await fetch(app.url + `/api/projects/${p.id}/export`, { headers })).text(); assert(!exported.includes(appkey));
  const invalid = await fetch(app.url + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ packageName: 'bad package' }) }); assert.equal(invalid.status, 400);
});
