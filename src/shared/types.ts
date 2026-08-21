export type SelectorType = 'css' | 'xpath'
export type PaginationMode = 'url' | 'click'
export type DetailNavigationMode = 'link' | 'click'
export type PageSource = 'list' | 'detail'
export type ExtractionType = 'text' | 'html' | 'attribute'
export type MappingMode =
  | 'unconfigured'
  | 'page'
  | 'fixed'
  | 'system'
  | 'merge'
  | 'preserve'
  | 'empty'
  | 'external-url'
export type MergeValueMode = 'page' | 'fixed' | 'system' | 'external-url'
export type SystemValue = 'list-url' | 'detail-url' | 'collected-at'
export type MatchMode = 'first' | 'all'
export type XmlNodeKind = 'element' | 'attribute'
export type OutputFormat = 'xml' | 'spreadsheet'
export type SpreadsheetFormat = 'xlsx' | 'xls'
export type ResourceAddressMode = 'absolute-replace' | 'prefix'
export type ResourceKind = 'image' | 'audio' | 'video' | 'attachment' | 'other'
export type RunStatus =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
export type RunStage =
  | 'preparing'
  | 'list'
  | 'detail'
  | 'resource'
  | 'writing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface HeaderEntry {
  id: string
  key: string
  value: string
}

export interface ReplacementRule {
  id: string
  from: string
  to: string
}

export interface FieldReplacementRule {
  id: string
  from: string
  to: string
}

export interface SelectorConfig {
  selectorType: SelectorType
  selector: string
}

export interface DetailConfig {
  enabled: boolean
  navigationMode: DetailNavigationMode
  link: SelectorConfig
  linkAttribute: string
}

export interface PaginationConfig {
  mode: PaginationMode
  urlTemplate: string
  startPage: number
  step: number
  maxPages: number
  nextButton: SelectorConfig
}

export interface RequestConfig {
  userAgent: string
  headers: HeaderEntry[]
  timeoutSeconds: number
  delayMs: number
  detailConcurrency: number
  manualEncoding: '' | 'utf-8' | 'gbk' | 'gb2312' | 'gb18030'
}

export interface HtmlProcessingConfig {
  cleanHtml: boolean
  absolutizeResources: boolean
  customResourceAttributes: string[]
}

export interface ResourceDownloadConfig {
  enabled: boolean
  rootDirectory: string
  urlPrefix: string
}

export interface ResourceConfig {
  addressMode: ResourceAddressMode
  urlPrefix: string
  download: ResourceDownloadConfig
}

export interface OutputConfig {
  format: OutputFormat
  rootDirectory: string
  recordsPerFile: number
  overwrite: boolean
}

export interface OutputFieldDefinition {
  path: string
  name: string
  sampleValue: string
  cdata?: boolean
}

export interface XmlFieldDefinition extends OutputFieldDefinition {
  kind: XmlNodeKind
  cdata: boolean
  label?: string
}

export interface SpreadsheetFieldDefinition extends OutputFieldDefinition {
  column: string
  columnIndex: number
}

export interface PageExtractionConfig {
  pageSource: PageSource
  selectorType: SelectorType
  selector: string
  extraction: ExtractionType
  attribute: string
  matchMode: MatchMode
  separator: string
  trim: boolean
  collapseWhitespace: boolean
  contentFilterSelectors: string[]
  replacements: FieldReplacementRule[]
  convertToTimestamp: boolean
}

export interface MergeValueConfig extends PageExtractionConfig {
  id: string
  mode: MergeValueMode
  fixedValue: string
  systemValue: SystemValue
}

export interface FieldMapping extends PageExtractionConfig {
  fieldPath: string
  mode: MappingMode
  required: boolean
  fixedValue: string
  systemValue: SystemValue
  mergeSeparator: string
  mergeValues: MergeValueConfig[]
}

export interface XmlTemplateConfig {
  fileName: string
  content: string
  encoding: string
  recordPath: string
  fields: XmlFieldDefinition[]
  mappings: FieldMapping[]
  importedAt: string
}

export interface SpreadsheetTemplateConfig {
  fileName: string
  contentBase64: string
  format: SpreadsheetFormat
  sheetName: string
  fields: SpreadsheetFieldDefinition[]
  mappings: FieldMapping[]
  importedAt: string
}

export interface TaskConfig {
  version: 1
  id: string
  name: string
  listUrl: string
  listPageRules: string[]
  listItem: SelectorConfig
  detail: DetailConfig
  pagination: PaginationConfig
  request: RequestConfig
  html: HtmlProcessingConfig
  resources: ResourceConfig
  resourceReplacements: ReplacementRule[]
  output: OutputConfig
  xml: XmlTemplateConfig | null
  spreadsheet: SpreadsheetTemplateConfig | null
  dedupeFieldPath: string
  createdAt: string
  updatedAt: string
}

