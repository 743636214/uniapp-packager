import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { Jobs } from './jobs.mjs';
import { AppError, exists, inside, secretFields } from './utils.mjs';
import { discover, inspectEnvironment } from './environment.mjs';
import { browseDirectory, exportProject, importAndroid, inspectSource } from './projects.mjs';
import { buildProject, certificateInfo, generateCertificate, installDependencies, presets } from './builder.mjs';
import { installEnvironment } from './install.mjs';
import { importSdk } from './sdks.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new AppError('请求内容过大', 413); }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new AppError('请求不是有效 JSON'); }
}
export async function createApp({ store = new Store(), port = 4318 } = {}) {
  await store.init();
  const jobs = await new Jobs(store).init();
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    const origin = `http://${req.headers.host}`;
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const send = (status, data) => { if (!res.headersSent) res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (!hosts.has(req.headers.host)) throw new AppError('不支持的访问地址，请使用本机 127.0.0.1 地址', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('拒绝跨站请求', 403);
      const url = new URL(req.url, origin), pathname = url.pathname;
      if (pathname === '/api/session' && req.method === 'GET') {
        const sid = crypto.randomBytes(32).toString('hex'), token = crypto.randomBytes(32).toString('hex');
        sessions.set(sid, { token, expires: Date.now() + 24 * 60 * 60 * 1000 });
        if (sessions.size > 200) for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
        res.setHeader('Set-Cookie', `unipack_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
        return send(200, { token });
      }
      if (pathname.startsWith('/api/')) {
        const sid = req.headers.cookie?.match(/(?:^|;\s*)unipack_session=([a-f0-9]+)/)?.[1];
        const session = sessions.get(sid);
        if (!session || session.expires < Date.now() || req.headers['x-unipack-token'] !== session.token) throw new AppError('会话已失效，请刷新页面', 401);
        if (pathname === '/api/state' && req.method === 'GET') return send(200, { projects: store.list(), environment: store.state.environment, sdks: await store.catalog(), jobs: jobs.list().map(j => ({ ...j, logs: j.logs.slice(-8) })), busy: !!jobs.active, system: { platform: process.platform, arch: process.arch, hostname: os.hostname(), home: os.homedir(), dataDir: store.dir, node: process.version }, presets: Object.keys(presets) });
        if (pathname === '/api/sdks/import' && req.method === 'POST') {
          const data = await body(req);
          return send(202, jobs.start('sdk-import', null, job => importSdk(data, jobs, job, store.sdkRoot)));
        }
        if (pathname === '/api/sdks/default' && req.method === 'PUT') {
          if (jobs.active) throw new AppError('请等当前任务结束后切换默认 SDK', 409);
          return send(200, await store.defaultSdk((await body(req)).sdkId));
        }
        if (pathname === '/api/browse' && req.method === 'GET') return send(200, await browseDirectory(url.searchParams.get('path'), url.searchParams.get('kind') || 'directory'));
        if (pathname === '/api/source/inspect' && req.method === 'POST') return send(200, await inspectSource((await body(req)).sourceDir));
        if (pathname === '/api/environment' && req.method === 'PUT') {
          if (jobs.active) throw new AppError('任务执行期间请先保留当前环境配置', 409);
          return send(200, await store.environment(await body(req)));
        }
        if (pathname === '/api/environment/detect' && req.method === 'POST') {
          if (jobs.active) throw new AppError('请等当前任务完成再自动配置环境', 409);
          const data = await body(req), project = data.projectId ? store.get(data.projectId) : {};
          const found = await discover(store.state.environment, store.dir);
          await store.environment(found);
          return send(200, { environment: found, report: await inspectEnvironment(found, project) });
        }
        if (pathname === '/api/environment/check' && req.method === 'POST') {
          const data = await body(req), p = data.projectId ? store.get(data.projectId) : {};
          return send(200, await inspectEnvironment(store.state.environment, p));
        }
        if (pathname === '/api/environment/install' && req.method === 'POST') {
          const data = await body(req);
          if (data.acceptSdkLicense !== true) throw new AppError('请先阅读并同意 Android SDK 许可协议');
          const project = data.projectId ? store.get(data.projectId) : {};
          return send(202, jobs.start('environment', data.projectId, job => installEnvironment(store, jobs, job, project, true)));
        }
        if (pathname === '/api/projects' && req.method === 'POST') return send(201, await store.upsert(await body(req)));
        if (pathname === '/api/projects/import-android' && req.method === 'POST') return send(201, await importAndroid(store, await body(req)));
        if (pathname === '/api/projects/import-profile' && req.method === 'POST') {
          const data = await body(req);
          if (data.format !== 'unipack-project' || data.version !== 1 || !data.project) throw new AppError('不是 UniPack 项目配置文件');
          const allowed = exportProject(data.project).project;
          return send(201, await store.upsert(allowed));
        }
        const projectRoute = pathname.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(export|reveal|build|certificate|generate-certificate|dependencies))?$/);
        if (projectRoute) {
          const [, projectId, action] = projectRoute;
          const project = store.get(projectId), env = { ...store.state.environment };
          if (!action && req.method === 'PUT') return send(200, await store.upsert(await body(req), projectId));
          if (action === 'export' && req.method === 'GET') return send(200, exportProject(project));
          if (action === 'reveal' && req.method === 'POST') {
            const { field } = await body(req);
            if (!secretFields.includes(field)) throw new AppError('无效的私密字段');
            return send(200, { value: project.secrets[field] || '' });
          }
          if (req.method === 'POST') {
            const values = Object.values(project.secrets);
            if (action === 'build') return send(202, jobs.start('build', projectId, job => buildProject(store, jobs, job, project, env), values));
            if (action === 'certificate') return send(202, jobs.start('certificate', projectId, async job => { jobs.step(job, '读取证书指纹', 40); return { certificate: await certificateInfo(project, env, jobs, job) }; }, values));
            if (action === 'generate-certificate') return send(202, jobs.start('generate-certificate', projectId, job => generateCertificate(store, jobs, job, project, env), values));
            if (action === 'dependencies') return send(202, jobs.start('dependencies', projectId, job => installDependencies(jobs, job, project), values));
          }
        }
        const jobRoute = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(cancel|artifact|reveal))?$/);
        if (jobRoute) {
          const [, jobId, action] = jobRoute, job = jobs.get(jobId);
          if (!action && req.method === 'GET') return send(200, jobs.public(job));
          if (action === 'cancel' && req.method === 'POST') { jobs.cancel(job); return send(200, { ok: true }); }
          if (['artifact', 'reveal'].includes(action)) {
            if (job.status !== 'succeeded' || !job.result?.relativePath) throw new AppError('此任务没有可用 APK');
            const file = path.resolve(store.dir, job.result.relativePath);
            if (!inside(path.join(store.dir, 'artifacts'), file) || !await exists(file)) throw new AppError('APK 文件不存在', 404);
            if (action === 'artifact' && req.method === 'GET') {
              res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': (await fs.stat(file)).size, 'Content-Disposition': `attachment; filename="app.apk"; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` });
              createReadStream(file).on('error', () => res.destroy()).pipe(res); return;
            }
            if (action === 'reveal' && req.method === 'POST') {
              const directory = path.dirname(file);
              const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
              const child = spawn(command, [directory], { detached: true, windowsHide: true, stdio: 'ignore' });
              child.on('error', () => {}); child.unref();
              return send(200, { path: directory });
            }
          }
        }
        throw new AppError('接口不存在', 404);
      }
      if (req.method !== 'GET' || !['/', '/index.html', '/app.js', '/source-autofill.js', '/styles.css'].includes(pathname)) throw new AppError('页面不存在', 404);
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      const mime = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { ...headers, 'Content-Type': `${mime}; charset=utf-8` });
      res.end(await fs.readFile(path.join(publicDir, name)));
    } catch (error) {
      // Never return command arguments, persisted state or stack traces containing credentials.
      send(error.status || 500, { error: error.status ? error.message : '操作失败，请检查路径、文件权限或服务端状态' });
      if (!error.status) console.error('[UniPack] 操作失败:', error.code || error.name);
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, store, jobs, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  createApp({ port }).then(app => {
    console.log(`\nUniPack 本地打包工作台\n${app.url}\n本机数据：${app.store.dir}\n按 Ctrl+C 停止\n`);
    const stop = async () => { const active = app.jobs.active; if (active) { app.jobs.cancel(active); await active.completion; } app.server.close(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。可设置 PORT 后重试。` : error.message); process.exitCode = 1; });
}
