import { sourceFields, sourceFieldNames, planSourceFill } from './source-autofill.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { projects: [], jobs: [], environment: {}, system: {}, view: 'project', selectedId: localStorage.getItem('unipack.project'), currentJob: null, currentJobId: null, report: null, busy: false, dirty: false, polling: false, sdks: { items: [] }, licenseAccepted: false };
const labels = { build: 'APK 构建', environment: '安装环境', 'sdk-import': '导入 DCloud SDK', dependencies: '安装依赖', certificate: '读取证书', 'generate-certificate': '创建证书' };
const statusNames = { running: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消', cancelling: '正在取消', interrupted: '已中断' };
let token = '', toastTimer;
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `visible${error ? ' error' : ''}`; toastTimer = setTimeout(() => $('#toast').className = '', error ? 8000 : 4000); }
async function api(url, data, method = data ? 'POST' : 'GET') {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-UniPack-Token': token }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作失败');
  return value;
}
const project = () => state.projects.find(p => p.id === state.selectedId);
const busyAttribute = () => state.busy ? 'disabled' : '';
const platformName = () => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[state.system.platform] || '本机';
const formatTime = iso => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const jobForProject = () => state.view === 'environment' ? ([state.currentJob, ...state.jobs].find(j => j && ['environment', 'sdk-import'].includes(j.kind)) || null) : state.currentJob || state.jobs.find(j => j.projectId === state.selectedId) || null;
const canInstallEnvironment = () => !!state.report?.summary?.automatic.length && !state.report.checks.some(c => c.key === 'java' && !c.ok && !c.guide?.automatic);
function tag(status) { return `<span class="tag ${status === 'succeeded' ? 'success' : status === 'failed' ? 'failed' : ['running', 'cancelling'].includes(status) ? 'warn' : ''}">${statusNames[status] || esc(status)}</span>`; }
function input(name, label, value = '', hint = '', extra = '') { return `<label class="field ${extra.includes('wide') ? 'wide' : ''}">${label}<input name="${name}" id="field-${name}" value="${esc(value)}" ${['minSdk', 'targetSdk', 'compileSdk'].includes(name) ? 'type="number" min="21" max="100"' : ''} autocomplete="off">${hint ? `<small>${hint}</small>` : ''}</label>`; }
function pathInput(name, label, value = '', hint = '', kind = 'directory') { return `<label class="field wide">${label}<div class="path-field"><input name="${name}" id="field-${name}" value="${esc(value)}" placeholder="选择本机${kind === 'certificate' ? '证书文件' : '文件夹'}" autocomplete="off"><button type="button" class="browse secondary" data-target="field-${name}" data-kind="${kind}">浏览</button></div>${hint ? `<small>${hint}</small>` : ''}</label>`; }
function secretInput(name, label, hasValue, hint = '') { return `<label class="field">${label}<div class="secret-field"><input type="password" name="secret:${name}" id="secret-${name}" placeholder="${hasValue ? '已保存 · 留空保留原值' : '请填写'}" autocomplete="new-password"><button type="button" data-reveal="${name}" title="显示或隐藏">显示</button></div>${hint ? `<small>${hint}</small>` : ''}</label>`; }
function sidebar() {
  $('#projectCount').textContent = state.projects.length;
  $('#projectList').innerHTML = state.projects.map(p => `<button class="project-item ${p.id === state.selectedId ? 'active' : ''}" data-project="${p.id}"><span class="project-avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span><span class="project-info"><strong>${esc(p.name)}</strong><small>${esc(p.packageName || '待配置应用身份')}</small></span>${p.id === state.selectedId ? '<span class="project-active-dot"></span>' : ''}</button>`).join('');
  $('#machineLabel').innerHTML = `${esc(platformName())} · ${esc(state.system.arch || '')}<small>Key 和证书保留在本机</small>`;
  $('#dataHint').textContent = state.system.dataDir || '';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  $('#viewTitle').textContent = ({ project: '项目工作台', environment: '本机环境', history: '构建记录' })[state.view];
  $('#envDot').className = `nav-dot ${state.report?.ready ? 'ready' : ''}`;
}
function environmentMini() {
  const checks = state.report?.checks || [], missing = checks.filter(c => c.required && !c.ok);
  return `<section class="card side-card"><div class="card-header"><h2>本机环境</h2><button class="text-button" data-action="environment">配置向导 ↗</button></div><div class="card-body"><div class="env-summary"><span class="env-icon">⌘</span><div><strong>${esc(platformName())} / ${esc(state.system.arch || '')}</strong><small>${esc(state.system.hostname || '')} · Node ${esc(state.system.node || '')}</small></div></div>${missing.length ? `<div class="setup-alert"><strong>还有 ${missing.length} 项需要配置</strong><p>${esc(missing.map(c => c.name).join('、'))}</p><button class="primary full small-button" data-action="environment">帮我配置好 →</button><small>自动安装 Java / Android，其他项目逐步教你完成。</small></div>` : ''}<div class="mini-checks">${checks.filter(c => c.required).map(c => `<div class="mini-check"><i class="check-indicator ${c.ok ? '' : 'warn'}">${c.ok ? '✓' : '!'}</i>${esc(c.name)}${c.ok ? '<span>已就绪</span>' : `<button class="text-button" data-guide="${esc(c.key)}">${c.guide?.automatic ? '一键配置' : '查看步骤'} ↗</button>`}</div>`).join('') || '<div class="muted">先检查环境，再按向导完成配置。</div>'}</div><div class="side-note">${state.report?.ready ? '编译工具已就绪。' : ''}HBuilderX 首次登录后保持运行。<br>DCloud 离线 SDK 可使用工具内置版本，也可自行导入切换。</div><button class="secondary full small-button" data-action="check-env" ${busyAttribute()}>重新检查环境</button></div></section>`;
}
function sdkChoice(p) {
  return `<label class="field wide">DCloud 离线 SDK / 原生模板<select name="sdkId" id="projectSdk"><option value="" ${!p.sdkId ? 'selected' : ''}>自定义 Android 工程（保留已有模块与图标）</option>${state.sdks.items.map(s => `<option value="${esc(s.id)}" ${p.sdkId === s.id ? 'selected' : ''} ${!s.supported ? 'disabled' : ''}>${esc(s.name)}${s.id === state.sdks.defaultId ? ' · 新项目默认' : ''}${!s.supported ? ' · 暂无构建预设' : ''}</option>`).join('')}</select><small>新项目自动使用工具内置 SDK；已有应用可继续使用原生工程。切换 SDK 后请核对模块、图标及版本。</small></label>`;
}

