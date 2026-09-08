import { parse } from 'acorn'
import { classifyResourceReference } from './resource-planner'
import { resolveHttpUrl } from './url-utils'

interface ScriptResource {
  kind: 'attachment' | 'video'
  url: string
}

const SCRIPT_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'
])

const readScriptResources = (script: Element): ScriptResource[] => {
  if (script.hasAttribute('src') || !SCRIPT_TYPES.has(
    (script.getAttribute('type') ?? '').trim().toLowerCase()
  )) return []

  const resources: ScriptResource[] = []
  const source = script.textContent ?? ''
  if (source.includes('showVsbpdfIframe') || source.includes('showVsbVideo')) {
    try {
      // Parse literals without executing scripts or guessing values from arbitrary strings.
      const program = parse(source, { ecmaVersion: 'latest' })
      for (const statement of program.body) {
        if (statement.type !== 'ExpressionStatement') continue
        const call = statement.expression
        if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') continue
        const name = call.callee.name
        if (name !== 'showVsbpdfIframe' && name !== 'showVsbVideo') continue
        const argument = call.arguments[0]
        if (argument?.type !== 'Literal' || typeof argument.value !== 'string') continue
        resources.push({
          kind: name === 'showVsbVideo' ? 'video' : 'attachment',
          url: argument.value
        })
      }
    } catch {
      // Malformed or unsupported scripts remain subject to normal HTML cleanup.
    }
  }

  if (script.getAttribute('name') === '_videourl' && !resources.some(({ kind }) => kind === 'video')) {
    const url = script.getAttribute('vurl')
    if (url) resources.push({ kind: 'video', url })
  }
  return resources
}

export const materializeScriptResources = (document: Document, baseUrl: string): void => {
  const existing = new Set<string>()
  for (const element of document.body.querySelectorAll('a[href],video[src],video source[src]')) {
    if (element.closest('noscript')) continue
    const kind = element.tagName.toLowerCase() === 'a' ? 'attachment' : 'video'
    const attributeName = kind === 'attachment' ? 'href' : 'src'
    const url = resolveHttpUrl(element.getAttribute(attributeName) ?? '', baseUrl)
    if (url && classifyResourceReference(url, {
      tagName: element.tagName,
      parentTagName: element.parentElement?.tagName ?? '',
      attributeName,
      hasDownloadAttribute: element.hasAttribute('download')
    })) existing.add(`${kind}:${url}`)
  }

  for (const script of document.body.querySelectorAll('script')) {
    if (script.closest('noscript')) continue
    let recognized = false
    for (const resource of readScriptResources(script)) {
      const sourceUrl = resource.url.trim()
      if (!sourceUrl || sourceUrl.startsWith('#')) continue
      const absoluteUrl = resolveHttpUrl(sourceUrl, baseUrl)
      if (!absoluteUrl) continue
      recognized = true
      const key = `${resource.kind}:${absoluteUrl}`
      if (existing.has(key)) continue
      existing.add(key)

      const element = document.createElement(resource.kind === 'video' ? 'video' : 'a')
      if (resource.kind === 'video') {
        element.setAttribute('src', sourceUrl)
        element.setAttribute('controls', '')
        element.setAttribute('preload', 'metadata')
      } else {
        element.setAttribute('href', sourceUrl)
        element.setAttribute('download', '')
        element.textContent = 'PDF 附件'
      }
      script.before(element)
    }
    if (recognized) script.remove()
  }
}