export interface TaskSummary {
  id: string
  name: string
  listUrl: string
  updatedAt: string
  runnable: boolean
  hasCheckpoint: boolean
}

export interface TaskConfigBundle {
  format: 'tapcollect-task-bundle'
  version: 1
  exportedAt: string
  tasks: TaskConfig[]
}

export interface TaskConfigImportSuccess {
  sourceIndex: number
  id: string
  name: string
}

export interface TaskConfigImportFailure {
  sourceIndex: number
  name: string
  reason: string
}

export interface TaskConfigImportResult {
  cancelled: boolean
  imported: TaskConfigImportSuccess[]
  skipped: TaskConfigImportFailure[]
}

export interface TaskConfigExportResult {
  cancelled: boolean
  taskCount: number
  filePath: string
}

export interface XmlTreeNode {
  path: string
  name: string
  kind: XmlNodeKind
  children: XmlTreeNode[]
}

export interface XmlImportResult {
  cancelled: boolean
  template: XmlTemplateConfig | null
  tree: XmlTreeNode[]
}

export interface SpreadsheetImportResult {
  cancelled: boolean
  template: SpreadsheetTemplateConfig | null
}

export interface PaginationParameter {
  name: string
  value: string
  template: string
}

export interface ExtractedRecord {
  sequence: number
  collectedAt: string
  page: number
  itemIndex: number
  listUrl: string
  detailUrl: string
  externalUrl: string
  values: Record<string, string>
  resources?: ResourcePlan[]
}

export interface ResourcePlan {
  normalizedUrl: string
  sourceUrl: string
  relativePath: string
  localPath: string
  xmlUrl: string
  kind: ResourceKind
}

export interface RecordFailure {
  page: number
  itemIndex: number
  listUrl: string
  detailUrl: string
  stage: string
  fieldPath: string
  reason: string
  retries: number
  time: string
}

export interface TestCollectionResult {
  records: ExtractedRecord[]
  rows: Record<string, string>[]
  matchCounts: Record<string, number[]>
  failures: RecordFailure[]
  listItemCount: number
  xmlPreview: string
  resourcePlans: ResourcePlan[]
  messages: string[]
}

export interface RunCounters {
  discovered: number
  succeeded: number
  duplicated: number
  skipped: number
  failed: number
}

export interface ResourceCounters {
  downloaded: number
  skipped: number
  failed: number
}

export interface RunProgress {
  runId: string
  taskId: string
  status: RunStatus
  stage: RunStage
  page: number
  maxPages: number
  currentUrl: string
  currentFile: string
  recordsInCurrentFile: number
  counters: RunCounters
  resources: ResourceCounters
  message: string
}

export interface RunLog {
  runId: string
  taskId: string
  level: 'info' | 'warning' | 'error' | 'success'
  time: string
  message: string
}

export interface RunResult {
  runId: string
  taskId: string
  status: Extract<RunStatus, 'completed' | 'cancelled' | 'failed'>
  startedAt: string
  finishedAt: string
  pagesVisited: number
  outputFiles: string[]
  errorLogPath: string
  counters: RunCounters
  resources: ResourceCounters
  message: string
}

export type RunSessionStatus = Exclude<RunStatus, 'idle'>
export type RunQueueReason = '' | 'capacity' | 'output-lock'

export interface RunSessionItem {
  taskId: string
  taskName: string
  runId: string
  status: RunSessionStatus
  resume: boolean
  queuePosition: number
  queueReason: RunQueueReason
  queuedAt: string
  startedAt: string
  pausedAt: string
  finishedAt: string
  message: string
  progress: RunProgress | null
  result: RunResult | null
  logs: RunLog[]
}

export interface RunSessionSnapshot {
  maxConcurrentRuns: number
  activeCount: number
  queuedCount: number
  testingTaskId: string
  items: RunSessionItem[]
}

export interface StartRunResult {
  accepted: boolean
  taskId: string
  runId: string
  status: Extract<RunSessionStatus, 'queued' | 'preparing' | 'running'>
  queuePosition: number
  message: string
}

export interface RunCheckpoint {
  version: 1
  taskId: string
  runId: string
  startedAt: string
  runStamp: string
  nextRuleIndex: number
  nextPage: number
  templatePagesVisited: number
  nextSequence: number
  nextFileIndex: number
  pagesVisited: number
  seenPageUrls: string[]
  seenKeys: string[]
  pendingRecords: ExtractedRecord[]
  outputFiles: string[]
  errorLogPath: string
  counters: RunCounters
  resources: ResourceCounters
  processedResourceUrls: string[]
}

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewPickRequest {
  selectorType: SelectorType
  scopeSelector: string
  ancestorAttribute: string
}

