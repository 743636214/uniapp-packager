import { spawn } from 'node:child_process';
import { createApp } from '../server/index.mjs';
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('请先安装 Node.js 22 或更新版本。');
try {
  const app = await createApp({ port: Number(process.env.PORT || 4318) });
  console.log(`\nUniPack 本地打包工作台\n${app.url}\n数据目录：${app.store.dir}\n关闭此窗口或按 Ctrl+C 停止服务。\n`);
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [app.url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('请在浏览器手动打开上面的本机地址。')); child.unref();
  const stop = async () => { const active = app.jobs.active; if (active) { app.jobs.cancel(active); await active.completion; } app.server.close(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? '4318 端口已占用，请检查工具是否已经启动，或设置 PORT 使用其他端口。' : error.message);
  process.exitCode = 1;
}
