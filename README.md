# UniPack · 本地打包工作台

用一个 Node 项目管理多份 UniApp Android 打包配置。浏览器中选择源码、原生模板和签名证书，填写 Key，检查本机环境并构建签名 APK。

项目配置与本机工具路径分开保存，支持在 macOS、Windows、Linux 上运行。当前构建预设为 **UniApp / Vue3 + DCloud 5.34，JDK 17，Gradle 8.14.3，AGP 8.12.0，Android Platform 36 / Build Tools 36.0.0**。不同项目可以使用不同 AppID、包名、签名、Key 和原生模板。

## 启动

先安装 **Node.js 22 或更新版本**。本工具没有第三方 npm 运行依赖，无须先执行 `npm install`。

```bash
npm start
```

启动后在浏览器访问 **http://127.0.0.1:4318**。也可以双击：

| 系统 | 入口 |
| --- | --- |
| macOS | `启动工具.command`；首次需要执行权限时运行 `chmod u+x 启动工具.command` |
| Windows | `start.cmd` |
| Linux | `sh start.sh` |

保留启动终端；Ctrl+C 停止本机服务。换端口示例：macOS/Linux `PORT=4319 npm start`；PowerShell `$env:PORT=4319; npm.cmd start`。

## 从 GitHub 获取

仓库包含工具源码及 DCloud Android 5.34 离线 SDK，换电脑克隆后即可使用默认原生模板：

```bash
git clone https://github.com/743636214/uniapp-packager.git
cd uniapp-packager
npm start
```

私有仓库需要先登录具有访问权限的 GitHub 账号。安装 Node.js 22 或更新版本后启动工具，再按“本机环境”引导准备该电脑的 JDK、Google Android 编译工具和 HBuilderX。应用源码、原证书和私密 Key 分别选择或填写，不随工具仓库上传。SDK 官方许可保留在对应目录中，官方示例签名文件不提交，出包使用自己的专用证书。

## 第一次使用

1. **创建或导入工程**：新项目默认使用工具目录中的 DCloud 5.34 SDK，选择自己的 UniApp 源码即可；也可导入现有 Android 工程和源码目录。兼容当前的 `BegaME-Android` 工程，也可使用 DCloud 离线 SDK 中的标准 `HBuilder-Integrate-AS` 工程。
2. **配置本机环境**：进入“本机环境”，点击“先自动查找已有工具”。检查 HBuilderX、JDK 17、Android SDK 的实际路径。Mac 的 HBuilderX 选择 `.app`；Windows/Linux 选择含 CLI 的安装目录。
3. **补齐环境**：缺少 JDK、Android 命令行工具或 Android 平台/Build Tools/ADB 时，阅读并同意界面中的 SDK 许可，再点击安装。下载使用 Google / Amazon 官方来源并校验摘要。Linux 自动解压需要 `tar`、`unzip`。自动安装支持 macOS x64/arm64、Windows x64、Linux x64/arm64；其他架构请手动安装并选择路径。
4. **HBuilderX**：从官方安装 5.34 并登录，安装 Vue3/Vite 编译插件。构建期间保持 HBuilderX 运行。工具不会替你操作 DCloud 登录、验证码或 AppKey 申请。
5. **项目身份**：填写 AppID、包名、对应的 Android 离线 AppKey。选择原证书、别名和密码，建议填写 DCloud 登记的证书 SHA1 以便核对。
6. **前端依赖**：源码没有 `node_modules` 时点击“安装依赖”。使用工具临时调用的 pnpm 10.29.2；有 `pnpm-lock.yaml` 时采用 frozen lockfile。此操作在选中的源码目录安装依赖，不批量升级业务依赖。
7. **构建**：保存配置，点击“一键构建 APK”。完成后下载 APK 或打开产物目录，安装到 Android 手机验证启动、AppKey、登录和业务。

