import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AppError, atomicWrite, id, readJson } from './utils.mjs';
import { StringDecoder } from 'node:string_decoder';

export class Jobs {
  constructor(store) { this.store = store; this.items = []; this.active = null; }
  async init() {
    const history = await readJson(path.join(this.store.dir, 'history.json'), []);
    this.items = history.map(j => ['running', 'pending', 'cancelling'].includes(j.status) ? { ...j, status: 'interrupted', error: '上次程序退出时任务尚未完成，请重新执行。' } : j);
    return this;
  }
  persist() {
    const content = JSON.stringify(this.items.slice(-60).map(j => this.public(j)), null, 2);
    this.historyWrites = (this.historyWrites || Promise.resolve()).catch(() => {}).then(() => atomicWrite(path.join(this.store.dir, 'history.json'), content));
    return this.historyWrites;
  }
  public(job) { const { secretValues, child, controller, ...safe } = job; return safe; }
  list() { return this.items.map(j => this.public(j)).slice(-60).reverse(); }
  get(id) { const j = this.items.find(j => j.id === id); if (!j) throw new AppError('任务不存在', 404); return j; }
  redact(job, value) {
    let text = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    for (const secret of job.secretValues) if (secret) text = text.split(secret).join('••••••');
    return text;
  }
  log(job, line) {
    for (const value of this.redact(job, line).split(/\r?\n/)) {
      if (!value.trim()) continue;
      job.logs.push({ time: new Date().toISOString(), text: value.slice(0, 5000) });
    }
    if (job.logs.length > 2500) job.logs.splice(0, job.logs.length - 2500);
  }
  step(job, name, progress) { if (job.controller.signal.aborted) throw new AppError('任务已取消'); job.step = name; job.progress = progress; this.log(job, `› ${name}`); }
  start(kind, projectId, runner, secrets = []) {
    if (this.active) throw new AppError('已有任务正在运行，请等待完成或取消后重试', 409);
    const job = { id: id(), kind, projectId: projectId || null, status: 'running', step: '准备任务', progress: 0,
      startedAt: new Date().toISOString(), logs: [], secretValues: [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length), controller: new AbortController() };
    this.items.push(job); this.active = job;
    this.persist().catch(() => {});
    const completion = Promise.resolve().then(() => runner(job)).then(result => {
      job.result = result; job.status = 'succeeded'; job.progress = 100; job.step = '已完成';
    }).catch(error => {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = this.redact(job, error.message || String(error)); this.log(job, job.error);
    }).finally(async () => {
      job.finishedAt = new Date().toISOString(); this.active = null;
      await this.persist().catch(() => {});
    });
    Object.defineProperty(job, 'completion', { value: completion });
    return this.public(job);
  }
  cancel(job) {
    if (this.active?.id !== job.id) throw new AppError('此任务已经结束');
    job.status = 'cancelling'; job.controller.abort();
  }
  async run(job, executable, args, options = {}) {
    if (job.controller.signal.aborted) throw new AppError('任务已取消');
    const { cwd, env, input, silent = false, allowFailure = false } = options;
    let command = executable, argv = [...args];
    if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(command)) {
      // cmd.exe expansion is confined to environment variables; no user data is interpolated into shell text.
      const values = { UNIPACK_COMMAND: command };
      const names = argv.map((value, index) => { values[`UNIPACK_ARG_${index}`] = String(value); return `"%UNIPACK_ARG_${index}%"`; });
      options.env = { ...(env || process.env), ...values };
      argv = ['/d', '/v:off', '/s', '/c', `""%UNIPACK_COMMAND%" ${names.join(' ')}"`];
      command = process.env.ComSpec || 'cmd.exe';
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, argv, { cwd, env: options.env || env || process.env, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: process.platform === 'win32' && /cmd\.exe$/i.test(command) });
      job.child = child;
      let stdout = '', stderr = '', bufferOut = '', bufferErr = '', size = 0;
      const collect = (type, chunk) => {
        const text = (type === 'out' ? decoderOut : decoderErr).write(chunk); size += chunk.length;
        if (size > 24 * 1024 * 1024) { stop(); return reject(new AppError('工具输出过多，任务已停止，请查看项目配置')); }
        if (type === 'out') stdout += text; else stderr += text;
        if (silent) return;
        let buffer = (type === 'out' ? bufferOut : bufferErr) + text;
        const lines = buffer.split(/[\r\n]+/); buffer = lines.pop();
        for (const line of lines) this.log(job, line);
        if (type === 'out') bufferOut = buffer; else bufferErr = buffer;
      };
      const decoderOut = new StringDecoder('utf8'), decoderErr = new StringDecoder('utf8');
      child.stdout.on('data', chunk => collect('out', chunk)); child.stderr.on('data', chunk => collect('err', chunk));
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      };
      job.controller.signal.addEventListener('abort', stop, { once: true });
      child.on('error', error => { job.controller.signal.removeEventListener('abort', stop); reject(new AppError(`无法启动 ${path.basename(executable)}：${error.message}`)); });
      child.on('close', code => {
        job.controller.signal.removeEventListener('abort', stop); job.child = null;
        if (!silent) { this.log(job, bufferOut); this.log(job, bufferErr); }
        if (job.controller.signal.aborted) return reject(new AppError('任务已取消'));
        if (code !== 0 && !allowFailure) return reject(new AppError(`${path.basename(executable)} 执行失败（退出码 ${code}）${silent ? '：' + this.redact(job, stderr.trim().slice(-1800) || stdout.trim().slice(-1800)) : '，请查看任务日志'}`));
        resolve({ stdout, stderr, code });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    });
  }
}
