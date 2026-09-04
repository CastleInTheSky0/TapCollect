import { JSDOM } from 'jsdom'
import { isValidResourceUrlPrefix } from '@shared/resource-config'
import type {
  HtmlProcessingConfig,
  ReplacementRule,
  ResourcePlan,
  TaskConfig
} from '@shared/types'
import { applyReplacementRules, hasSameHostname, resolveHttpUrl } from './url-utils'
import {
  classifyResourceReference,
  createResourcePlan,
  formatResourceReferenceUrl,
  rewriteInternalResourceWithPrefix,
  type ResourceReferenceContext
} from './resource-planner'

const DEFAULT_RESOURCE_ATTRIBUTES = ['src', 'data-src', 'data-original', 'href']
const OTHER_URL_ATTRIBUTES = ['action', 'formaction', 'poster', 'xlink:href']
const URL_VALUE_ATTRIBUTES = new Set([...DEFAULT_RESOURCE_ATTRIBUTES, ...OTHER_URL_ATTRIBUTES])
const EXECUTABLE_URL_PROTOCOL = /^(?:javascript|vbscript):/i

const removeControlWhitespace = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f) ? '' : character
  }).join('')

const hasExecutableUrlProtocol = (value: string): boolean =>
  EXECUTABLE_URL_PROTOCOL.test(removeControlWhitespace(value))

const elementReferenceContext = (
  element: Element | null,
  attributeName: string,
  customAttributes: Set<string>,
  styleUrl = false
): ResourceReferenceContext => ({
  tagName: element?.tagName ?? '',
  parentTagName: element?.parentElement?.tagName ?? '',
  attributeName,
  hasDownloadAttribute: element?.hasAttribute('download') ?? false,
  customAttribute: customAttributes.has(attributeName.toLowerCase()),
  styleUrl
})

const rewriteSrcset = (
  value: string,
  element: Element,
  baseUrl: string,
  shouldAbsolutize: boolean,
  encodeUrls: boolean
): string =>
  value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/)
      const source = parts.shift() ?? ''
      const absolute = resolveHttpUrl(source, baseUrl)
      if (!absolute) return [source, ...parts].join(' ')
      const output = shouldAbsolutize ? absolute : source
      const kind = classifyResourceReference(
        absolute,
        elementReferenceContext(element, 'srcset', new Set())
      )
      return [kind ? formatResourceReferenceUrl(output, encodeUrls) : output, ...parts].join(' ')
    })
    .join(', ')

const rewriteStyleUrls = (
  value: string,
  baseUrl: string,
  shouldAbsolutize: boolean,
  encodeUrls: boolean
): string =>
  value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote: string, source: string) => {
    const absolute = resolveHttpUrl(source, baseUrl)
    if (!absolute) return match
    const output = shouldAbsolutize ? absolute : source
    return `url(${quote}${formatResourceReferenceUrl(output, encodeUrls)}${quote})`
  })

const removeComments = (document: Document): void => {
  const walker = document.createTreeWalker(document.body, document.defaultView!.NodeFilter.SHOW_COMMENT)
  const comments: Comment[] = []
  while (walker.nextNode()) comments.push(walker.currentNode as Comment)
  comments.forEach((comment) => comment.remove())
}

const shouldRemoveAttachmentPreview = (element: Element): boolean => {
  if (element.tagName.toLowerCase() !== 'iframe') return false
  return (element.getAttribute('src') ?? '').toLowerCase().includes('docview.aspx')
}

interface HtmlDocumentContext {
  document: Document
  attributes: Set<string>
}

export interface ProcessedResourceValue {
  value: string
  resources: ResourcePlan[]
}

const createHtmlDocument = (
  html: string,
  baseUrl: string,
  config: HtmlProcessingConfig
): HtmlDocumentContext => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: baseUrl })
  const { document } = dom.window
  const attributes = new Set(
    [...DEFAULT_RESOURCE_ATTRIBUTES, ...config.customResourceAttributes]
      .map((attribute) => attribute.trim())
      .filter(Boolean)
  )
  const sanitizedUrlAttributes = new Set(
    [...attributes, ...OTHER_URL_ATTRIBUTES].map((attribute) => attribute.toLowerCase())
  )

  if (config.cleanHtml) {
    document.querySelectorAll('script,noscript').forEach((element) => element.remove())
    document.querySelectorAll('iframe').forEach((element) => {
      if (shouldRemoveAttachmentPreview(element)) element.remove()
    })
    removeComments(document)
    document.body.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        const attributeName = attribute.name.toLowerCase()
        if (
          /^on/i.test(attribute.name) ||
          attributeName === 'srcdoc' ||
          (sanitizedUrlAttributes.has(attributeName) &&
            hasExecutableUrlProtocol(attribute.value))
        ) {
          element.removeAttribute(attribute.name)
        }
      }
    })
  }

  return { document, attributes }
}

