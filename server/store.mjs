import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, atomicWrite, dataDirectory, expandPath, readJson, secretFields, validateProject } from './utils.mjs';
import { sdkCatalog, sdkProjectFields, sdkDirectory } from './sdks.mjs';

export class Store {
  constructor(dir = dataDirectory(), sdkRoot = sdkDirectory) { this.dir = dir; this.sdkRoot = sdkRoot; this.queue = Promise.resolve(); }
  catalog() { return sdkCatalog(this.state?.defaultSdkId, this.sdkRoot); }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    const keyPath = path.join(this.dir, 'master.key');
    try { this.key = await fs.readFile(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.key = crypto.randomBytes(32);
      await fs.writeFile(keyPath, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('本机加密主密钥损坏，请恢复原 master.key');
    this.state = await readJson(path.join(this.dir, 'state.json'), { schema: 1, projects: [], environment: {} });
    if (this.state.schema !== 1) throw new Error('不支持的数据格式版本');
    const catalog = await this.catalog();
    // SDK IDs travel with the tool; absolute paths are rebound on each machine.
    for (const project of this.state.projects) if (project.sdkId) {
      const sdk = catalog.items.find(s => s.id === project.sdkId);
      if (sdk) Object.assign(project, sdkProjectFields(sdk));
    }
    return this;
  }
  seal(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  unseal(box) {
    if (!box) return {};
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()]).toString('utf8'));
  }
  async save() {
    const content = JSON.stringify(this.state, null, 2) + '\n';
    this.queue = this.queue.catch(() => {}).then(() => atomicWrite(path.join(this.dir, 'state.json'), content));
    return this.queue;
  }
  get(id) {
    const p = this.state.projects.find(p => p.id === id);
    if (!p) throw new AppError('项目不存在', 404);
    return { ...p, secrets: this.unseal(p.secretBox) };
  }
  publicProject(project) {
    const { secretBox, secrets: ignored, ...safe } = project;
    const secrets = project.secrets || this.unseal(secretBox);
    return { ...safe, hasSecrets: Object.fromEntries(secretFields.map(key => [key, !!secrets[key]])) };
  }
  list() { return this.state.projects.map(p => this.publicProject(p)); }
  async upsert(data, projectId) {
    const previous = projectId ? this.get(projectId) : {};
    const catalog = await this.catalog();
    const sdkId = data.sdkId ?? previous.sdkId ?? (!projectId && !data.androidDir ? catalog.defaultId : '');
    if (sdkId) {
      const sdk = catalog.items.find(s => s.id === sdkId);
      if (!sdk) throw new AppError('所选 SDK 不在工具库中，请重新选择默认 SDK 或自定义模板');
      data = { ...data, ...sdkProjectFields(sdk) };
    }
    const project = validateProject(data, previous);
    const secrets = { ...previous.secrets };
    for (const key of secretFields) {
      if (data.clearSecrets?.includes(key)) delete secrets[key];
      if (typeof data.secrets?.[key] === 'string' && data.secrets[key] !== '') secrets[key] = data.secrets[key];
    }
    if (secrets.dcloudAppKey && !/^[a-fA-F0-9]{32}$/.test(secrets.dcloudAppKey)) throw new AppError('DCloud AppKey 应为 32 位十六进制字符');
    project.secretBox = this.seal(secrets);
    const index = this.state.projects.findIndex(p => p.id === project.id);
    if (index === -1) this.state.projects.push(project); else this.state.projects[index] = project;
    await this.save();
    return this.publicProject(project);
  }
  async environment(data) {
    for (const key of ['javaHome', 'sdkRoot', 'hbuilderPath']) if (typeof data[key] === 'string') this.state.environment[key] = expandPath(data[key].trim());
    await this.save();
    return { ...this.state.environment };
  }
  async defaultSdk(sdkId) {
    const catalog = await this.catalog();
    if (!catalog.items.some(s => s.id === sdkId && s.supported)) throw new AppError('只能将已有构建预设的 SDK 设为默认');
    this.state.defaultSdkId = sdkId;
    await this.save();
    return this.catalog();
  }
}
