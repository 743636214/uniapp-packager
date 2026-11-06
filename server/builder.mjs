import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppError, atomicWrite, exists, inside, parseJsonc, propertiesText, readProperties, xml } from './utils.mjs';
import { binary, findCommand, hbuilderPaths, inspectEnvironment, toolEnv } from './environment.mjs';
import { zipEntry } from './zip.mjs';

export const presets = { '5.34': { gradle: '8.14.3', agp: '8.12.0', gradleHash: 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531' } };
const sourceIgnored = new Set(['node_modules', '.git', 'dist', 'unpackage', '.DS_Store', '.gradle', '.idea', '.data']);
const nativeIgnored = new Set([...sourceIgnored, 'build', 'frontend', 'apk', 'signing', '.frontend-previous', 'windows', 'test.jks']);
const fingerprint = (data, algorithm) => crypto.createHash(algorithm).update(data).digest('hex').toUpperCase().match(/.{2}/g).join(':');

export async function certificateInfo(project, environment, jobs, job) {
  if (!await exists(project.certificatePath)) throw new AppError('请选择存在的签名证书文件');
  if (!project.secrets.storePassword || !project.certificateAlias) throw new AppError('请填写证书别名和证书密码');
  const output = path.join(jobs.store.dir, 'temporary', `${job.id}.der`);
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  try {
    await jobs.run(job, path.join(environment.javaHome, 'bin', binary('keytool')), ['-exportcert', '-keystore', project.certificatePath, '-alias', project.certificateAlias, '-storepass:env', 'UNIPACK_STORE_PASSWORD', '-file', output], { env: toolEnv(environment, { UNIPACK_STORE_PASSWORD: project.secrets.storePassword }), silent: true });
    const cert = await fs.readFile(output);
    const info = { sha1: fingerprint(cert, 'sha1'), sha256: fingerprint(cert, 'sha256'), md5: fingerprint(cert, 'md5') };
    if (project.expectedSha1 && project.expectedSha1 !== info.sha1.replaceAll(':', '')) throw new AppError(`证书 SHA1 与填写的预期值不同。实际 SHA1：${info.sha1}`);
    return info;
  } finally { await fs.rm(output, { force: true }); }
}
export async function generateCertificate(store, jobs, job, project, environment) {
  if (project.certificatePath && await exists(project.certificatePath)) throw new AppError('项目已有证书，创建功能不会覆盖已有文件');
  const certificate = path.join(store.dir, 'certificates', `${project.id}.jks`);
  if (await exists(certificate)) throw new AppError('该项目已创建过证书，请选择已有证书文件');
  const alias = project.certificateAlias || 'release';
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(alias)) throw new AppError('生成证书的别名请使用字母、数字、点、下划线或横线');
  const password = project.secrets.storePassword || crypto.randomBytes(24).toString('base64url');
  job.secretValues.push(password);
  await fs.mkdir(path.dirname(certificate), { recursive: true, mode: 0o700 });
  jobs.step(job, '生成项目专用签名证书', 30);
  const cn = project.name.replace(/[,=+<>#;"\\]/g, ' ').slice(0, 70) || 'Android App';
  try {
    await jobs.run(job, path.join(environment.javaHome, 'bin', binary('keytool')), ['-genkeypair', '-storetype', 'PKCS12', '-keystore', certificate, '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', `CN=${cn}`, '-storepass:env', 'UNIPACK_STORE_PASSWORD', '-keypass:env', 'UNIPACK_STORE_PASSWORD', '-noprompt'], { env: toolEnv(environment, { UNIPACK_STORE_PASSWORD: password }), silent: true });
    await fs.chmod(certificate, 0o600);
    const info = await certificateInfo({ ...project, certificatePath: certificate, certificateAlias: alias, expectedSha1: '', secrets: { ...project.secrets, storePassword: password, keyPassword: password } }, environment, jobs, job);
    await store.upsert({ certificatePath: certificate, certificateAlias: alias, expectedSha1: info.sha1, secrets: { storePassword: password, keyPassword: password } }, project.id);
    return { certificatePath: certificate, certificate: info, message: '证书已保存，密码已加密保存在本机。请把以下指纹登记到 DCloud 对应应用后填写 AppKey。' };
  } catch (error) { await fs.rm(certificate, { force: true }); throw error; }
}
async function sourceSecrets(source) {
  const values = [];
  for (const parent of [source, path.join(source, 'env')]) for (const name of await fs.readdir(parent).catch(() => [])) {
    if (!name.startsWith('.env')) continue;
    const text = await fs.readFile(path.join(parent, name), 'utf8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*[\w]+\s*=\s*['"]?([^'"\r\n]+?)['"]?\s*$/);
      if (match && match[1].length >= 8) values.push(match[1]);
    }
  }
  return values;
}
async function linkDependency(source, target) {
  const actual = await fs.realpath(source), stat = await fs.stat(actual);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) await fs.symlink(actual, target, process.platform === 'win32' ? 'junction' : 'dir');
  else await fs.copyFile(actual, target);
}
export async function prepareFrontend(project, environment, destination) {
  if (!await exists(project.sourceDir)) throw new AppError('源码目录不存在');
  if (inside(project.sourceDir, destination) || inside(destination, project.sourceDir)) throw new AppError('源码与打包工作目录必须分开');
  await fs.cp(project.sourceDir, destination, { recursive: true, dereference: false, verbatimSymlinks: false, filter: source => !sourceIgnored.has(path.basename(source)) });
  if (project.frontendMode === 'cli-vue3') {
    const sourceModules = path.join(project.sourceDir, 'node_modules');
    if (!await exists(sourceModules)) throw new AppError('源码还未安装依赖，请先使用“安装项目依赖”');
    const compiler = hbuilderPaths(environment.hbuilderPath).compiler;
    const modules = path.join(destination, 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    for (const entry of await fs.readdir(sourceModules)) {
      if (entry.startsWith('.')) continue;
      const src = path.join(sourceModules, entry), target = path.join(modules, entry);
      if (entry.startsWith('@')) {
        await fs.mkdir(target, { recursive: true });
        for (const child of await fs.readdir(src)) {
          const bundled = path.join(compiler, entry, child);
          await linkDependency(entry === '@dcloudio' && await exists(bundled) ? bundled : path.join(src, child), path.join(target, child));
        }
      } else await linkDependency(src, target);
    }
    const scope = path.join(modules, '@dcloudio'); await fs.mkdir(scope, { recursive: true });
    for (const entry of await fs.readdir(path.join(compiler, '@dcloudio'))) if (!await exists(path.join(scope, entry))) await linkDependency(path.join(compiler, '@dcloudio', entry), path.join(scope, entry));
    const bin = path.join(modules, '.bin'); await fs.mkdir(bin, { recursive: true });
    const uni = path.join(compiler, '@dcloudio/vite-plugin-uni/bin/uni.js');
    if (process.platform === 'win32') {
      await fs.writeFile(path.join(bin, 'uni'), `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(uni).href)}).catch(e=>{console.error(e.message);process.exitCode=1});\n`);
      // Generated from a filesystem path; a Windows path cannot contain a quote.
      await fs.writeFile(path.join(bin, 'uni.cmd'), `@echo off\r\n"${process.execPath}" "${uni}" %*\r\n`);
    } else await fs.symlink(uni, path.join(bin, 'uni'));
    const packageFile = path.join(destination, 'package.json');
    const pkg = parseJsonc(await fs.readFile(packageFile, 'utf8'));
    for (const group of ['dependencies', 'devDependencies']) for (const name of Object.keys(pkg[group] || {})) {
      const packagePath = path.join(compiler, name, 'package.json');
      if (name.startsWith('@dcloudio/') && await exists(packagePath)) pkg[group][name] = JSON.parse(await fs.readFile(packagePath, 'utf8')).version;
    }
    await atomicWrite(packageFile, JSON.stringify(pkg, null, 2));
  }
  for (const file of ['src/manifest.json', 'manifest.json']) {
    const p = path.join(destination, file);
    if (!await exists(p)) continue;
    const manifest = parseJsonc(await fs.readFile(p, 'utf8'));
    manifest.appid = project.appId; manifest.name = project.appName;
    if (project.versionName) manifest.versionName = project.versionName;
    if (project.versionCode) manifest.versionCode = project.versionCode;
    await atomicWrite(p, JSON.stringify(manifest, null, 2));
  }
  // Common Vite/uni-helper manifests read these values from env. Only the copy changes.
  for (const parent of ['', 'env']) {
    const p = path.join(destination, parent, '.env.production');
    if (!await exists(path.dirname(p))) continue;
    let text = await fs.readFile(p, 'utf8').catch(() => '');
    for (const [name, value] of Object.entries({ VITE_UNI_APPID: project.appId })) {
      const line = `${name}=${JSON.stringify(value)}`;
      text = new RegExp(`^\\s*${name}\\s*=.*$`, 'm').test(text) ? text.replace(new RegExp(`^\\s*${name}\\s*=.*$`, 'm'), () => line) : `${text}\n${line}\n`;
    }
    await atomicWrite(p, text);
  }
  const manifestConfig = path.join(destination, 'manifest.config.ts');
  if (await exists(manifestConfig)) {
    let text = await fs.readFile(manifestConfig, 'utf8');
    for (const [key, value] of Object.entries({ appid: project.appId, ...(project.versionName ? { versionName: project.versionName } : {}), ...(project.versionCode ? { versionCode: project.versionCode } : {}) })) {
      // Only replace an existing simple literal; dynamic user logic stays intact.
      text = text.replace(new RegExp(`(\\b${key}\\s*:\\s*)(['"])[^'"\\r\\n]*\\2`), (_, prefix) => prefix + JSON.stringify(value));
    }
    await atomicWrite(manifestConfig, text);
  }
  for (const file of ['vite.config.ts', 'vite.config.js']) {
    const p = path.join(destination, file);
    if (await exists(p)) await atomicWrite(p, (await fs.readFile(p, 'utf8')).replace(/console\.log\(['"]环境变量 env -> ['"],\s*env\)/g, '/* 环境变量由本地打包配置提供 */'));
  }
}
export async function locateResources(frontend, project) {
  for (const candidate of [path.join(frontend, 'unpackage/resources', project.appId, 'www'), path.join(frontend, 'dist/build/app-plus')]) {
    const file = path.join(candidate, 'manifest.json');
    if (!await exists(file)) continue;
    const manifest = parseJsonc(await fs.readFile(file, 'utf8'));
    if (manifest.id !== project.appId) throw new AppError(`导出资源 AppID 为 ${manifest.id || '空'}，与项目配置不一致`);
    const version = manifest.plus?.['uni-app']?.compilerVersion;
    if (String(version) !== project.sdkVersion) throw new AppError(`资源编译器为 ${version || '未知'}，需要 ${project.sdkVersion}。请选择对应 HBuilderX/编译插件`);
    for (const name of ['app-service.js', 'app-config.js', '__uniappview.html']) if (!await exists(path.join(candidate, name))) throw new AppError(`导出资源不完整：缺少 ${name}`);
    if (project.versionName && String(manifest.version?.name) !== project.versionName) throw new AppError('项目中的动态版本配置覆盖了填写的版本号，请同步原项目的版本配置后重试');
    if (project.versionCode && String(manifest.version?.code) !== project.versionCode) throw new AppError('导出资源版本码与填写的版本码不一致');
    return { directory: candidate, manifest };
  }
  throw new AppError('HBuilderX 未生成完整的 App 本地资源，请检查前端导出日志');
}
export function patchManifest(text, project) {
  if (!text.includes('<application') || !text.includes('</application>')) throw new AppError('Android 模板缺少 application 节点');
  text = text.replace(/\s+android:extractNativeLibs=["'][^"']*["']/g, '');
  if (!/xmlns:tools\s*=/.test(text)) text = text.replace('<manifest', '<manifest xmlns:tools="http://schemas.android.com/tools"');
  text = text.replace(/<application\b[^>]*>/, tag => {
    if (!/android:usesCleartextTraffic=/.test(tag)) return tag;
    if (/tools:replace=/.test(tag)) return tag.replace(/tools:replace=(["'])(.*?)\1/, (_, quote, value) => `tools:replace=${quote}${[...new Set([...value.split(',').map(v => v.trim()), 'android:usesCleartextTraffic'])].join(',')}${quote}`);
    return tag.replace(/>$/, ' tools:replace="android:usesCleartextTraffic">');
  });
  const metadata = [['dcloud_appkey', '${dcloudAppKey}'], ['com.amap.api.v2.apikey', '${amapKey}']];
  for (const [name, value] of metadata) {
    const pattern = new RegExp(`<meta-data\\b(?=[^>]*android:name=["']${name.replaceAll('.', '\\.')}["'])[^>]*(?:\\/>|>[\\s\\S]*?<\\/meta-data>)`, 'g');
    text = text.replace(pattern, '');
    text = text.replace('</application>', `    <meta-data android:name="${name}" android:value="${value}" />\n    </application>`);
  }
  return text;
}
export function gradleInit(project) {
  // Register before project evaluation so overrides run before AGP finalizes the DSL.
  return `gradle.beforeProject { p ->
  p.afterEvaluate {
    if (p.path == ':${project.moduleName}' && p.plugins.hasPlugin('com.android.application')) {
      def a = p.extensions.getByName('android')
      def props = new Properties()
      new File(p.rootDir, 'app.properties').withReader('UTF-8') { props.load(it) }
      def signing = new Properties()
      new File(p.rootDir, 'signing.properties').withReader('UTF-8') { signing.load(it) }
      a.namespace = props.applicationId
      a.compileSdkVersion(${project.compileSdk})
      a.buildToolsVersion = '${project.buildTools}'
      a.defaultConfig.applicationId = props.applicationId
      a.defaultConfig.minSdkVersion(${project.minSdk})
      a.defaultConfig.targetSdkVersion(${project.targetSdk})
      a.defaultConfig.versionName = props.versionName
      a.defaultConfig.versionCode = props.versionCode.toInteger()
      a.defaultConfig.manifestPlaceholders.putAll([dcloudAppKey: props.dcloudAppKey, amapKey: props.amapAndroidKey ?: ''])
      a.defaultConfig.resValue('string', 'app_name', props.appName)
      a.packaging.jniLibs.useLegacyPackaging = true
      def c = a.signingConfigs.maybeCreate('unipackRelease')
      c.storeFile = new File(signing.storeFile)
      c.storePassword = signing.storePassword
      c.keyAlias = signing.keyAlias
      c.keyPassword = signing.keyPassword
      c.v1SigningEnabled = true
      c.v2SigningEnabled = true
      a.buildTypes.getByName('release').signingConfig = c
      a.buildTypes.getByName('debug').signingConfig = c
    }
  }
}
`;
}
export async function prepareNative(project, environment, resources, destination) {
  if (inside(project.androidDir, destination) || inside(destination, project.androidDir)) throw new AppError('Android 模板与工作目录必须分开');
  const module = path.join(destination, project.moduleName);
  await fs.cp(project.androidDir, destination, { recursive: true, filter: source => !nativeIgnored.has(path.basename(source)) && !path.basename(source).endsWith('.log') });
  const apps = path.join(module, 'src/main/assets/apps');
  await fs.rm(apps, { recursive: true, force: true });
  await fs.mkdir(apps, { recursive: true });
  await fs.cp(resources.directory, path.join(apps, project.appId, 'www'), { recursive: true });
  const { manifest } = resources;
  const versionName = String(manifest.version?.name || project.versionName || '1.0.0');
  const versionCode = String(manifest.version?.code || project.versionCode || '1');
  if (!/^\d+$/.test(versionCode) || Number(versionCode) < 1 || Number(versionCode) > 2100000000) throw new AppError('导出资源版本码应为 1–2100000000 的整数');
  await atomicWrite(path.join(module, 'src/main/assets/data/dcloud_control.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<hbuilder debug="false" syncDebug="false"><apps><app appid="${xml(project.appId)}" appver="${xml(versionName)}" /></apps></hbuilder>\n`);
  await atomicWrite(path.join(destination, 'app.properties'), propertiesText({ applicationId: project.packageName, dcloudAppId: project.appId, appName: project.appName, versionName, versionCode, minSdkVersion: project.minSdk, targetSdkVersion: project.targetSdk, dcloudAppKey: project.secrets.dcloudAppKey, amapAndroidKey: project.secrets.amapAndroidKey || '' }));
  await atomicWrite(path.join(destination, 'signing.properties'), propertiesText({ storeFile: project.certificatePath.replaceAll('\\', '/'), keyAlias: project.certificateAlias, storePassword: project.secrets.storePassword, keyPassword: project.secrets.keyPassword || project.secrets.storePassword }));
  await atomicWrite(path.join(destination, 'local.properties'), propertiesText({ 'sdk.dir': environment.sdkRoot.replaceAll('\\', '/') }));
  const gradleProperties = path.join(destination, 'gradle.properties');
  let text = await fs.readFile(gradleProperties, 'utf8').catch(() => '');
  text = text.replace(/^org\.gradle\.java\.home=.*$/gm, '');
  text += '\n' + propertiesText({ 'org.gradle.java.home': environment.javaHome.replaceAll('\\', '/') });
  await atomicWrite(gradleProperties, text);
  const rootGradle = path.join(destination, 'build.gradle');
  const preset = presets[project.sdkVersion];
  if (await exists(rootGradle)) await atomicWrite(rootGradle, (await fs.readFile(rootGradle, 'utf8')).replace(/(com\.android\.tools\.build:gradle:)[^'"\s]+/g, `$1${preset.agp}`));
  const wrapper = path.join(destination, 'gradle/wrapper/gradle-wrapper.properties');
  const wrapperText = await fs.readFile(wrapper, 'utf8');
  let normalized = wrapperText.replace(/^distributionUrl=.*$/m, `distributionUrl=https\\://downloads.gradle.org/distributions/gradle-${preset.gradle}-bin.zip`)
    .replace(/^distributionSha256Sum=.*\r?\n?/m, '');
  normalized += `\ndistributionSha256Sum=${preset.gradleHash}\n`;
  await atomicWrite(wrapper, normalized);
  const mainManifest = path.join(module, 'src/main/AndroidManifest.xml');
  await atomicWrite(mainManifest, patchManifest(await fs.readFile(mainManifest, 'utf8'), project));
  await atomicWrite(path.join(destination, 'unipack.init.gradle'), gradleInit(project));
  if (process.platform !== 'win32') await fs.chmod(path.join(destination, 'gradlew'), 0o755);
  return { versionName, versionCode };
}
export async function verifyApk(project, environment, apk, certificate, jobs, job) {
  const tools = path.join(environment.sdkRoot, 'build-tools', project.buildTools);
  const env = toolEnv(environment);
  const signature = await jobs.run(job, path.join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'), ['verify', '--verbose', '--print-certs', apk], { env, silent: true });
  const actualSha1 = signature.stdout.match(/Signer #1 certificate SHA-1 digest:\s*([a-fA-F0-9]+)/)?.[1]?.toUpperCase();
  if (actualSha1 !== certificate.sha1.replaceAll(':', '')) throw new AppError('APK 实际签名与选择的证书不一致，未归档此包');
  const info = await jobs.run(job, path.join(tools, binary('aapt2')), ['dump', 'badging', apk], { env, silent: true });
  const packageName = info.stdout.match(/^package: name='([^']+)'/m)?.[1];
  if (packageName !== project.packageName) throw new AppError('APK 实际包名与项目配置不一致');
  const manifest = await jobs.run(job, path.join(tools, binary('aapt2')), ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml'], { env, silent: true });
  const lines = manifest.stdout.split(/\r?\n/), index = lines.findIndex(s => s.includes('dcloud_appkey'));
  if (index < 0 || !lines.slice(index, index + 4).join('\n').includes(project.secrets.dcloudAppKey)) throw new AppError('APK 中的 DCloud AppKey 未正确写入');
  await jobs.run(job, path.join(tools, binary('zipalign')), ['-c', '4', apk], { env, silent: true });
  const bytes = await fs.readFile(apk);
  const control = zipEntry(bytes, 'assets/data/dcloud_control.xml').toString('utf8');
  const resourceManifest = parseJsonc(zipEntry(bytes, `assets/apps/${project.appId}/www/manifest.json`).toString('utf8'));
  if (!control.includes(`appid="${project.appId}"`) || resourceManifest.id !== project.appId || String(resourceManifest.plus?.['uni-app']?.compilerVersion) !== project.sdkVersion) throw new AppError('APK 内的控制文件、前端 AppID 或编译器版本不一致');
  const versionName = info.stdout.match(/versionName='([^']+)'/)?.[1], versionCode = info.stdout.match(/versionCode='([^']+)'/)?.[1];
  if (String(resourceManifest.version?.name) !== versionName || String(resourceManifest.version?.code) !== versionCode) throw new AppError('APK 资源版本与原生版本不一致');
  jobs.log(job, 'APK 签名、包名、AppKey、资源 AppID/版本与 ZIP 对齐检查通过。');
  return { packageName, certificate, appKeyWritten: true, appId: resourceManifest.id, compilerVersion: project.sdkVersion, versionName, versionCode, realDeviceTested: false };
}
export async function buildProject(store, jobs, job, project, environment) {
  if (!presets[project.sdkVersion]) throw new AppError('当前可构建预设为 DCloud 5.34，请使用对应 HBuilderX 和原生 SDK 模板');
  for (const [key, name] of Object.entries({ sourceDir: '源码目录', androidDir: 'Android 模板目录', appId: 'DCloud AppID', packageName: '包名' })) if (!project[key]) throw new AppError(`请先填写${name}`);
  if (!project.secrets.dcloudAppKey) throw new AppError('请先填写该项目对应的 DCloud AppKey');
  for (const p of [path.join(project.androidDir, project.moduleName, 'src/main/AndroidManifest.xml'), path.join(project.androidDir, 'gradle/wrapper/gradle-wrapper.properties')]) if (!await exists(p)) throw new AppError('Android 模板不完整，请选择 DCloud 标准 Android 工程根目录');
  const report = await inspectEnvironment(environment, project);
  if (!report.ready) throw new AppError('环境尚未就绪：' + report.checks.filter(c => !c.ok && c.required).map(c => c.name).join('、') + '。请在“本机环境”按引导配置');
  job.secretValues.push(...await sourceSecrets(project.sourceDir));
  jobs.step(job, '核对项目证书', 5);
  const certificate = await certificateInfo(project, environment, jobs, job);
  const workspace = path.join(store.dir, 'workspaces', job.id);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const frontend = path.join(workspace, 'frontend'), native = path.join(workspace, 'native');
  jobs.step(job, '创建独立前端副本与依赖链接', 12);
  await prepareFrontend(project, environment, frontend);
  const hb = hbuilderPaths(environment.hbuilderPath);
  const env = toolEnv(environment, { VITE_UNI_APPID: project.appId, NODE_OPTIONS: '--max-old-space-size=8192' });
  jobs.step(job, '通过 HBuilderX 导出本地资源', 28);
  let opened = false;
  try {
    await jobs.run(job, hb.cli, ['project', 'open', '--path', frontend], { env, cwd: workspace }); opened = true;
    await jobs.run(job, hb.cli, ['publish', 'app', '--type', 'appResource', '--project', frontend], { env, cwd: workspace });
  } finally {
    if (opened && !job.controller.signal.aborted) await jobs.run(job, hb.cli, ['project', 'close', '--path', frontend], { env, cwd: workspace, silent: true, allowFailure: true }).catch(() => {});
  }
  const resources = await locateResources(frontend, project);
  jobs.step(job, '同步资源并配置原生工程副本', 50);
  const version = await prepareNative(project, environment, resources, native);
  jobs.step(job, 'Gradle 编译并签名 release APK', 65);
  await jobs.run(job, path.join(native, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), [`:${project.moduleName}:assembleRelease`, '--console=plain', '--init-script', path.join(native, 'unipack.init.gradle')], { env, cwd: native });
  const output = path.join(native, project.moduleName, 'build/outputs/apk/release');
  const apks = (await fs.readdir(output)).filter(f => f.endsWith('.apk') && !f.includes('unsigned'));
  if (apks.length !== 1) throw new AppError('预期一个完整 release APK；当前模板的分包/变体配置需要单独适配');
  const apk = path.join(output, apks[0]);
  jobs.step(job, '校验实际 APK 身份和签名', 92);
  const verification = await verifyApk(project, environment, apk, certificate, jobs, job);
  if (verification.versionName !== version.versionName || verification.versionCode !== version.versionCode) throw new AppError('APK 版本与导出资源不一致');
  const archiveDir = path.join(store.dir, 'artifacts', project.id, job.id);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const safeName = project.name.replace(/[^\p{L}\p{N}._-]/gu, '-').slice(0, 60) || 'App';
  const fileName = `${safeName}-${version.versionName.replace(/[^\w.-]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.apk`;
  const dest = path.join(archiveDir, fileName);
  await fs.copyFile(apk, dest); await fs.chmod(dest, 0o600);
  const data = await fs.readFile(dest), apkHash = crypto.createHash('sha256').update(data).digest('hex');
  const result = { fileName, bytes: data.length, sha256: apkHash, ...verification, relativePath: path.relative(store.dir, dest), workspace, message: 'APK 已通过本地校验，请安装到手机验证启动及业务功能。' };
  await atomicWrite(path.join(archiveDir, 'verification.json'), JSON.stringify(result, null, 2));
  return result;
}
export async function installDependencies(jobs, job, project) {
  if (!await exists(path.join(project.sourceDir, 'package.json'))) throw new AppError('所选源码目录中没有 package.json');
  job.secretValues.push(...await sourceSecrets(project.sourceDir));
  const npm = await findCommand('npm');
  if (!npm) throw new AppError('未找到 npm，请先安装完整的 Node.js');
  const lock = await exists(path.join(project.sourceDir, 'pnpm-lock.yaml'));
  jobs.step(job, '安装项目依赖（pnpm 10.29.2）', 20);
  await jobs.run(job, npm, ['exec', '--yes', '--package=pnpm@10.29.2', '--', 'pnpm', 'install', ...(lock ? ['--frozen-lockfile'] : [])], { cwd: project.sourceDir });
  return { message: '前端依赖已安装，业务源文件保持原样；请继续环境检查和打包。' };
}