function fingerprints(certificate) {
  if (!certificate) return '';
  return `<div class="fingerprints">${['sha1', 'sha256', 'md5'].map(key => `<div class="fingerprint"><label>${key.toUpperCase()}<button data-copy="${esc(certificate[key])}">复制</button></label><code>${esc(certificate[key])}</code></div>`).join('')}</div>`;
}
function jobCard() {
  const job = jobForProject();
  if (!job) return `<section class="card side-card"><div class="card-header"><h2>构建任务</h2><span class="version-label">READY TO BUILD</span></div><div class="card-body"><div class="job-idle"><span class="job-idle-icon">↗</span><h3>下一份 APK，从这里开始</h3><p>配置保存后，点击“一键构建 APK”<br>过程日志与校验结果会显示在这里</p></div></div></section>`;
  const active = ['running', 'cancelling'].includes(job.status);
  return `<section class="card side-card"><div class="card-header"><h2>${labels[job.kind] || '任务'}</h2>${tag(job.status)}</div><div class="card-body"><div class="job-state"><strong>${esc(job.step)}</strong><span class="version-label">${job.progress || 0}%</span></div><progress class="job-progress" value="${job.progress || 0}" max="100"></progress><div class="job-meta"><span>${formatTime(job.startedAt)}</span><span>${esc(job.id.slice(0, 8))}</span></div>${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ''}${job.result?.message ? `<div class="job-success">${esc(job.result.message)}</div>` : ''}<div class="job-buttons">${active ? `<button class="danger small-button" data-cancel="${job.id}" ${job.status === 'cancelling' ? 'disabled' : ''}>取消任务</button>` : ''}${job.result?.relativePath ? `<button class="primary small-button" data-download="${job.id}">下载 APK</button><button class="secondary small-button" data-reveal-job="${job.id}">打开目录</button>` : ''}</div>${fingerprints(job.result?.certificate)}<div class="log-panel"><div class="log-toolbar">TASK OUTPUT <button data-action="toggle-log">${state.pauseLog ? '继续滚动' : '暂停滚动'}</button></div><pre id="jobLog">${esc((job.logs || []).slice(-350).map(l => l.text).join('\n') || '正在准备…')}</pre></div></div></section>`;
}
function historyTable(jobs, limit = 6) {
  const rows = jobs.slice(0, limit);
  if (!rows.length) return '<div class="empty-table">还没有构建记录。完成第一次打包后会保留结果和校验信息。</div>';
  return `<table class="history-table"><thead><tr><th>任务 / 项目</th><th>状态</th><th class="desktop-cell">版本</th><th class="desktop-cell">开始时间</th><th>产物</th></tr></thead><tbody>${rows.map(j => `<tr><td><button class="text-button" data-job="${j.id}">${esc(state.projects.find(p => p.id === j.projectId)?.name || '本机环境')}</button><span class="history-file">${esc(labels[j.kind] || j.kind)}</span></td><td>${tag(j.status)}</td><td class="desktop-cell"><code>${esc(j.result?.versionName || '—')}</code></td><td class="desktop-cell"><code>${formatTime(j.startedAt)}</code></td><td>${j.result?.relativePath ? `<button class="text-button" data-download="${j.id}">↓ APK</button><span class="history-file">${(j.result.bytes / 1024 / 1024).toFixed(1)} MB · 已校验</span>` : '<span class="version-label">—</span>'}</td></tr>`).join('')}</tbody></table>`;
}
function renderProject() {
  const p = project();
  if (!p) { $('#main').innerHTML = `<div class="onboarding"><span class="onboarding-badge">BUILD ON YOUR MACHINE</span><h1>多个项目，多台电脑。<br>一个本地打包工作台。</h1><p>选择源码，配置环境与签名，从这里生成下一份 APK。<br>每个项目独立保存，本机直接编译。</p><div class="heading-buttons"><button class="primary" data-action="import">↳ 导入已有工程</button><button class="secondary" data-action="new">＋ 新建项目</button></div><p class="support-line">UniApp · Android APK · macOS / Windows / Linux</p></div>`; return; }
  const has = p.hasSecrets || {};
  $('#main').innerHTML = `<div class="page-heading"><div><span class="eyebrow">PROJECT WORKBENCH</span><h1>${esc(p.name)}</h1><p>配置一次，重复构建。每份 APK 都有清晰的身份与记录。</p></div><div class="heading-buttons"><button class="secondary" data-action="save">保存配置</button><button class="primary" data-action="build" ${busyAttribute()}>↗ 一键构建 APK</button></div></div><div class="hero"><div><h2>让发布，成为一件顺手的事。</h2><p>当前项目使用独立工作目录构建，沿用选择的原生模板与签名。</p><div class="step-strip"><span><b>1</b>选择项目</span><i></i><span><b>2</b>配置环境</span><i></i><span><b>3</b>填写签名与 Key</span><i></i><span><b>4</b>生成 APK</span></div></div><div class="hero-status"><span class="dot"></span>${state.report?.ready ? '本机环境已就绪' : '先确认环境与项目配置'}</div></div><div class="workspace-grid"><form id="projectForm" class="form-stack"><section class="card"><div class="card-header"><div class="section-title"><span class="section-number">01</span><h2>项目文件</h2></div><button type="button" class="text-button" data-action="export-profile">导出配置 ↗</button></div><div class="card-body fields">${input('name', '项目名称', p.name)}${input('appName', '应用显示名', p.appName)}${pathInput('sourceDir', 'UniApp 源码目录', p.sourceDir, '选择源码后会自动读取应用身份；支持 manifest.json、src/manifest.json 和常见 manifest.config.ts 配置。')}${sdkChoice(p)}${pathInput('androidDir', 'Android 原生模板目录', p.androidDir, p.sdkId ? '由上面的 SDK 选择器管理；如需其他路径，先选择“自定义 Android 工程”。' : '选择含 settings.gradle 的工程。原生模块、图标和网络设置沿用此模板。')}</div><div class="card-bottom"><span>原项目保留原样，编译副本由工作台管理。</span><div class="inline-actions"><button type="button" class="text-button" data-action="inspect-source">重新读取源码</button><button type="button" class="text-button" data-action="dependencies" ${busyAttribute()}>安装依赖</button></div></div></section><section class="card"><div class="card-header"><div class="section-title"><span class="section-number">02</span><h2>应用身份</h2></div><span class="section-caption">与 DCloud 控制台保持一致</span></div><div class="card-body"><div class="fields">${input('appId', 'DCloud AppID', p.appId, '例如 __UNI__F18D3DB')}${input('packageName', 'Android 包名', p.packageName, '已有应用升级时继续使用原包名。')}${input('versionName', '版本名称', p.versionName, '手填优先，仅用于构建副本；留空沿用源码。')}${input('versionCode', '版本码', p.versionCode, '手填优先，不回写源码；升级请提高版本码。')}</div><div id="sourceRecognition" aria-live="polite"></div><details><summary>编译与 Android 高级配置</summary><div class="fields"><label class="field">前端类型<select name="frontendMode"><option value="cli-vue3" ${p.frontendMode === 'cli-vue3' ? 'selected' : ''}>Vue3 / Vite CLI 项目</option><option value="hbuilder" ${p.frontendMode === 'hbuilder' ? 'selected' : ''}>HBuilderX 可视化项目</option></select></label>${input('moduleName', 'Android 模块名', p.moduleName)}${input('sdkVersion', 'HBuilderX / 离线 SDK 版本', p.sdkVersion, '当前可构建预设为 5.34。')}${input('buildTools', 'Android Build Tools', p.buildTools)}${input('minSdk', 'minSdk', p.minSdk)}${input('targetSdk', 'targetSdk', p.targetSdk)}${input('compileSdk', 'compileSdk', p.compileSdk)}</div></details></div></section><section class="card"><div class="card-header"><div class="section-title"><span class="section-number">03</span><h2>AppKey 与签名</h2></div><span class="tag">仅保存在本机</span></div><div class="card-body"><div class="fields">${secretInput('dcloudAppKey', 'DCloud Android AppKey', has.dcloudAppKey, '从匹配 AppID、包名、签名 SHA1 的平台记录获取。')}${secretInput('amapAndroidKey', '高德 Android Key（可选）', has.amapAndroidKey, '使用原生地图时配置，与 DCloud AppKey 分开。')}${pathInput('certificatePath', 'Android 签名证书', p.certificatePath, '已有应用选择原证书，确保可以覆盖安装升级。', 'certificate')}${input('certificateAlias', '证书别名', p.certificateAlias)}${input('expectedSha1', '预期证书 SHA1（建议填写）', p.expectedSha1, '填入 DCloud 登记的指纹；构建时会核对。')}${secretInput('storePassword', '证书密码', has.storePassword)}${secretInput('keyPassword', '私钥密码', has.keyPassword, '留空时使用证书密码。')}</div><div class="certificate-actions"><button type="button" class="secondary small-button" data-action="certificate" ${busyAttribute()}>读取证书指纹</button><button type="button" class="text-button" data-action="generate-certificate" ${busyAttribute()}>新应用 · 创建专用证书</button></div><p class="support-line"><a href="https://dev.dcloud.net.cn/" target="_blank" rel="noopener noreferrer">打开 DCloud 控制台 ↗</a>　生成证书后，登记指纹并获取对应 AppKey，再构建。</p></div><div class="card-bottom"><span class="saved-note">◌ 私密值在本机加密保存，导出配置不包含 Key 和密码。</span></div></section></form><aside class="side-stack"><div id="environmentMini">${environmentMini()}</div><div id="taskCard">${jobCard()}</div></aside></div><section class="history-section"><div class="section-heading"><h2>最近构建</h2><button class="text-button" data-action="history">全部记录 ↗</button></div><div class="card" id="recentHistory">${historyTable(state.jobs.filter(j => j.projectId === p.id && j.kind === 'build'))}</div></section>`;
}
function setupSummary() {
  const r = state.report, missing = r?.checks.filter(c => c.required && !c.ok) || [];
  return `<div class="setup-banner ${r?.ready ? 'complete' : ''}"><div><span class="eyebrow">${r?.ready ? 'READY' : 'LET’S SET UP'}</span><h2>${!r ? '先检查一次，看看这台电脑缺什么' : r.ready ? '检查通过，可以开始打包了' : `检测到 ${missing.length} 项问题，按下面的步骤完成`}</h2><p>${esc(project()?.name || '默认项目')} · DCloud ${esc(project()?.sdkVersion || '5.34')} · Android API ${esc(project()?.compileSdk || 36)} / Build Tools ${esc(project()?.buildTools || '36.0.0')}</p></div>${r?.ready && project() ? '<button class="primary" data-action="return-project">返回项目打包 →</button>' : '<button class="secondary" data-action="detect-env" '+busyAttribute()+'>先自动查找已有工具</button>'}</div><div class="setup-flow"><span><b>1</b>自动查找已有工具</span><span><b>2</b>一键补齐 Java / Android</span><span><b>3</b>按步骤配置 HBuilderX</span><span><b>4</b>检查通过，返回打包</span></div>`;
}
function sdkLibrary() {
  return `<section class="card" id="sdkLibrary"><div class="card-header"><div class="section-title"><span class="section-number">01</span><h2>DCloud 离线 SDK 库</h2></div><span class="tag">随工具携带</span></div><div class="card-body"><div class="notice">这里是 DCloud 原生 SDK，与下方 Google Android 编译工具分开管理。内置你下载的 5.34，移动整个 UniPack 文件夹后仍可使用。已有项目的自定义模板继续保留。</div><div class="sdk-items">${state.sdks.items.map(s => `<div class="sdk-item"><div><strong>${esc(s.name)}</strong><small>配套 HBuilderX ${esc(s.hbuilderVersion)} · ${esc(s.moduleName)} 模块</small><code>${esc(s.directory)}</code></div>${s.id === state.sdks.defaultId ? '<span class="tag success">新项目默认</span>' : `<button class="secondary small-button" data-default-sdk="${esc(s.id)}" ${!s.supported || state.busy ? 'disabled' : ''}>${s.supported ? '设为默认' : '暂无构建预设'}</button>`}</div>`).join('') || '<p class="muted">尚未发现 SDK，请按下面步骤导入。</p>'}</div><p class="support-line">默认值只用于新项目；已有项目在“项目文件”中选择 SDK，保存后生效。当前可构建版本为 5.34。</p><details id="sdkImport"><summary>自行下载并切换其他 SDK</summary><ol class="guide-steps"><li><a href="https://nativesupport.dcloud.net.cn/AppDocs/download/android.html" target="_blank" rel="noopener noreferrer">打开 DCloud 官方下载页面 ↗</a>，下载所需版本，先在电脑上解压。</li><li>选择包含 HBuilder-Integrate-AS 的解压目录，填写下载页面的版本号，点击“导入 SDK”。</li><li>导入完成后，在项目的 SDK 选择器中切换。HBuilderX 与编译插件也要匹配；尚无构建预设的版本会标记为不可出包。</li></ol><div class="fields">${pathInput('sdkImportDir', '已解压的 DCloud SDK 目录', '', '可以选择 SDK 根目录，也可以直接选择标准 HBuilder-Integrate-AS 工程。')}${input('sdkImportVersion', '下载页面标注的版本', '5.34')}<div class="field import-sdk-action"><button class="primary" data-action="import-sdk" ${busyAttribute()}>导入 SDK 到工具目录</button></div></div></details></div></section>`;
}
function repairContent() {
  const automatic = state.report?.checks.filter(c => c.required && !c.ok && c.guide?.automatic) || [];
  const manual = state.report?.checks.filter(c => c.required && !c.ok && !c.guide?.automatic) || [];
  const manualJava = state.report?.checks.some(c => c.key === 'java' && !c.ok && !c.guide?.automatic);
  const failed = state.currentJob?.kind === 'environment' && state.currentJob.status === 'failed';
  return `<p class="repair-intro">${manualJava ? '此系统需先按左侧步骤安装 JDK 17，重新检查后即可补齐 Android 组件。' : automatic.length ? `可自动处理 ${automatic.length} 项。先复用已有工具，再从官方源下载缺少的组件。` : state.report ? 'Java / Android 无需自动安装。若仍有问题，请按左侧对应步骤处理。' : '先检测环境，这里会列出需要自动安装的内容。'}</p><ul class="repair-list">${automatic.map(c => `<li><span>＋</span>${esc(c.name)}</li>`).join('')}</ul><p class="install-note">默认安装到本机数据目录；已选择的 Android SDK 会继续使用。无需先安装 Android Studio，也无需手动配置系统环境变量。</p><label class="license"><input type="checkbox" id="acceptLicense" ${state.licenseAccepted ? 'checked' : ''}><span>我已阅读并同意 <a href="https://developer.android.com/studio/terms" target="_blank" rel="noopener noreferrer">Android SDK 许可协议</a>，允许安装所需组件。</span></label><div class="install-actions"><button class="primary" data-action="install-env" ${state.busy || !canInstallEnvironment() ? 'disabled' : ''}>${state.busy && state.currentJob?.kind === 'environment' ? '正在配置，请稍候…' : '一键安装缺失组件'}</button><button class="secondary" data-action="detect-env" ${busyAttribute()}>我已装过，自动查找</button></div>${manual.length ? `<p class="install-note">还需手动处理：${esc(manual.map(c => c.name).join('、'))}。左侧已列出逐步操作；安装程序和登录由你完成。</p>` : ''}${failed ? '<div class="setup-alert"><strong>安装未完成，可以重试</strong><p>先查看下方任务日志。下载失败时检查网络再重试；也可按左侧说明手动安装后选择目录。已完成的组件会复用。</p></div>' : ''}<p class="install-note">下载和校验结果在任务中显示。Linux 需要 tar、unzip；不支持自动安装的架构会提供手动步骤。</p>`;
}
function renderEnvironment() {
  const e = state.environment;
  $('#main').innerHTML = `<div class="page-heading"><div><span class="eyebrow">MACHINE SETUP</span><h1>跟着做，准备好打包环境。</h1><p>不知道目录在哪里？先自动查找。缺少的组件会告诉你如何补齐。</p></div><button class="secondary" data-action="check-env" ${busyAttribute()}>保存并重新检查 ↻</button></div><div id="setupSummary">${setupSummary()}</div><div class="environment-grid"><div class="form-stack">${sdkLibrary()}<section class="card"><div class="card-header"><div class="section-title"><span class="section-number">02</span><h2>逐项检查与操作步骤</h2></div><button class="text-button" data-action="check-env" ${busyAttribute()}>重新检查 ↻</button></div><div class="card-body environment-checks" id="environmentReport">${environmentReport()}</div></section><section class="card" id="toolPaths"><div class="card-header"><div class="section-title"><span class="section-number">03</span><h2>已有工具？在这里选择位置</h2></div><span class="tag">${esc(platformName())}</span></div><form id="environmentForm" class="card-body fields">${pathInput('hbuilderPath', 'HBuilderX 安装目录', e.hbuilderPath, 'macOS 选择 HBuilderX.app；Windows / Linux 选择包含 cli 的目录。')}${pathInput('javaHome', 'JDK 17 根目录', e.javaHome, '选择含 bin/java、bin/javac 的目录；Mac 通常位于 Contents/Home。')}${pathInput('sdkRoot', 'Google Android SDK 根目录（编译工具）', e.sdkRoot, '包含 platforms、build-tools、platform-tools。不要选择上方的 DCloud SDK；一键安装时可留空。')}</form><div class="card-bottom"><span>自动安装后路径会保存。HBuilderX 需使用与 DCloud SDK 相同的版本，并完成首次登录。</span><button class="secondary small-button" data-action="save-env" ${busyAttribute()}>保存并检查</button></div></section></div><aside class="form-stack"><section class="card" id="repairCard"><div class="card-header"><h2>一键补齐 Java / Android</h2><span class="tag">官方源</span></div><div class="card-body" id="repairContent">${repairContent()}</div></section><div id="taskCard">${jobCard()}</div></aside></div>`;
}
function environmentReport() {
  return state.report?.checks.map(c => `<article class="environment-item" id="guide-${esc(c.key)}"><div class="environment-row"><span class="check-indicator ${c.ok || !c.required ? '' : 'warn'}">${c.ok ? '✓' : c.required ? '!' : 'i'}</span><div><strong>${esc(c.name)}</strong><p>${esc(c.ok ? c.detail : c.guide?.reason || c.action)}</p></div><span class="tag ${c.ok ? 'success' : c.required ? 'warn' : ''}">${c.ok ? '已就绪' : c.required ? c.guide?.automatic ? '可自动安装' : '按步骤配置' : '可选'}</span></div>${!c.ok ? `<details class="check-guide" ${c.required ? 'open' : ''}><summary>${c.required ? '具体怎么做' : '这是什么，是否需要安装'}</summary><ol class="guide-steps">${(c.guide?.steps || []).map(step => `<li>${esc(step)}</li>`).join('')}</ol><div class="guide-buttons">${c.guide?.automatic ? '<button class="primary small-button" data-action="show-repair">去一键安装 →</button>' : ''}${c.guide?.field ? `<button class="secondary small-button" data-env-path="${esc(c.guide.field)}">已安装，选择位置</button>` : ''}${c.guide?.link ? `<a href="${esc(c.guide.link)}" target="_blank" rel="noopener noreferrer">${esc(c.guide.linkLabel)} ↗</a>` : ''}${c.guide?.extraLink ? `<a href="${esc(c.guide.extraLink)}" target="_blank" rel="noopener noreferrer">${esc(c.guide.extraLabel)} ↗</a>` : ''}</div></details>` : ''}</article>`).join('') || '<p class="muted">点“自动查找已有工具”，随后逐项完成配置。</p>';
}

