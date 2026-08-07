# TapCollect

一个基于 Electron、Vue 3 和 TypeScript 的本地桌面工具，用于把公开静态网页中的列表/详情信息按用户提供的 XML 模板分批导出。

## 已实现功能

- 多任务新增、复制、编辑、删除和单任务运行。
- 五步配置向导：入口、列表与分页、详情、XML 映射、输出与测试。
- 隔离网页预览，支持悬停、点选生成 CSS、匹配高亮和数量验证。
- 手动 CSS 与 XPath 1.0 选择器。
- 多行列表 URL：固定地址按顺序各采一次，并可混合一条 `{page}` 数字模板；支持正负步长和模板最大页数保护。
- 可选列表 → 详情采集；按完整 `URL.hostname` 判断站内/站外。
- 站外详情不发起请求，可映射到专用“外链 URL”来源。
- XML 模板树、记录节点选择、逐字段显式映射、CDATA 和模板编码保留。
- 文本、`innerHTML`、属性、固定值、系统值、保留示例值和输出为空。
- 正文 HTML 清理、资源绝对化、有序字面路径替换；附件链接保留在正文中，`DocView.aspx` 预览 iframe 删除。
- 每个 XML 1–200 条（默认 200），临时文件 + 原子重命名，默认覆盖或时间戳命名。
- 详情并发 1–5，输出仍保持列表顺序。
- CSV 错误日志、JSON/NDJSON 检查点、暂停/继续/取消和异常恢复。

## 开发运行

环境建议：Node.js 22+、npm 10+。

```powershell
npm install
npm run dev
```

如果在中国网络环境中 Electron 二进制未自动下载，可执行：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

## 使用流程

1. 新建任务，填写任务名称，并在多行框中按顺序填写固定列表 URL 和可选的 `{page}` 模板。
2. 选择列表项容器；存在模板时配置起始值、非零正负步长和模板最大页数。
3. 选择是否进入详情；启用时配置相对于列表项的详情链接。
4. 导入完整 XML 模板，选择单条示例记录节点，再明确处理每个字段。
5. 配置资源路径替换、输出目录、批次与请求参数，先测试前 3 条，再正式运行。

任务名称决定最终目录：

```text
输出根目录/任务名称/
```

覆盖开启时：

```text
任务名称_001.xml
任务名称_002.xml
任务名称_错误日志.csv
```

覆盖关闭时，文件名包含 `YYYYMMDD_HHmmss` 时间戳。

## 本地数据

配置保存在 Electron 的 `userData/collector-data` 目录中：

```text
collector-data/
├── settings.json
├── tasks/<task-id>/task.json
├── checkpoints/<task-id>/checkpoint.json
├── checkpoints/<task-id>/pending.ndjson
└── manifests/<task-id>.json
```

Windows 通常位于 `%APPDATA%/TapCollect/collector-data`，Linux/UOS 通常位于 `~/.config/TapCollect/collector-data`，macOS 通常位于 `~/Library/Application Support/TapCollect/collector-data`。实际位置由 Electron `app.getPath('userData')` 决定。

删除任务只删除本地任务配置和检查点，不删除已经输出的 XML。

## 检查与本地验收

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

自动化测试只使用本地 HTML 和 `example.com` 占位地址，不访问真实采集站点。

如需对自己已经配置好的真实任务执行一次单页冒烟验证，请把本地 `task.json` 路径作为参数传入。脚本会把输出改到临时目录，不会修改原任务文件：

```powershell
npm run smoke:sample -- "$env:APPDATA\TapCollect\collector-data\tasks\<task-id>\task.json"
```

也可以设置 `TAPCOLLECT_SMOKE_TASK` 环境变量。真实 URL、选择器、XML 模板和本地任务配置均不提交到仓库。

## 打包

Windows x64 NSIS：

```powershell
npm run build:win
```

若安装器依赖下载较慢，可在当前 PowerShell 会话设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run build:win
```

UOS ARM64 DEB：

```bash
npm ci
npm run build:uos-arm64
```

UOS ARM64 建议在对应 ARM64 系统或 ARM64 CI runner 上构建。项目已配置 `electron-builder` 的 `linux/deb/arm64` 目标，但当前 Windows 开发环境没有完成 UOS ARM64 实机安装验证，因此不宣称已经验证安装兼容性。

macOS Intel 与 Apple Silicon：

```bash
npm ci
npm run build:mac:x64
npm run build:mac:arm64
```

macOS 打包必须在 macOS 上执行。当前配置为两种架构分别生成 DMG 与 ZIP，未使用 Apple Developer 证书签名或公证，因此首次打开时可能出现 Gatekeeper 的未认证开发者提示。

## GitHub Actions

- `CI`：推送到 `main` 或创建 Pull Request 时运行 lint、TypeScript 检查、测试和生产构建。
- `Package installers`：推送到 `main`、推送 `v*` 标签或手动触发时，分别生成 Windows x64、UOS/Linux ARM64、macOS Intel 与 macOS Apple Silicon 产物。
- 普通 `main` 推送和手动运行的安装包可在对应 Actions 运行页面的 **Artifacts** 区域临时下载，默认保留 14 天。
- 推送 `v*` 标签时，必须等待所有平台打包成功，然后自动创建或更新 GitHub Release，并附加 Windows `.exe`、UOS ARM64 `.deb`、macOS x64/ARM64 `.dmg` 与 `.zip`。正式版本请从 [Releases](https://github.com/CastleInTheSky0/TapCollect/releases) 下载。

发布新版本时，先确保 `package.json` 的版本号与标签一致，再推送版本标签，例如：

```powershell
git tag -a v0.1.0 -m "TapCollect v0.1.0"
git push origin v0.1.0
```

仓库的 `.gitignore` 已排除本地任务、检查点、运行清单、采集输出、导入模板、界面测试截图及开发工具状态目录。提交前仍建议执行 `git status --short`，确认清单中没有本地采集数据。

## 首版限制

- 只支持公开可访问、HTTP GET 返回数据的静态 HTML。
- 不支持 JavaScript 动态数据、登录、验证码、POST、代理或登录态维护。
- 不下载图片、附件和媒体文件，只改写 XML 内容中的资源路径。
- 同一任务最多支持一条 `{page}` 数字模板，不支持“下一页”点选、游标、多个分页变量或多条分页模板。
- 不支持正则、用户脚本、复杂日期转换、记录内动态重复 XML 子结构或 XSD/业务 DTD 校验。
- 不支持定时任务、多任务并行、托盘后台、自动更新和任务配置跨机器导入/导出。

远程预览启用沙箱、关闭 Node 集成、拒绝权限请求和新窗口；正式采集始终重新请求并解析原始静态 HTML，不依赖预览页面执行后的 DOM。