export interface PreviewPickResult {
  cancelled: boolean
  selector: string
  selectorType: SelectorType
  matchCount: number
  sample: string
}

export interface PreviewEvaluateRequest {
  selectorType: SelectorType
  selector: string
  scopeSelector: string
  ancestorAttribute: string
}

export interface PreviewEvaluateResult {
  matchCount: number
  sample: string
  error: string
}

export interface AppSettings {
  defaultOutputDirectory: string
  maxConcurrentRuns: number
}

export type AppPlatform = 'windows' | 'macos' | 'linux' | 'unsupported'

export interface AppRuntimeInfo {
  appName: string
  version: string
  platform: AppPlatform
  platformLabel: string
  architecture: string
  architectureLabel: string
  developmentPreview: boolean
  updateInstallSupported: boolean
}

export interface UpdateAsset {
  id: number
  name: string
  size: number
  digest: string
}

export interface UpdateRelease {
  id: number
  version: string
  tagName: string
  title: string
  summary: string
  hasSummary: boolean
  summaryTruncated: boolean
  releaseUrl: string
  publishedAt: string
  asset: UpdateAsset | null
}

export type UpdateCheckStatus = 'up-to-date' | 'available' | 'unsupported'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  checkedAt: string
  currentVersion: string
  release: UpdateRelease
  message: string
}

export interface UpdateDownloadProgress {
  assetId: number
  fileName: string
  receivedBytes: number
  totalBytes: number
  percentage: number
}

export interface DownloadedUpdate {
  downloadId: string
  releaseVersion: string
  fileName: string
  size: number
  digestVerified: boolean
}

export interface UpdateInstallResult {
  started: boolean
  cancelled: boolean
  message: string
}

export interface CollectorApi {
  getAppRuntimeInfo: () => Promise<AppRuntimeInfo>
  checkForUpdates: () => Promise<UpdateCheckResult>
  downloadUpdate: () => Promise<DownloadedUpdate>
  installUpdate: (downloadId: string) => Promise<UpdateInstallResult>
  openUpdateRelease: () => Promise<boolean>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  listTasks: () => Promise<TaskSummary[]>
  loadTask: (id: string) => Promise<TaskConfig | null>
  saveTask: (task: TaskConfig) => Promise<TaskConfig>
  duplicateTask: (id: string) => Promise<TaskConfig>
  deleteTask: (id: string) => Promise<boolean>
  importTaskConfigs: () => Promise<TaskConfigImportResult>
  exportTaskConfigs: () => Promise<TaskConfigExportResult>
  chooseOutputDirectory: () => Promise<string>
  chooseResourceDirectory: () => Promise<string>
  importXmlTemplate: () => Promise<XmlImportResult>
  importSpreadsheetTemplate: () => Promise<SpreadsheetImportResult>
  inspectXmlTemplate: (content: string) => Promise<XmlTreeNode[]>
  selectXmlRecord: (
    content: string,
    fileName: string,
    recordPath: string
  ) => Promise<XmlTemplateConfig>
  detectPaginationParameters: (url: string) => Promise<PaginationParameter[]>
  getDetailSamples: (task: TaskConfig) => Promise<string[]>
  testTask: (task: TaskConfig) => Promise<TestCollectionResult>
  getCheckpoint: (taskId: string) => Promise<RunCheckpoint | null>
  getRunSession: () => Promise<RunSessionSnapshot>
  startRun: (taskId: string, resume: boolean) => Promise<StartRunResult>
  pauseRun: (taskId: string) => Promise<boolean>
  resumeRun: (taskId: string) => Promise<boolean>
  cancelRun: (taskId: string) => Promise<boolean>
  pauseAllRuns: () => Promise<boolean>
  resumeAllRuns: () => Promise<boolean>
  cancelAllRuns: () => Promise<boolean>
  openOutputDirectory: (taskId: string) => Promise<boolean>
  openErrorLog: (taskId: string, path: string) => Promise<boolean>
  previewOpen: (url: string, bounds: PreviewBounds) => Promise<boolean>
  previewNavigate: (url: string) => Promise<boolean>
  previewSetBounds: (bounds: PreviewBounds) => Promise<boolean>
  previewClose: () => Promise<boolean>
  previewPick: (request: PreviewPickRequest) => Promise<PreviewPickResult>
  previewEvaluate: (request: PreviewEvaluateRequest) => Promise<PreviewEvaluateResult>
  onRunProgress: (listener: (progress: RunProgress) => void) => () => void
  onRunLog: (listener: (log: RunLog) => void) => () => void
  onRunFinished: (listener: (result: RunResult) => void) => () => void
  onRunSession: (listener: (snapshot: RunSessionSnapshot) => void) => () => void
  onUpdateDownloadProgress: (
    listener: (progress: UpdateDownloadProgress) => void
  ) => () => void
}