新应用没有证书时，可以先保存项目，再点击“新应用 · 创建专用证书”。工具生成新的 PKCS12 签名文件；密码留空时随机生成并加密保存。点击密码旁的“显示”可查看并自行备份。已有应用升级继续使用原证书，创建新证书会改变应用签名身份。

AppID + Android 包名 + 证书 SHA1 必须与 DCloud 申请 AppKey 的配置匹配。工具可检查所填指纹、资源 AppID、编译器版本、实际 APK 签名/包名和 Key 是否写入，但无法离线证明 DCloud 服务端的绑定或手机业务运行结果。

## 多项目与换电脑

- 侧边栏“＋”添加项目，各项目独立保存 Key、证书路径、包名和构建记录。
- 原生模板提供已接入的原生模块、图标、权限和网络设置。跨项目请选择适合目标应用的模板；本工具不自动为所有 DCloud 插件补充 AAR、权限或第三方平台注册。
- CLI/Vite 模式在独立副本里引用 HBuilderX 对应的 `@dcloudio` 编译包；其他依赖链接到源码已有的 `node_modules`。Windows 目录使用 junction，避免依赖创建目录符号链接的管理员权限。
- “导出配置”生成不含 Key、密码、证书、本机路径的 JSON。换电脑后从“导入已有工程”窗口导入该配置，再重新选择源码、原生模板和原证书，重新填写 Key/密码。
- 工具仓库可以复制或通过 Git 分发；本仓库包含默认 DCloud 5.34 SDK。业务源码、自定义原生模板、私有 Key 和证书需要另行迁移。复制工具时连同 sdks/ 目录带走，包含默认 DCloud 原生 SDK，但不包含应用的业务源码和私密打包材料。
- Node 工具本身跨平台；Windows/Linux 需要对应平台的 HBuilderX、JDK 和 Android SDK，不能直接复制 Mac 软件安装目录当成跨平台软件使用。
- 当前只有 5.34 版本预设开放构建；其他版本可保存配置，需增加并验证相应工具链预设后使用。标准模板以单一 application 模块、单个 release APK 为目标；Kotlin DSL、自定义多变体、UTS/NDK 等工程需另外适配。

## 选择源码后自动回填应用身份

在项目工作台选择 UniApp 源码目录，或粘贴路径并离开输入框，工具会自动识别应用名、DCloud AppID、Android 包名、版本名称、版本码及前端类型。无需先点击识别按钮。支持根目录 manifest.json、src/manifest.json（JSONC 注释和尾逗号）以及常见 manifest.config.ts / manifest.config.js 的默认对象或 defineManifestConfig 对象配置。

- 优先读取 manifest.config 中能静态解析的属性，避免沿用旧的生成 manifest；读取根目录或 env/ 中的 .env、.env.local、.env.production、.env.production.local（后者优先）。支持常见环境变量引用和简单常量，不执行配置脚本、不触发 npm 或源码构建。
- 每个识别字段会显示来源文件。空白字段、未手改的默认值、上一次自动回填后未修改的值会自动更新。已有手填值保留；与源码不同时列出差异，点击“使用以上源码值”才替换。项目名称的自定义标签保留。
- 手动填写的版本名称、版本码用于本次打包；留空才沿用源码。版本只写入独立构建副本，原始 manifest 和 manifest.config 不回写；动态版本逻辑不符合填写值时停止构建并提示。
- 源码修改后可点击“重新读取源码”；保存项目之前，等待已开始的读取完成。识别结果进入当前表单，点击保存后用于打包，不直接修改业务源码。
- Android 包名只读取 Android 节点的 packagename / packageName / package，或显式的 VITE_ANDROID_PACKAGE_NAME 等 Android 包名变量；不拿 AppID、npm 包名、微信 AppID、iOS 或 Harmony 包名推测。源码没有配置时保留当前包名并提示；切换源码时清理先前未手改的自动值。
- 无法静态求值的函数、计算表达式和复杂 TS 逻辑会提示人工确认。源码中的地图 Key、DCloud AppKey、证书或密码不在这次身份回填范围内。