function renderHistory() { $('#main').innerHTML = `<div class="page-heading"><div><span class="eyebrow">BUILD HISTORY</span><h1>每次构建，都有迹可循。</h1><p>查看任务输出、证书校验和 APK，继续下一次发布。</p></div><button class="secondary" data-action="refresh">刷新记录 ↻</button></div><section class="card" id="allHistory">${historyTable(state.jobs, 60)}</section>`; }
function render() { sidebar(); if (state.view === 'environment') renderEnvironment(); else if (state.view === 'history') renderHistory(); else renderProject(); if ($('#field-androidDir')) $('#field-androidDir').readOnly = !!$('#projectSdk')?.value; renderSourceRecognition(); updateTask(); if (state.view === 'project' && $('#field-sourceDir')?.value.trim() && !matchingSourceDraft()) queueMicrotask(() => recognizeSource().catch(error => toast(error.message, true))); }
function canLeaveProject() {
  if (state.dirty && !confirm('当前项目有尚未保存的修改，离开将丢失这些修改。是否继续？')) return false;
  state.dirty = false;
  return true;
}
function scrollLog() { if (!state.pauseLog && $('#jobLog')) $('#jobLog').scrollTop = $('#jobLog').scrollHeight; }
function updateTask() { if ($('#taskCard')) { $('#taskCard').innerHTML = jobCard(); const task = $('#taskCard'), side = task.closest('.side-stack'); if (side && state.report?.ready && jobForProject() && side.firstElementChild !== task) side.prepend(task); } if ($('#recentHistory')) $('#recentHistory').innerHTML = historyTable(state.jobs.filter(j => j.projectId === state.selectedId && j.kind === 'build')); if ($('#allHistory')) $('#allHistory').innerHTML = historyTable(state.jobs, 60); document.querySelectorAll('[data-action="build"], [data-action="dependencies"], [data-action="certificate"], [data-action="generate-certificate"], [data-action="install-env"], [data-action="detect-env"], [data-action="save-env"], [data-action="import-sdk"], [data-default-sdk]').forEach(b => b.disabled = state.busy || (b.dataset.action === 'install-env' && !canInstallEnvironment()) || (b.dataset.defaultSdk && !state.sdks.items.find(s => s.id === b.dataset.defaultSdk)?.supported)); scrollLog(); }
async function refreshState(initial = false) {
  const value = await api('/api/state');
  Object.assign(state, value);
  if (!state.projects.some(p => p.id === state.selectedId)) state.selectedId = state.projects[0]?.id;
  if (state.currentJobId) {
    const before = state.currentJob?.status;
    state.currentJob = await api(`/api/jobs/${state.currentJobId}`);
    if (before && before !== state.currentJob.status && state.currentJob.status === 'succeeded') {
      toast(state.currentJob.kind === 'build' ? 'APK 构建成功，已完成本地校验' : '任务已完成');
      if (['generate-certificate', 'environment', 'sdk-import'].includes(state.currentJob.kind)) {
        const next = await api('/api/state'); Object.assign(state, next);
        if (state.currentJob.kind === 'environment') state.report = await api('/api/environment/check', { projectId: state.selectedId });
        if (!state.dirty) render();
      }
    }
  } else {
    const active = state.jobs.find(j => ['running', 'cancelling'].includes(j.status));
    if (active) { state.currentJobId = active.id; state.currentJob = await api(`/api/jobs/${active.id}`); }
  }
  if (state.currentJob?.kind === 'environment' && state.currentJob.status === 'failed' && !state.reportedFailure) { state.reportedFailure = state.currentJob.id; await checkEnvironment(); }
  if (initial) render(); else { sidebar(); updateTask(); }
}
async function checkEnvironment() {
  state.report = await api('/api/environment/check', { projectId: state.selectedId });
  sidebar();
  for (const [selector, content] of [['#environmentMini', environmentMini], ['#environmentReport', environmentReport], ['#setupSummary', setupSummary], ['#repairContent', repairContent]]) if ($(selector)) $(selector).innerHTML = content();
  if ($('.hero-status')) $('.hero-status').innerHTML = `<span class="dot"></span>${state.report.ready ? '本机环境已就绪' : '环境需要配置，点击右侧“帮我配置好”'}`;
}
async function openEnvironmentGuide(key) {
  if (state.view === 'project' && state.dirty) await saveProject(false);
  state.view = 'environment'; render();
  if (!state.report) await checkEnvironment();
  if (key) document.getElementById(`guide-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function saveProject(showMessage = true) {
  const form = $('#projectForm'), projectId = state.selectedId;
  if (!form) throw new Error('请先选择项目');
  const draft = matchingSourceDraft();
  if (draft?.status === 'loading') await draft.completion;
  else if ($('#field-sourceDir')?.value.trim() && $('#field-sourceDir').value.trim() !== project()?.sourceDir && (!draft || draft.status === 'idle')) await recognizeSource();
  if (form !== $('#projectForm') || projectId !== state.selectedId) throw new Error('当前项目已切换，请在目标项目中重新保存');
  const data = {}, secrets = {};
  for (const [key, value] of new FormData(form)) { if (key.startsWith('secret:')) secrets[key.slice(7)] = value; else data[key] = value; }
  data.secrets = secrets;
  const value = await api(`/api/projects/${state.selectedId}`, data, 'PUT');
  state.projects[state.projects.findIndex(p => p.id === value.id)] = value;
  state.dirty = false;
  render();
  await checkEnvironment();
  if (showMessage) toast('项目配置已保存，私密值已加密保存在本机');
  return value;
}
async function saveEnvironment(showMessage = true) {
  if (state.busy) throw new Error('当前任务正在使用环境配置，请等待任务结束');
  if ($('#environmentForm')) state.environment = await api('/api/environment', Object.fromEntries(new FormData($('#environmentForm'))), 'PUT');
  if (showMessage) toast('本机环境路径已保存');
}
async function startProjectJob(action) {
  await saveProject(false);
  if (action === 'build') { await checkEnvironment(); if (!state.report.ready) { await openEnvironmentGuide(); toast('项目已保存，按向导配置好环境后即可打包'); return; } }
  const job = await api(`/api/projects/${state.selectedId}/${action}`, {});
  state.currentJobId = job.id; state.currentJob = job; state.busy = true; updateTask();
  toast(`已开始${labels[job.kind] || '任务'}`);
}
async function newProject() {
  if (state.dirty && !confirm('当前表单有尚未保存的修改，是否先离开？')) return;
  const p = await api('/api/projects', { name: '新项目', appName: '新应用' });
  state.projects.push(p); state.selectedId = p.id; localStorage.setItem('unipack.project', p.id); state.view = 'project'; state.currentJob = null; state.currentJobId = null; state.dirty = false; render();
}
async function downloadBlob(blob, name) { const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 15000); }
async function downloadApk(jobId) {
  toast('正在准备 APK 下载…');
  const response = await fetch(`/api/jobs/${jobId}/artifact`, { headers: { 'X-UniPack-Token': token } });
  if (!response.ok) throw new Error((await response.json()).error || '下载失败');
  const job = state.jobs.find(j => j.id === jobId) || state.currentJob;
  await downloadBlob(await response.blob(), job?.result?.fileName || 'app.apk');
}
async function action(name) {
  if (name === 'save') return saveProject();
  if (['build', 'dependencies', 'certificate', 'generate-certificate'].includes(name)) return startProjectJob(name);
  if (name === 'new') return newProject();
  if (name === 'import') return $('#importDialog').showModal();
  if (name === 'environment') return openEnvironmentGuide();
  if (name === 'return-project') { await saveEnvironment(false); await checkEnvironment(); if (!state.report.ready) throw new Error('还有未完成的环境项，请先按步骤处理'); state.view = 'project'; render(); window.scrollTo({ top: 0 }); return; }
  if (name === 'show-repair') { $('#repairCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#acceptLicense')?.focus({ preventScroll: true }); return; }
  if (name === 'history') { if (!canLeaveProject()) return; state.view = name; render(); return; }
  if (name === 'check-env') { if (state.view === 'environment') await saveEnvironment(false); await checkEnvironment(); toast(state.report.ready ? '环境检查通过' : '检查完成，请补充标记的环境项'); return; }
  if (name === 'detect-env') { await saveEnvironment(false); const value = await api('/api/environment/detect', { projectId: state.selectedId }); state.environment = value.environment; state.report = value.report; render(); toast('已识别并保存本机可用路径'); return; }
  if (name === 'save-env') { await saveEnvironment(); await checkEnvironment(); return; }
  if (name === 'install-env') {
    if (!$('#acceptLicense')?.checked) throw new Error('请先阅读并勾选同意 Android SDK 许可协议');
    await saveEnvironment(false);
    const job = await api('/api/environment/install', { projectId: state.selectedId, acceptSdkLicense: true });
    state.reportedFailure = null; state.currentJobId = job.id; state.currentJob = job; state.busy = true; if ($('#repairContent')) $('#repairContent').innerHTML = repairContent(); updateTask(); toast('正在准备本机环境'); return;
  }
  if (name === 'import-sdk') {
    const job = await api('/api/sdks/import', { sourceDir: $('#field-sdkImportDir').value, version: $('#field-sdkImportVersion').value });
    state.currentJobId = job.id; state.currentJob = job; state.busy = true; updateTask(); toast('正在复制 SDK，导入完成后可在项目中切换'); return;
  }
  if (name === 'inspect-source') return recognizeSource();
  if (name === 'use-source') return applyRecognizedSource();
  if (name === 'export-profile') { await saveProject(false); const value = await api(`/api/projects/${state.selectedId}/export`); await downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), `${project().name}.unipack.json`); toast('已导出项目配置，不包含 Key、密码或本机路径'); return; }
  if (name === 'toggle-log') { state.pauseLog = !state.pauseLog; updateTask(); return; }
  if (name === 'refresh') { await refreshState(); toast('记录已更新'); }
}
async function handleClick(event) {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.classList.contains('browse') && button.dataset.target === 'field-androidDir' && $('#projectSdk')?.value) throw new Error('请先在 SDK 选择器中选择“自定义 Android 工程”，再修改路径');
  if (button.classList.contains('browse')) return openBrowser(button.dataset.target, button.dataset.kind);
  if (button.dataset.guide) return openEnvironmentGuide(button.dataset.guide);
  if (button.dataset.envPath) { $('#toolPaths').scrollIntoView({ behavior: 'smooth', block: 'start' }); return openBrowser(`field-${button.dataset.envPath}`); }
  if (button.dataset.defaultSdk) { state.sdks = await api('/api/sdks/default', { sdkId: button.dataset.defaultSdk }, 'PUT'); $('#sdkLibrary').outerHTML = sdkLibrary(); toast('新项目将默认使用此 SDK；已有项目保持原配置'); return; }
  if (button.dataset.action) return action(button.dataset.action);
  if (button.dataset.reveal) {
    const field = button.dataset.reveal, input = $(`#secret-${field}`);
    if (input.type === 'text') { input.type = 'password'; button.textContent = '显示'; return; }
    if (!input.value && project()?.hasSecrets[field]) input.value = (await api(`/api/projects/${state.selectedId}/reveal`, { field })).value;
    input.type = 'text'; button.textContent = '隐藏'; return;
  }
  if (button.dataset.copy) { await navigator.clipboard.writeText(button.dataset.copy); toast('指纹已复制'); return; }
  if (button.dataset.cancel) { await api(`/api/jobs/${button.dataset.cancel}/cancel`, {}); await refreshState(); return; }
  if (button.dataset.download) return downloadApk(button.dataset.download);
  if (button.dataset.revealJob) { const value = await api(`/api/jobs/${button.dataset.revealJob}/reveal`, {}); toast(`产物目录：${value.path}`); return; }
  if (button.dataset.job) {
    if (!canLeaveProject()) return;
    state.currentJobId = button.dataset.job; state.currentJob = await api(`/api/jobs/${state.currentJobId}`);
    if (state.currentJob.projectId) { state.selectedId = state.currentJob.projectId; state.view = 'project'; } else state.view = 'environment';
    render();
  }
}
document.addEventListener('click', event => { handleClick(event).catch(error => toast(error.message, true)); });
$('#main').addEventListener('input', event => {
  if (!event.target.closest('#projectForm')) return;
  markProjectDirty();
  const draft = sourceDraft();
  if (event.target.id === 'field-sourceDir') scheduleSourceRecognition();
  else if (draft && event.target.name) { draft.touched.add(event.target.name); if (sourceFields.includes(event.target.name)) renderSourceRecognition(); }
});
$('#main').addEventListener('submit', event => { event.preventDefault(); if (event.target.id === 'projectForm') saveProject().catch(error => toast(error.message, true)); });
$('#main').addEventListener('change', event => {
  if (event.target.id === 'field-sourceDir') { clearTimeout(sourceTimer); recognizeSource().catch(error => toast(error.message, true)); }
  if (event.target.id === 'acceptLicense') state.licenseAccepted = event.target.checked;
  if (event.target.id === 'projectSdk') {
    const sdk = state.sdks.items.find(s => s.id === event.target.value);
    $('#field-androidDir').readOnly = !!sdk;
    if (sdk) for (const [key, value] of Object.entries({ androidDir: sdk.androidDir, moduleName: sdk.moduleName, sdkVersion: sdk.version })) $(`[name="${key}"]`).value = value;
    state.dirty = true;
  }
});
$('#navigation').onclick = event => { const button = event.target.closest('[data-view]'); if (button?.dataset.view === 'environment') { openEnvironmentGuide().catch(e => toast(e.message, true)); return; } if (button && canLeaveProject()) { state.view = button.dataset.view; render(); } };
$('#projectList').onclick = event => { const button = event.target.closest('[data-project]'); if (!button) return; if (state.dirty && !confirm('当前表单尚未保存，是否离开？')) return; state.selectedId = button.dataset.project; localStorage.setItem('unipack.project', state.selectedId); state.view = 'project'; state.currentJobId = null; state.currentJob = null; state.dirty = false; render(); checkEnvironment().catch(error => toast(error.message, true)); };
$('#newProject').onclick = () => newProject().catch(error => toast(error.message, true));
$('#importAndroid').onclick = () => $('#importDialog').showModal();
$('#closeImport').onclick = () => $('#importDialog').close();
$('#confirmImport').onclick = async () => {
  try {
    const p = await api('/api/projects/import-android', { androidDir: $('#importAndroidDir').value, sourceDir: $('#importSourceDir').value });
    $('#importDialog').close(); state.projects.push(p); state.selectedId = p.id; state.view = 'project'; state.currentJobId = null; state.currentJob = null; render(); await checkEnvironment(); toast('已有工程已导入，Key 与签名信息独立保存');
  } catch (error) { toast(error.message, true); }
};
$('#helpButton').onclick = () => $('#helpDialog').showModal();
$('#closeHelp').onclick = () => $('#helpDialog').close();
$('#goEnvironment').onclick = () => { if (!canLeaveProject()) return; $('#helpDialog').close(); state.view = 'environment'; render(); };
$('#importProfileButton').onclick = () => $('#profileFile').click();
$('#profileFile').onchange = async event => {
  try { const file = event.target.files[0]; if (!file) return; if (file.size > 128000) throw new Error('项目配置文件过大'); const p = await api('/api/projects/import-profile', JSON.parse(await file.text())); $('#importDialog').close(); state.projects.push(p); state.selectedId = p.id; state.view = 'project'; render(); toast('配置已导入，请重新选择本机路径并填写 Key 与密码'); }
  catch (error) { toast(error.message, true); } finally { event.target.value = ''; }
};