export const processHtml = (
  html: string,
  baseUrl: string,
  config: HtmlProcessingConfig,
  replacements: ReplacementRule[],
  encodeUrls = true
): string => {
  const { document, attributes } = createHtmlDocument(html, baseUrl, config)
  const customAttributes = new Set(
    config.customResourceAttributes.map((attribute) => attribute.trim().toLowerCase()).filter(Boolean)
  )

  document.body.querySelectorAll('*').forEach((element) => {
    for (const attribute of attributes) {
      const current = element.getAttribute(attribute)
      if (!current) continue
      const absolute = resolveHttpUrl(current, baseUrl)
      if (!absolute) continue
      const output = config.absolutizeResources ? absolute : current
      const kind = classifyResourceReference(
        absolute,
        elementReferenceContext(element, attribute, customAttributes)
      )
      element.setAttribute(
        attribute,
        kind ? formatResourceReferenceUrl(output, encodeUrls) : output
      )
    }
    const srcset = element.getAttribute('srcset')
    if (srcset) {
      element.setAttribute(
        'srcset',
        rewriteSrcset(srcset, element, baseUrl, config.absolutizeResources, encodeUrls)
      )
    }
    const style = element.getAttribute('style')
    if (style) {
      element.setAttribute(
        'style',
        rewriteStyleUrls(style, baseUrl, config.absolutizeResources, encodeUrls)
      )
    }
  })

  return applyReplacementRules(document.body.innerHTML, replacements)
}

export const processAttributeValue = (
  value: string,
  baseUrl: string,
  shouldAbsolutize: boolean,
  replacements: ReplacementRule[]
): string => {
  if (hasExecutableUrlProtocol(value)) return ''
  const absolute = shouldAbsolutize ? resolveHttpUrl(value, baseUrl) || value : value
  return applyReplacementRules(absolute, replacements)
}

const assertResourceConfiguration = (task: TaskConfig): void => {
  if (task.resources.download.enabled) {
    if (!task.resources.download.rootDirectory.trim()) {
      throw new Error('请先选择资源存放根目录')
    }
    if (!isValidResourceUrlPrefix(task.resources.download.urlPrefix)) {
      throw new Error('请填写有效的资源下载访问前缀')
    }
    return
  }
  if (
    task.resources.addressMode === 'prefix' &&
    !isValidResourceUrlPrefix(task.resources.urlPrefix)
  ) {
    throw new Error('请填写有效的资源地址前缀')
  }
}

const processResourceReference = (
  sourceValue: string,
  element: Element | null,
  attributeName: string,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig,
  customAttributes: Set<string>,
  styleUrl = false
): ProcessedResourceValue => {
  if (hasExecutableUrlProtocol(sourceValue)) return { value: '', resources: [] }
  if (styleUrl && sourceValue.trim().startsWith('#')) {
    return { value: sourceValue, resources: [] }
  }
  const absoluteUrl = resolveHttpUrl(sourceValue, resolutionBaseUrl)
  if (!absoluteUrl) return { value: sourceValue, resources: [] }
  const kind = classifyResourceReference(
    absoluteUrl,
    elementReferenceContext(element, attributeName, customAttributes, styleUrl)
  )

  if (!task.resources.download.enabled && task.resources.addressMode === 'absolute-replace') {
    const output = task.html.absolutizeResources ? absoluteUrl : sourceValue
    return {
      value: applyReplacementRules(
        kind ? formatResourceReferenceUrl(output, task.resources.encodeUrls) : output,
        task.resourceReplacements
      ),
      resources: []
    }
  }

  if (!kind) {
    const value = task.html.absolutizeResources ? absoluteUrl : sourceValue
    return {
      value: task.resources.download.enabled
        ? applyReplacementRules(value, task.resourceReplacements)
        : value,
      resources: []
    }
  }

  if (!hasSameHostname(ownerPageUrl, absoluteUrl)) {
    return { value: sourceValue, resources: [] }
  }

  if (task.resources.download.enabled) {
    const plan = createResourcePlan(
      sourceValue,
      resolutionBaseUrl,
      ownerPageUrl,
      task.resources.download.rootDirectory,
      task.resources.download.urlPrefix,
      kind,
      task.resources.encodeUrls
    )
    return plan ? { value: plan.xmlUrl, resources: [plan] } : { value: sourceValue, resources: [] }
  }

  return {
    value: rewriteInternalResourceWithPrefix(
      absoluteUrl,
      ownerPageUrl,
      task.resources.urlPrefix,
      task.resources.encodeUrls
    ),
    resources: []
  }
}

