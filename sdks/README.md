# DCloud 离线 SDK 库

`5.34-20261030/` 是从本机已下载的 `Android-SDK@5.34.82692_20261030.zip` 解压目录复制的官方 SDK，保留官方 `license.md` 和示例。默认使用 `HBuilder-Integrate-AS`（`simpleDemo` 模块），配套 HBuilderX **5.34.2026102909**。

这里的 SDK 不是 Google Android SDK；Java、Google 编译工具和 HBuilderX 仍由各台电脑配置。本机 SDK 示例内的公开 test.jks 仅属官方演示材料，不纳入 Git；UniPack 出包必须使用用户选择或新建的专用证书，不使用示例签名。

工具复制到另一台电脑时连同整个 `sdks` 文件夹复制。SDK 元数据使用相对路径，已选择库内 SDK 的项目按 ID 自动定位。本仓库已包含 5.34-20261030 SDK，Git 克隆后可以直接使用。后续自行导入的其他版本目录默认忽略；需要同步时可明确纳入 Git，或在另一台电脑重新导入。

自行下载：https://nativesupport.dcloud.net.cn/AppDocs/download/android.html

导入后生成独立子目录及 `sdk.json`；不要手动改写已有 SDK。当前只有 5.34 构建预设，其他版本可入库，但不能设为默认或出包。需要额外地图、推送、支付等原生功能时，维护项目自己的原生模板和对应第三方配置。
