export function environmentGuidance(checks, { platform, arch, environment: env, project = {} }) {
  const version = project.sdkVersion || '5.34';
  const windows = platform === 'win32', mac = platform === 'darwin';
  const autoJava = ['darwin', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch) || windows && arch === 'x64';
  const autoAndroid = ['darwin', 'linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch);
  const guide = {
    node: { reason: '当前运行工具的 Node.js 低于 22。', steps: ['打开 Node.js 官网，安装 22 或更新版本。', '关闭工具的启动终端，重新双击启动入口，再检查环境。'], link: 'https://nodejs.org/', linkLabel: '下载 Node.js' },
    java: { automatic: autoJava, reason: env.javaHome ? '所选目录无法运行 JDK 17，或缺少 javac 编译器。' : '尚未找到 JDK 17。', field: 'javaHome', steps: ['先点“自动查找”，复用电脑上已经安装的 JDK 17。', '仍未找到时，使用“一键安装缺失组件”；也可从官方安装 Corretto 17。', mac ? '手动选择 JDK 的 Contents/Home 目录，里面应有 bin/java 和 bin/javac。' : '手动选择包含 bin/java 和 bin/javac 的 JDK 根目录，不要选 bin 子目录。'], link: 'https://docs.aws.amazon.com/corretto/latest/corretto-17-ug/downloads-list.html', linkLabel: '手动下载 JDK 17' },
    hbuilder: { reason: env.hbuilderPath ? '所选位置中没有找到 HBuilderX CLI。' : '尚未找到 HBuilderX。', field: 'hbuilderPath', steps: [`从官方历史版本页面下载与 DCloud SDK ${version} 配套的 HBuilderX（内置 5.34 对应 5.34.2026102909）。`, mac ? '打开下载的 dmg，把 HBuilderX 拖到“应用程序”，启动并登录。' : windows ? '解压 Windows 安装包到固定目录，运行 HBuilderX.exe 并登录。' : '按 Linux CLI 官方说明安装并配置对应版本；Linux 使用 CLI，不能照搬 Windows 的安装目录。', mac ? '点下方“浏览”，选择 /Applications/HBuilderX.app；构建期间保持它运行。' : '点下方“浏览”，选择包含 cli.exe（Windows）或 cli（Linux）的根目录。', '点击“保存并重新检查”，通过后继续下一步。'], link: 'https://hx.dcloud.net.cn/Tutorial/HistoryVersion', linkLabel: '下载对应 HBuilderX', ...(platform === 'linux' ? { extraLink: 'https://hx.dcloud.net.cn/Tutorial/install/linux-cli', extraLabel: 'Linux CLI 安装说明' } : {}) },
    compiler: { reason: '未找到 uni-app Vue3/Vite 编译插件。', field: 'hbuilderPath', steps: [mac || windows ? '打开 HBuilderX，进入“工具 → 插件安装”。' : '按 Linux CLI 文档安装 uniapp-cli-vite 插件。', '安装 uni-app Vue3 编译器（uniapp-cli-vite）；若已安装，请确认所选 HBuilderX 路径正确。', `使用与 SDK ${version} 对应的编译器，完成后回到这里重新检查。`], link: 'https://hx.dcloud.net.cn/Tutorial/Plugins/Install', linkLabel: '插件安装说明' },
    platform: { automatic: autoAndroid, reason: `缺少当前项目需要的 Android API ${project.compileSdk || 36} 平台。`, field: 'sdkRoot' },
    buildTools: { automatic: autoAndroid, reason: `缺少或不完整的 Build Tools ${project.buildTools || '36.0.0'}。`, field: 'sdkRoot' },
    adb: { automatic: autoAndroid, reason: '缺少 Android platform-tools（ADB）。', field: 'sdkRoot' },
    sdkManager: { reason: '未找到 SDK 管理器；已有编译组件齐全时可直接打包。', field: 'sdkRoot', steps: ['这是按需安装组件的辅助工具，不阻挡现有项目构建。', '缺少平台或 Build Tools 时，“一键安装”会自动补上兼容 JDK 17 的命令行工具 19.0。'] },
  };
  for (const key of ['platform', 'buildTools', 'adb']) Object.assign(guide[key], { steps: ['先点“自动查找”，复用电脑上已有的 Google Android SDK。', '阅读并勾选 Android SDK 许可协议，点击“一键安装缺失组件”，等待下载和检查完成。', `若下载失败，可在 Android Studio → SDK Manager 安装 Android API ${project.compileSdk || 36}、Build Tools ${project.buildTools || '36.0.0'} 和 Android SDK Platform-Tools。`, '手动安装后，选择包含 platforms、build-tools、platform-tools 的 SDK 根目录，再重新检查。'], link: 'https://developer.android.com/tools/sdkmanager', linkLabel: 'Android SDK 安装说明' });
  const enriched = checks.map(c => ({ ...c, required: c.key !== 'sdkManager' && !(c.key === 'compiler' && project.frontendMode === 'hbuilder'), guide: guide[c.key] }));
  const missing = enriched.filter(c => c.required && !c.ok);
  return { checks: enriched, ready: missing.length === 0, summary: { missing: missing.length, automatic: missing.filter(c => c.guide?.automatic).map(c => c.key), manual: missing.filter(c => !c.guide?.automatic).map(c => c.key) } };
}