当前 BegaME 源码可识别应用名、AppID 和版本 1.0.5 / 105，Android 包名未在其源码中配置，使用工具中已保存的 com.begame.app。需要让其他新项目自动填入包名时，请在自己的 Android 配置中明确写出该值。

## 环境配置向导与 SDK 切换

环境缺失时，工作台右侧显示具体问题和“帮我配置好”。打包前会检查当前项目所需的 Android 平台/Build Tools；未就绪时保存项目配置并进入引导，不启动失败的构建任务。

1. 点击“先自动查找已有工具”，工具会复用本机已经安装的环境。
2. 仍缺 Java / Android 组件时，右侧列出将安装的项目。阅读并勾选 Android SDK 许可后，点“一键安装缺失组件”。安装完成会重新检查并刷新状态；失败可以查看日志、重试，或按步骤手动安装。
3. HBuilderX 和 Vue3 编译插件由你按对应系统的说明安装、登录。每项有详细步骤、官方下载入口和目录选择按钮。Windows ARM64 等无法自动安装 JDK 的组合会提供手动步骤。
4. 点击“保存并重新检查”，全部通过后点击“返回项目打包”。SDK 管理器缺失但已有编译组件齐全时，不会阻挡打包。

“本机环境”顶部的 **DCloud 离线 SDK 库** 与下方 **Google Android SDK 编译工具** 是两类东西。内置 SDK 位于工具的 `sdks/5.34-20261030/`，保留完整官方解压内容与许可；默认模板为 `HBuilder-Integrate-AS`，仅含标准基础模块。已有应用可继续使用原生自定义模板，地图、推送、支付等模块不会自动从其他应用复制。

自行切换：展开“自行下载并切换其他 SDK” → 打开官方下载页 → 下载并解压 → 选择解压目录及版本号 → “导入 SDK 到工具目录”。导入完成后，在项目“DCloud 离线 SDK / 原生模板”选择器中切换并保存。也可“设为默认”，仅影响以后创建的项目。当前只支持 5.34 出包，其他版本会显示“暂无构建预设”。导入不携带源目录的签名文件和私密 properties 配置。

整个工具目录可以搬家：库内 SDK 使用稳定 ID 与相对元数据，各台电脑启动时重新定位；自定义工程、源码、证书路径仍需重新选择。本仓库已包含 `sdks/5.34-20261030/`，Git 克隆后可直接选择默认 SDK。后续自行导入的其他 SDK 默认忽略，可按需纳入版本管理，详情见 `sdks/README.md`。打包的工作副本保存在本机数据目录，库内 SDK 不会被写入业务 Key 或签名。

## 数据与构建行为

只监听 `127.0.0.1`，不对局域网提供管理界面。API 校验本机 Host、Origin、会话和请求令牌。Key、地图 Key、签名密码采用 AES-256-GCM 加密保存在本机数据目录；主密钥也在本机文件中，文件权限为仅当前用户访问（Windows 权限仍受本机账户和目录 ACL 影响）。这不是云端密码托管服务。

默认数据目录：

| 系统 | 位置 |
| --- | --- |
| macOS | `~/Library/Application Support/UniPack` |
| Windows | `%LOCALAPPDATA%\UniPack` |
| Linux | `$XDG_DATA_HOME/unipack`，未设置时为 `~/.local/share/unipack` |

可通过 `UNIPACK_DATA_DIR` 指定其他本机数据目录。数据文件包括 `state.json`、`master.key`、`history.json`、`certificates/`、`workspaces/`、`artifacts/`。

构建过程：

```text
环境与证书检查
  → 独立前端副本（原业务源码保留原样）
  → HBuilderX 导出 App 本地资源
  → AppID / 编译器 / 资源完整性校验
  → 独立 Android 模板副本
  → 在副本写入应用配置和签名，Gradle release 构建
  → apksigner / aapt2 / zipalign 校验
  → 归档 APK、SHA256 和校验结果
```

