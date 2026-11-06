import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, exists, id } from './utils.mjs';
import { binary, toolEnv, inspectEnvironment, discover } from './environment.mjs';

const repository = 'https://dl.google.com/android/repository/repository2-1.xml';
export function androidArchive(metadata, platform) {
  const packages = [...metadata.matchAll(/<remotePackage\b([^>]*)>([\s\S]*?)<\/remotePackage>/g)];
  const item = packages.find(m => /path="cmdline-tools;19\.0"/.test(m[1]));
  if (!item) throw new AppError('Google 元数据中找不到与 JDK 17 配套的命令行工具 19.0，请通过 Android Studio 安装 SDK 组件');
  for (const match of item[2].matchAll(/<archive\b[^>]*>([\s\S]*?)<\/archive>/g)) {
    const content = match[1];
    if (!content.includes(`<host-os>${platform}</host-os>`)) continue;
    const file = content.match(/<url>([^<]+)<\/url>/)?.[1];
    const checksumMatch = content.match(/<checksum(?:\s+type="([^"]+)")?>([a-fA-F0-9]+)<\/checksum>/);
    if (!file || !checksumMatch || !/^commandlinetools-[a-z]+-\d+_latest\.zip$/.test(file)) continue;
    return { url: `https://dl.google.com/android/repository/${file}`, checksum: checksumMatch[2].toLowerCase(), algorithm: checksumMatch[1] || 'sha1' };
  }
  throw new AppError('没有找到当前操作系统的 Android 命令行工具');
}
function allowed(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && (['dl.google.com', 'corretto.aws'].includes(parsed.hostname) || parsed.hostname.endsWith('.amazonaws.com') || parsed.hostname.endsWith('.cloudfront.net'));
}
async function fetchOfficial(url, signal) {
  if (!allowed(url)) throw new AppError('下载地址不是配置的官方源');
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), redirect: 'follow' });
  if (!response.ok || !allowed(response.url)) throw new AppError(`官方下载失败：HTTP ${response.status}`);
  return response;
}
async function download(url, destination, expected, algorithm, jobs, job) {
  if (!['sha1', 'sha256'].includes(algorithm)) throw new AppError('不支持的下载校验算法');
  const response = await fetchOfficial(url, job.controller.signal);
  const file = await fs.open(destination, 'wx', 0o600), hash = crypto.createHash(algorithm);
  let total = 0, last = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > 1024 * 1024 * 1024) throw new AppError('下载文件超过 1 GB 限制');
      hash.update(chunk); await file.write(chunk);
      if (total - last > 25 * 1024 * 1024) { last = total; jobs.log(job, `已下载 ${Math.round(total / 1024 / 1024)} MB`); }
    }
  } finally { await file.close(); }
  if (hash.digest('hex').toLowerCase() !== expected.toLowerCase()) { await fs.rm(destination, { force: true }); throw new AppError('下载校验失败，未解压或执行该文件，请重试'); }
}
export function validateArchiveNames(names) {
  for (const raw of names) {
    const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.includes('\0')) throw new AppError('压缩包包含不安全的路径');
  }
}
async function extract(archive, destination, jobs, job) {
  if (archive.endsWith('.zip') && process.platform === 'linux') {
    const listing = await jobs.run(job, 'unzip', ['-Z1', archive], { silent: true });
    validateArchiveNames(listing.stdout.trim().split(/\r?\n/));
    await fs.mkdir(destination, { recursive: true });
    await jobs.run(job, 'unzip', ['-q', archive, '-d', destination], { silent: true });
    return;
  }
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const listing = await jobs.run(job, tar, ['-tf', archive], { silent: true });
  validateArchiveNames(listing.stdout.trim().split(/\r?\n/));
  await fs.mkdir(destination, { recursive: true });
  await jobs.run(job, tar, ['-xf', archive, '-C', destination], { silent: true });
}
async function findJdk(root, depth = 0) {
  if (await exists(path.join(root, 'bin', binary('javac')))) return root;
  if (depth > 4) return '';
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = await findJdk(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return '';
}
export async function installEnvironment(store, jobs, job, project, accepted) {
  if (accepted !== true) throw new AppError('安装 Android SDK 前，需要在界面明确同意 Google SDK 许可协议');
  jobs.step(job, '查找并复用本机已有工具', 2);
  const environment = await discover(store.state.environment, store.dir);
  await store.environment(environment);
  const tools = path.join(store.dir, 'tools');
  const stage = path.join(tools, `.install-${id()}`);
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    let report = await inspectEnvironment(environment, project);
    if (!report.checks.find(c => c.key === 'java').ok) {
      jobs.step(job, '下载并校验 JDK 17', 10);
      const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
      const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x64' : '';
      if (!platform || !arch || (process.platform === 'win32' && arch !== 'x64')) throw new AppError('当前架构需要手动安装 JDK 17，再选择其目录');
      const filename = `amazon-corretto-17-${arch}-${platform}-jdk.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
      const checksum = (await (await fetchOfficial(`https://corretto.aws/downloads/latest_sha256/${filename}`, job.controller.signal)).text()).match(/[a-fA-F0-9]{64}/)?.[0];
      if (!checksum) throw new AppError('无法读取 JDK 官方校验值');
      const archive = path.join(stage, filename);
      await download(`https://corretto.aws/downloads/latest/${filename}`, archive, checksum, 'sha256', jobs, job);
      await extract(archive, path.join(stage, 'java'), jobs, job);
      const jdk = await findJdk(path.join(stage, 'java'));
      if (!jdk) throw new AppError('JDK 压缩包结构无法识别');
      const target = path.join(tools, 'jdk17');
      if (await exists(target)) await fs.rename(target, target + '.backup-' + Date.now());
      await fs.cp(jdk, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      environment.javaHome = target;
      await store.environment(environment);
    }
    if (!environment.sdkRoot) environment.sdkRoot = path.join(tools, 'android-sdk');
    report = await inspectEnvironment(environment, project);
    const missing = report.checks.filter(c => ['platform', 'buildTools', 'adb'].includes(c.key) && !c.ok);
    if (missing.length) {
      const manager = path.join(environment.sdkRoot, 'cmdline-tools/19.0/bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
      if (!await exists(manager)) {
        jobs.step(job, '下载 Android 命令行工具 19.0', 35);
        const response = await fetchOfficial(repository, job.controller.signal);
        const metadata = await response.text();
        if (metadata.length > 20 * 1024 * 1024) throw new AppError('Android 元数据大小异常');
        const descriptor = androidArchive(metadata, { darwin: 'macosx', win32: 'windows', linux: 'linux' }[process.platform]);
        const archive = path.join(stage, 'commandlinetools.zip');
        await download(descriptor.url, archive, descriptor.checksum, descriptor.algorithm, jobs, job);
        await extract(archive, path.join(stage, 'android'), jobs, job);
        const source = path.join(stage, 'android/cmdline-tools');
        if (!await exists(path.join(source, 'bin'))) throw new AppError('Android 命令行工具目录结构无法识别');
        const target = path.dirname(path.dirname(manager));
        if (await exists(target)) await fs.rename(target, target + '.backup-' + Date.now());
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.cp(source, target, { recursive: true });
        if (process.platform !== 'win32') for (const entry of await fs.readdir(path.join(target, 'bin'))) await fs.chmod(path.join(target, 'bin', entry), 0o755);
      }
      jobs.step(job, '安装 Android SDK 组件（已确认许可）', 60);
      const packages = [];
      if (missing.some(c => c.key === 'platform')) packages.push(`platforms;android-${project.compileSdk || 36}`);
      if (missing.some(c => c.key === 'buildTools')) packages.push(`build-tools;${project.buildTools || '36.0.0'}`);
      if (missing.some(c => c.key === 'adb')) packages.push('platform-tools');
      await jobs.run(job, manager, [`--sdk_root=${environment.sdkRoot}`, '--install', ...packages], { env: toolEnv(environment), input: 'y\n'.repeat(100) });
    }
    await store.environment(environment);
    jobs.step(job, '重新检查本机环境', 95);
    report = await inspectEnvironment(environment, project);
    return { report, message: report.ready ? '所需环境已就绪' : 'Android/Java 已处理，请按环境列表补充 HBuilderX 及编译插件' };
  } finally { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); }
}
