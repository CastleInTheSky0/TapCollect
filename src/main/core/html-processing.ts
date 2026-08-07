import { JSDOM } from 'jsdom'
import type { HtmlProcessingConfig, ReplacementRule } from '@shared/types'
import { applyReplacementRules, resolveHttpUrl } from './url-utils'

const DEFAULT_RESOURCE_ATTRIBUTES = ['src', 'data-src', 'data-original', 'href']

const rewriteSrcset = (value: string, baseUrl: string): string =>
  value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/)
      const source = parts.shift() ?? ''
      const absolute = resolveHttpUrl(source, baseUrl) || source
      return [absolute, ...parts].join(' ')
    })
    .join(', ')

const rewriteStyleUrls = (value: string, baseUrl: string): string =>
  value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote: string, source: string) => {
    const absolute = resolveHttpUrl(source, baseUrl)
    return absolute ? `url(${quote}${absolute}${quote})` : match
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

export const processHtml = (
  html: string,
  baseUrl: string,
  config: HtmlProcessingConfig,
  replacements: ReplacementRule[]
): string => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: baseUrl })
  const { document } = dom.window

  if (config.cleanHtml) {
    document.querySelectorAll('script,noscript').forEach((element) => element.remove())
    document.querySelectorAll('iframe').forEach((element) => {
      if (shouldRemoveAttachmentPreview(element)) element.remove()
    })
    removeComments(document)
    document.body.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
      }
    })
  }

  const attributes = new Set([...DEFAULT_RESOURCE_ATTRIBUTES, ...config.customResourceAttributes])
  document.body.querySelectorAll('*').forEach((element) => {
    if (config.absolutizeResources) {
      for (const attribute of attributes) {
        const current = element.getAttribute(attribute)
        if (!current) continue
        const absolute = resolveHttpUrl(current, baseUrl)
        if (absolute) element.setAttribute(attribute, absolute)
      }
      const srcset = element.getAttribute('srcset')
      if (srcset) element.setAttribute('srcset', rewriteSrcset(srcset, baseUrl))
      const style = element.getAttribute('style')
      if (style) element.setAttribute('style', rewriteStyleUrls(style, baseUrl))
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
  const absolute = shouldAbsolutize ? resolveHttpUrl(value, baseUrl) || value : value
  return applyReplacementRules(absolute, replacements)
}