const processSrcsetWithResources = (
  value: string,
  element: Element,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig,
  customAttributes: Set<string>
): ProcessedResourceValue => {
  const resources: ResourcePlan[] = []
  const candidates = value.split(',').map((candidate) => {
    const parts = candidate.trim().split(/\s+/)
    const source = parts.shift() ?? ''
    const processed = processResourceReference(
      source,
      element,
      'srcset',
      resolutionBaseUrl,
      ownerPageUrl,
      task,
      customAttributes
    )
    resources.push(...processed.resources)
    return [processed.value, ...parts].join(' ')
  })
  return { value: candidates.join(', '), resources }
}

const processStyleWithResources = (
  value: string,
  element: Element,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig,
  customAttributes: Set<string>
): ProcessedResourceValue => {
  const resources: ResourcePlan[] = []
  const processed = value.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_match, quote: string, source: string) => {
      const result = processResourceReference(
        source,
        element,
        'style',
        resolutionBaseUrl,
        ownerPageUrl,
        task,
        customAttributes,
        true
      )
      resources.push(...result.resources)
      return result.value ? `url(${quote}${result.value}${quote})` : ''
    }
  )
  return { value: processed, resources }
}

export const processHtmlWithResources = (
  html: string,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig
): ProcessedResourceValue => {
  if (!task.resources.download.enabled && task.resources.addressMode === 'absolute-replace') {
    return {
      value: processHtml(
        html,
        resolutionBaseUrl,
        task.html,
        task.resourceReplacements,
        task.resources.encodeUrls
      ),
      resources: []
    }
  }
  assertResourceConfiguration(task)
  const { document, attributes } = createHtmlDocument(html, resolutionBaseUrl, task.html)
  const processingAttributes = new Set([...attributes, 'poster'])
  const customAttributes = new Set(
    task.html.customResourceAttributes.map((attribute) => attribute.trim().toLowerCase()).filter(Boolean)
  )
  const resources: ResourcePlan[] = []

  document.body.querySelectorAll('*').forEach((element) => {
    for (const attribute of processingAttributes) {
      const current = element.getAttribute(attribute)
      if (!current) continue
      const processed = processResourceReference(
        current,
        element,
        attribute,
        resolutionBaseUrl,
        ownerPageUrl,
        task,
        customAttributes
      )
      if (processed.value) element.setAttribute(attribute, processed.value)
      else element.removeAttribute(attribute)
      resources.push(...processed.resources)
    }
    const srcset = element.getAttribute('srcset')
    if (srcset) {
      const processed = processSrcsetWithResources(
        srcset,
        element,
        resolutionBaseUrl,
        ownerPageUrl,
        task,
        customAttributes
      )
      element.setAttribute('srcset', processed.value)
      resources.push(...processed.resources)
    }
    const style = element.getAttribute('style')
    if (style) {
      const processed = processStyleWithResources(
        style,
        element,
        resolutionBaseUrl,
        ownerPageUrl,
        task,
        customAttributes
      )
      element.setAttribute('style', processed.value)
      resources.push(...processed.resources)
    }
  })

  return { value: document.body.innerHTML, resources }
}

export const processAttributeValueWithResources = (
  value: string,
  element: Element | null,
  attributeName: string,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig
): ProcessedResourceValue => {
  const normalizedAttributeName = attributeName.trim().toLowerCase()
  const customAttributes = new Set(
    task.html.customResourceAttributes.map((attribute) => attribute.trim().toLowerCase()).filter(Boolean)
  )
  if (
    !URL_VALUE_ATTRIBUTES.has(normalizedAttributeName) &&
    !customAttributes.has(normalizedAttributeName)
  ) {
    return { value, resources: [] }
  }
  assertResourceConfiguration(task)
  return processResourceReference(
    value,
    element,
    normalizedAttributeName,
    resolutionBaseUrl,
    ownerPageUrl,
    task,
    customAttributes
  )
}

export const processTextValueWithResources = (
  value: string,
  resolutionBaseUrl: string,
  ownerPageUrl: string,
  task: TaskConfig
): ProcessedResourceValue => {
  const candidate = value.trim()
  if (!candidate || /\s/.test(candidate) || /[<>"'`]/.test(candidate)) {
    return { value, resources: [] }
  }
  const absoluteUrl = resolveHttpUrl(candidate, resolutionBaseUrl)
  if (
    !absoluteUrl ||
    !classifyResourceReference(absoluteUrl, { tagName: '', attributeName: '' })
  ) {
    return { value, resources: [] }
  }
  assertResourceConfiguration(task)
  return processResourceReference(
    candidate,
    null,
    '',
    resolutionBaseUrl,
    ownerPageUrl,
    task,
    new Set()
  )
}