const sourceDrafts = new Map();
let sourceTimer, sourceSequence = 0;
const sourceDraft = () => sourceDrafts.get(state.selectedId);
function markProjectDirty() {
  state.dirty = true;
  const save = document.querySelector('[data-action="save"]');
  if (save) save.textContent = '保存配置 · 有修改';
}
function sourceFormValues() {
  return Object.fromEntries([...sourceFields, 'name', 'frontendMode'].map(key => [key, $(`[name="${key}"]`)?.value || '']));
}
function matchingSourceDraft() {
  const d = sourceDraft();
  return d && d.sourceDir === $('#field-sourceDir')?.value.trim() ? d : null;
}
function renderSourceRecognition() {
  const area = $('#sourceRecognition'); if (!area) return;
  const d = matchingSourceDraft();
  for (const hint of document.querySelectorAll('[data-source-hint]')) hint.remove();
  if (!d) { area.innerHTML = '<p class="source-tip">选择源码目录后，自动回填能识别的应用身份；回填后仍可手动修改。</p>'; return; }
  if (d.status === 'idle') { area.innerHTML = '<p class="source-tip">源码目录已选择，点击“重新读取源码”识别应用身份。</p>'; return; }
  if (d.status === 'loading') { area.innerHTML = '<div class="source-status">◌ 正在读取源码中的应用配置…</div>'; return; }
  if (d.error) { area.innerHTML = `<div class="source-status source-warning">${esc(d.error)}<button type="button" class="text-button" data-action="inspect-source">重新读取</button></div>`; return; }
  if (!d.info) return;
  const current = sourceFormValues();
  const conflicts = sourceFields.filter(key => d.info[key] && d.info[key] !== current[key]);
  const missing = sourceFields.filter(key => !d.info[key]);
  area.innerHTML = `<div class="source-status"><div><strong>✓ 已读取源码配置</strong><p>已识别 ${sourceFields.filter(key => d.info[key]).length} 项，空白项已自动回填；可继续修改，保存后用于打包。</p></div><button type="button" class="text-button" data-action="inspect-source">重新读取 ↻</button></div>${missing.length ? `<p class="source-missing">源码未提供或无法静态识别：${missing.map(key => `${esc(sourceFieldNames[key])}${current[key] ? '（保留当前值）' : '（待填写）'}`).join('、')}。</p>` : ''}${conflicts.length ? `<div class="source-differences"><strong>以下字段与源码不同，已保留你的填写：</strong><div>${conflicts.map(key => `<p><span>${esc(sourceFieldNames[key])}</span><code>${esc(current[key] || '未填写')}</code><span>→</span><code>${esc(d.info[key])}</code></p>`).join('')}</div><button type="button" class="secondary small-button" data-action="use-source">使用以上源码值</button></div>` : ''}${d.info.warnings.length ? `<p class="source-missing">${d.info.warnings.map(w => esc(w)).join(' ')}</p>` : ''}`;
  for (const key of sourceFields) {
    const input = $(`[name="${key}"]`), origin = d.info.fieldSources[key];
    if (!input || !origin || input.value !== d.info[key]) continue;
    const hint = document.createElement('small'); hint.dataset.sourceHint = key; hint.className = 'source-origin';
    hint.textContent = `来自 ${origin.file}${origin.envFile && origin.envFile !== origin.file ? ` → ${origin.envFile}` : ''}`;
    input.closest('.field').append(hint);
  }
}
function scheduleSourceRecognition() {
  clearTimeout(sourceTimer);
  if (!$('#field-sourceDir')?.value.trim()) { sourceSequence++; renderSourceRecognition(); return; }
  sourceTimer = setTimeout(() => recognizeSource().catch(error => toast(error.message, true)), 650);
}
async function recognizeSource() {
  clearTimeout(sourceTimer);
  const form = $('#projectForm'), field = $('#field-sourceDir');
  if (!form || !field?.value.trim()) { renderSourceRecognition(); return; }
  const sourceDir = field.value.trim(), projectId = state.selectedId;
  const previous = sourceDraft(), snapshot = sourceFormValues();
  if (previous?.status === 'loading' && previous.sourceDir === sourceDir) return previous.completion;
  const sequence = ++sourceSequence;
  const draft = { sourceDir, status: 'loading', applied: { ...previous?.applied }, touched: new Set(previous?.touched), filled: [] };
  sourceDrafts.set(projectId, draft); renderSourceRecognition();
  draft.completion = api('/api/source/inspect', { sourceDir }).then(info => {
    if (sequence !== sourceSequence || projectId !== state.selectedId || form !== $('#projectForm') || field.value.trim() !== sourceDir) { draft.status = 'idle'; return; }
    if (!info.isUniApp) throw new Error('这个目录未找到 UniApp 配置，请选择包含 manifest.json / src/manifest.json 或 manifest.config.ts 的项目根目录。');
    draft.info = info; draft.status = 'ready';
    const plan = planSourceFill(sourceFormValues(), info, { previous: draft.applied, snapshot, touched: draft.touched });
    for (const [key, value] of Object.entries(plan.updates)) {
      const input = $(`[name="${key}"]`); if (!input) continue;
      input.value = value;
      if (value) draft.applied[key] = value; else delete draft.applied[key];
      draft.filled.push(key);
    }
    if (draft.filled.length) markProjectDirty();
    renderSourceRecognition();
  }).catch(error => {
    if (sequence !== sourceSequence || projectId !== state.selectedId || form !== $('#projectForm') || field.value.trim() !== sourceDir) { draft.status = 'idle'; return; }
    draft.status = 'failed'; draft.error = error.message; renderSourceRecognition();
  });
  return draft.completion;
}
function applyRecognizedSource() {
  const d = matchingSourceDraft(); if (!d?.info) return;
  const plan = planSourceFill(sourceFormValues(), d.info, { replace: true });
  for (const [key, value] of Object.entries(plan.updates)) {
    const input = $(`[name="${key}"]`); if (!input) continue;
    input.value = value; d.applied[key] = value; d.touched.delete(key);
    if (!d.filled.includes(key)) d.filled.push(key);
  }
  if (Object.keys(plan.updates).length) markProjectDirty();
  renderSourceRecognition(); toast('已使用源码中的应用身份，保存后生效');
}

