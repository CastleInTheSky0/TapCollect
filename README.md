# TapCollect

一个基于 Electron、Vue 3 和 TypeScript 的本地桌面工具，用于把公开网页中的列表/详情信息按用户提供的 XML 或 Excel 模板分批导出。

## 已实现功能

- 多任务新增、复制、编辑、删除和并发运行；正式任务并发数可设置为 1–5，默认 3。
- 五步配置向导：入口、列表与分页、详情、模板映射、输出与测试。
- 隔离网页预览，支持悬停、点选生成 CSS、匹配高亮和数量验证。
- 手动 CSS 与 XPath 1.0 选择器。
- 多行列表 URL：固定地址按顺序各采一次，并可混合一条 `{page}` 数字模板；支持正负步长和模板最大页数保护。
- 可选“点击下一页（动态渲染）”：点选下一页按钮后读取网站最终渲染的 DOM，不依赖接口返回 HTML 还是 JSON。
- 可选列表 → 详情采集；按完整 `URL.hostname` 判断站内/站外。
- 站外详情不发起请求，可映射到专用“外链 URL”来源。
- XML 模板树、记录节点选择、逐字段显式映射、CDATA 和模板编码保留。
- XLSX/XLS 表格模板导入：使用首个工作表的第一行作为列名，第二行起写入记录；重复列名按列字母分别映射。
- 文本、`innerHTML`、属性、固定值、系统值、保留示例值和输出为空。
- 正文 HTML 清理、资源绝对化、有序字面路径替换，或使用“自定义前缀 + 原路径”直接改写站内资源地址。
- 可选下载最终输出实际引用的站内图片、音视频和常见附件；按 URL 路径建立本地目录，站外资源保持原地址。
- 每个输出文件 1–200 条（默认 200），临时文件 + 原子重命名，默认覆盖或时间戳命名。
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
4. 选择 XML 或 Excel 表格：XML 选择单条示例记录节点；表格使用首个工作表的第一行列名；再明确处理每个字段。
5. 配置资源地址处理方式；如需下载资源，选择资源目录并填写输出访问前缀，再配置输出目录、批次与请求参数。
6. 先测试前 3 条，确认字段值和资源计划；测试不会下载文件，正式运行才会写入资源。

任务名称决定最终目录：

```text
输出根目录/任务名称/
```

覆盖开启时：

```text
# XML 模板
任务名称_001.xml
任务名称_002.xml

# XLSX 模板（XLS 模板对应生成 .xls）
任务名称_001.xlsx
任务名称_002.xlsx

任务名称_错误日志.csv
```

覆盖关闭时，文件名包含 `YYYYMMDD_HHmmss` 时间戳。

开启资源下载时，本地目录不包含 hostname，只镜像资源 URL 的路径。例如：

```text
原地址：https://www.example.com/upload/2026/a.jpg
本地：资源根目录/upload/2026/a.jpg
写入地址：/resources/upload/2026/a.jpg
```

同一路径带不同查询参数时会在文件名中加入稳定短标识。资源下载失败会写入运行日志和 CSV 错误日志，但对应输出记录仍会保留预期的前缀地址。

## 本地数据

配置优先保存在应用同级的 `data` 目录中。开发预览使用项目根目录的 `data`；打包后的 Windows 和 Linux/UOS 应用使用可执行程序同级的 `data`；macOS 使用 `.app` 同级的 `data`：

```text
data/
├── settings.json
├── tasks/<task-id>/task.json
├── checkpoints/<task-id>/checkpoint.json
├── checkpoints/<task-id>/pending.ndjson
└── manifests/<task-id>.json
```

首次启动新版本时，如果 `data` 为空且旧的 Electron `userData/collector-data` 中存在任务，会自动复制旧设置、任务、检查点和运行清单；旧目录会保留，不自动删除。安装目录不可写时会回退到旧系统目录并在主进程日志中记录原因。

删除任务只删除本地任务配置和检查点，不删除已经输出的 XML 或表格文件。

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
npm run smoke:sample -- ".\data\tasks\<task-id>\task.json"
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
git tag -a v0.2.1 -m "TapCollect v0.2.1"
git push origin v0.2.1
```

仓库的 `.gitignore` 已排除本地任务、检查点、运行清单、采集输出、导入模板、界面测试截图及开发工具状态目录。提交前仍建议执行 `git status --short`，确认清单中没有本地采集数据。

## 首版限制

- 默认采集公开可访问、HTTP GET 返回的静态 HTML；动态模式仅支持点击一个下一页按钮并读取渲染后的普通 DOM。
- 不支持登录、验证码、代理、登录态维护、无限滚动、加载更多追加或多步骤页面动作。
- 资源下载只处理最终输出引用且与所属页面 hostname 完全相同的 HTTP/HTTPS 地址；不下载外部 CDN、`data:`/`blob:` 资源，也不探测无扩展名动态附件接口。
- 不提供转码、缩略图、字节级断点续传、失败重试管理或旧资源自动清理。
- 同一静态任务最多支持一条 `{page}` 数字模板；动态点击模式只能配置一个初始 URL，不能与 URL 队列或数字模板混用。
- 不支持直接映射接口原始 JSON、JSONPath、GraphQL 字段、POST 请求体或用户自定义响应脚本。
- 不支持正则、用户脚本、复杂日期转换、记录内动态重复 XML 子结构或 XSD/业务 DTD 校验。
- 表格模式不支持任意单元格占位符、跨工作表映射、宏、图表、数据透视表或复杂样式无损往返。
- 不支持定时任务、托盘后台、自动更新和任务配置跨机器导入/导出。

远程预览和动态分页网页实例均启用沙箱、关闭 Node 集成、拒绝权限请求和新窗口。静态任务重新请求并解析原始 HTML；只有明确选择动态模式时才创建独立隔离网页实例执行下一页点击。