工程内现有资源/业务代码不由工具直接改写。复制出的 Android 工作目录需要 Gradle 读取明文 Key 与签名配置，保存在受本机权限保护的工作目录中；不要把整个数据目录或编译工作目录提交到公共仓库。日志会对本工具配置的私密值与已识别的环境变量值脱敏。

保留已发布 APK、原证书、密码和配置。备份本机工具数据时需连同 `master.key` 一起私下备份，丢失它将无法解密已有配置。`workspaces/` 是编译缓存，可在停止所有任务后清理；`artifacts/` 是已归档的 APK，清理工作目录不影响它。

## 开发与验证

纯 Node.js ESM + 原生浏览器界面，前后端无需编译：

```bash
npm run check
npm test
```

测试覆盖密文存储、私密字段导出隔离、参数约束、日志跨块脱敏、进程取消、源码隔离、资源版本和 APK 身份拒绝分支、API 跨站/Host 防护。`npm test` 会启动临时本机端口。

主要文件：

| 文件 | 职责 |
| --- | --- |
| `server/index.mjs` | 本地 HTTP/API、会话、下载 |
| `server/store.mjs` | 项目、本机环境和密文保存 |
| `server/environment.mjs` | 多平台路径识别、环境检查 |
| `server/install.mjs` | 官方环境下载、校验与 SDK 安装 |
| `server/builder.mjs` | 独立副本、HBuilderX、Gradle、签名与产物校验 |
| `server/jobs.mjs` | 任务日志、脱敏、取消、历史 |
| `public/` | 中文可视化界面 |

通过环境变量或 npm 接收的自定义脚本不作为任意 Shell 命令执行接口。工具执行的是用户选定工程中的构建逻辑，导入和构建自己信任的工程。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Node 找不到或版本过低 | 从 Node 官方安装 22 或更新版本，重开终端 |
| HBuilderX/编译器未就绪 | 选择对应安装位置，安装 uni-app Vue3/Vite 编译插件并启动 HBuilderX |
| CLI/Vite 项目缺少 node_modules | 点击安装依赖，或在源码目录按团队要求安装 |
| 资源版本为旧版编译器 | 检查 HBuilderX 与所选原生 SDK 模板是否同版，使用 5.34 预设 |
| 证书指纹不匹配 | 选择原证书、正确别名；与 DCloud 平台记录核对 |
| 手机仍报 AppKey 错误 | 核对 DCloud 中同一行的 AppID/包名/签名，获取对应 Key 后重新构建安装 |
| Windows 长路径/链接失败 | 使用本地 NTFS 较短目录；重新安装本机依赖，避免网络盘和复制 Mac 的 node_modules |
| sdkmanager Java 版本错误 | 自动安装使用与 JDK17 配套的命令行工具19.0；也可通过 Android Studio 安装所需组件 |
| 模板图标/模块与目标应用不符 | 换成该应用对应的原生模板，或先维护好模板配置 |
| APK 覆盖安装失败 | 比较新旧包名、签名和版本码；保留原证书并提高版本码 |
| 任务取消后 HBuilderX 内仍显示导出工程 | 可以手动关闭工具创建的工作副本；无需关闭自己的源码工程 |

## 官方资料

- [DCloud Android 工程配置](https://nativesupport.dcloud.net.cn/AppDocs/usesdk/android.html)
- [DCloud 资源导出与版本要求](https://nativesupport.dcloud.net.cn/AppDocs/importfeproject/export.html)
- [DCloud AppKey 配置](https://nativesupport.dcloud.net.cn/AppDocs/usesdk/appkey.html)
- [Android SDK 管理器](https://developer.android.com/tools/sdkmanager)
- [Amazon Corretto 17 官方下载](https://docs.aws.amazon.com/corretto/latest/corretto-17-ug/downloads-list.html)

具体当前已完成的验证结果见 `VALIDATION.md`。Windows/Linux 的完整构建和自动安装分支需要在对应目标机器验收，macOS 出包不能代表这些系统已完成实测。