const browser = { target: '', kind: 'directory', directory: '', items: [], selection: '' };
async function openBrowser(target, kind = 'directory') {
  browser.target = target; browser.kind = kind; browser.selection = '';
  const current = document.getElementById(target)?.value || state.system.home;
  $('#browserTitle').textContent = kind === 'certificate' ? '选择签名证书' : '选择本机文件夹';
  if (!$('#browserDialog').open) $('#browserDialog').showModal();
  let start = current;
  if (kind === 'certificate' && /\.(?:jks|p12|pfx|keystore)$/i.test(current)) start = current.replace(/[/\\][^/\\]+$/, '');
  await listDirectory(start);
}
async function listDirectory(directory) {
  const result = await api(`/api/browse?path=${encodeURIComponent(directory)}&kind=${browser.kind}`);
  Object.assign(browser, { directory: result.current, parent: result.parent, items: result.items, selection: browser.kind === 'directory' ? result.current : '' });
  $('#browserPath').value = result.current;
  $('#browserEntries').innerHTML = result.items.map((item, index) => `<button class="browser-entry" data-index="${index}"><span>${item.directory ? '▱' : '◇'}</span>${esc(item.name)}<small>${item.directory ? '打开 ›' : '证书'}</small></button>`).join('') || '<div class="empty-table">这个目录没有可选择的文件。</div>';
  $('#browserSelection').textContent = browser.selection || '请选择证书文件';
  $('#choosePath').textContent = browser.kind === 'directory' ? '选择此文件夹' : '选择此证书';
  $('#choosePath').disabled = !browser.selection;
}
$('#browserEntries').onclick = event => {
  const button = event.target.closest('[data-index]'); if (!button) return;
  const item = browser.items[Number(button.dataset.index)];
  if (item.directory) listDirectory(item.path).catch(error => toast(error.message, true));
  else { browser.selection = item.path; $('#browserSelection').textContent = item.path; $('#choosePath').disabled = false; document.querySelectorAll('.browser-entry').forEach(e => e.classList.toggle('selected', e === button)); }
};
$('#browserPathForm').onsubmit = event => { event.preventDefault(); listDirectory($('#browserPath').value).catch(error => toast(error.message, true)); };
$('#parentDirectory').onclick = () => listDirectory(browser.parent).catch(error => toast(error.message, true));
$('#closeBrowser').onclick = () => $('#browserDialog').close();
$('#choosePath').onclick = () => { const input = document.getElementById(browser.target); if (input && browser.selection) { input.value = browser.selection; input.dispatchEvent(new Event('input', { bubbles: true })); $('#browserDialog').close(); if (input.id === 'field-sourceDir') input.dispatchEvent(new Event('change', { bubbles: true })); } };

async function boot() {
  const response = await fetch('/api/session'); token = (await response.json()).token;
  await refreshState(true); await checkEnvironment();
  setInterval(async () => { if (state.polling) return; state.polling = true; try { await refreshState(); } catch { /* preserve unsaved inputs if connection is interrupted */ } finally { state.polling = false; } }, 2000);
}
boot().catch(error => { $('#main').innerHTML = `<div class="loading">无法连接本机服务：${esc(error.message)}<p>请确认 Node 服务已启动，然后刷新页面。</p></div>`; });
