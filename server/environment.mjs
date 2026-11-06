import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, expandPath } from './utils.mjs';
import { environmentGuidance } from './guidance.mjs';

const exec = promisify(execFile);
export const binary = name => process.platform === 'win32' ? `${name}.exe` : name;
export function hbuilderPaths(home) {
  if (process.platform === 'darwin' && home.endsWith('.app')) return { cli: path.join(home, 'Contents/MacOS/cli'), compiler: path.join(home, 'Contents/HBuilderX/plugins/uniapp-cli-vite/node_modules') };
  return { cli: path.join(home, process.platform === 'win32' ? 'cli.exe' : 'cli'), compiler: path.join(home, 'plugins/uniapp-cli-vite/node_modules') };
}
export function toolEnv(environment, extra = {}) {
  const env = { ...process.env, ...extra, JAVA_HOME: environment.javaHome, ANDROID_HOME: environment.sdkRoot, ANDROID_SDK_ROOT: environment.sdkRoot };
  // Windows environment keys are case-insensitive. Avoid passing both Path and PATH.
  const inherited = process.env.PATH || process.env.Path || '';
  delete env.Path;
  env.PATH = [path.join(environment.javaHome || '', 'bin'), path.join(environment.sdkRoot || '', 'platform-tools'), path.dirname(process.execPath), inherited].join(path.delimiter);
  return env;
}
export async function sdkManager(sdkRoot) {
  const root = path.join(sdkRoot || '', 'cmdline-tools');
  const names = await fs.readdir(root).catch(() => []);
  const sorted = ['latest', ...names.filter(n => n !== 'latest').sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))];
  for (const n of sorted) {
    const p = path.join(root, n, 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
    if (await exists(p)) return p;
  }
  return '';
}
export async function findCommand(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) for (const suffix of suffixes) {
    const p = path.join(dir, name + suffix);
    if (await exists(p)) return p;
  }
  return '';
}
async function javaVersion(javaHome) {
  try {
    const { stdout, stderr } = await exec(path.join(javaHome, 'bin', binary('java')), ['-version'], { timeout: 12000, windowsHide: true });
    const text = stdout + stderr;
    const value = text.match(/version\s+"([^"\r\n]+)"/)?.[1] || '';
    return { value, major: Number(value.split('.')[0]) };
  } catch { return { value: '', major: 0 }; }
}
export async function discover(saved = {}, dataDir = '') {
  const home = os.homedir();
  const sdkCandidates = [saved.sdkRoot, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? path.join(home, 'Library/Android/sdk') : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || home, 'Android/Sdk') : path.join(home, 'Android/Sdk'), path.join(dataDir, 'tools/android-sdk')].filter(Boolean);
  const hbCandidates = [saved.hbuilderPath, process.env.HBUILDERX_HOME,
    ...(process.platform === 'darwin' ? ['/Applications/HBuilderX.app', path.join(home, 'Applications/HBuilderX.app')] : process.platform === 'win32' ? ['D:/tools/HBuilderX', 'C:/tools/HBuilderX', path.join(home, 'tools/HBuilderX')] : ['/opt/HBuilderX', path.join(home, 'HBuilderX')])].filter(Boolean);
  const javaCandidates = [saved.javaHome, process.env.JAVA_HOME, path.join(dataDir, 'tools/jdk17')].filter(Boolean);
  const javaParents = process.platform === 'darwin' ? [path.join(home, 'Library/Java/JavaVirtualMachines'), '/Library/Java/JavaVirtualMachines'] : process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Amazon Corretto'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Java'), 'D:/tools'] : ['/usr/lib/jvm', path.join(home, '.jdks')];
  for (const parent of javaParents) for (const entry of await fs.readdir(parent).catch(() => [])) {
    javaCandidates.push(path.join(parent, entry, ...(process.platform === 'darwin' ? ['Contents/Home'] : [])));
  }
  const javaCommand = await findCommand('java');
  if (javaCommand) javaCandidates.push(path.dirname(path.dirname(await fs.realpath(javaCommand))));
  let javaHome = '';
  for (const candidate of [...new Set(javaCandidates)]) if ((await javaVersion(candidate)).major === 17) { javaHome = candidate; break; }
  let sdkRoot = '';
  for (const p of sdkCandidates) if (await exists(p)) { sdkRoot = p; break; }
  let hbuilderPath = '';
  for (const p of hbCandidates) if (await exists(hbuilderPaths(p).cli)) { hbuilderPath = p; break; }
  return { javaHome: expandPath(javaHome), sdkRoot: expandPath(sdkRoot || sdkCandidates[0]), hbuilderPath: expandPath(hbuilderPath) };
}
export async function inspectEnvironment(environment, project = {}) {
  const env = { javaHome: '', sdkRoot: '', hbuilderPath: '', ...environment };
  const hb = hbuilderPaths(env.hbuilderPath), java = await javaVersion(env.javaHome);
  const sdk = project.compileSdk || 36, buildTools = project.buildTools || '36.0.0';
  const checks = [
    { key: 'node', name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version, action: '安装 Node.js 22 或更新版本' },
    { key: 'java', name: 'JDK 17', ok: java.major === 17 && await exists(path.join(env.javaHome, 'bin', binary('javac'))), detail: java.value || '未发现 JDK 17', action: '选择 JDK 根目录，或安装缺失环境' },
    { key: 'hbuilder', name: 'HBuilderX', ok: await exists(hb.cli), detail: env.hbuilderPath || '尚未选择', action: '安装并选择与离线 SDK 对应的 HBuilderX' },
    { key: 'compiler', name: 'Vue3 编译器', ok: await exists(path.join(hb.compiler, '@dcloudio/vite-plugin-uni/bin/uni.js')), detail: '用于 CLI / Vite 项目', action: '在 HBuilderX 中安装 uni-app Vue3/Vite 编译插件' },
    { key: 'platform', name: `Android Platform ${sdk}`, ok: await exists(path.join(env.sdkRoot, `platforms/android-${sdk}/android.jar`)), detail: `API ${sdk}`, action: '安装缺失 Android 组件' },
    { key: 'buildTools', name: `Build Tools ${buildTools}`, ok: (await Promise.all([binary('aapt2'), binary('zipalign'), process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'].map(name => exists(path.join(env.sdkRoot, `build-tools/${buildTools}`, name))))).every(Boolean), detail: buildTools, action: '安装缺失 Android 组件' },
    { key: 'adb', name: 'Platform Tools', ok: await exists(path.join(env.sdkRoot, 'platform-tools', binary('adb'))), detail: 'ADB 连接与安装工具', action: '安装缺失 Android 组件' },
    { key: 'sdkManager', name: 'SDK 管理器', ok: !!(await sdkManager(env.sdkRoot)), detail: '按需安装 Android 组件', action: '可由安装按钮下载命令行工具' },
  ];
  return { platform: process.platform, arch: process.arch, hostname: os.hostname(), environment: env,
    ...environmentGuidance(checks, { platform: process.platform, arch: process.arch, environment: env, project }) };
}
