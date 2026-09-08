import { parse } from 'acorn'
import { classifyResourceReference, PDF_PREVIEW_CLASS } from './resource-planner'
import { resolveHttpUrl } from './url-utils'

interface ScriptResource {
  kind: 'pdf' | 'media'
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
          kind: name === 'showVsbVideo' ? 'media' : 'pdf',
          url: argument.value
        })
      }
    } catch {
      // Malformed or unsupported scripts remain subject to normal HTML cleanup.
    }
  }

  if (script.getAttribute('name') === '_videourl' && !resources.some(({ kind }) => kind === 'media')) {
    const url = script.getAttribute('vurl')
    if (url) resources.push({ kind: 'media', url })
  }
  return resources
}

export const isLegacyAttachmentPreview = (element: Element): boolean =>
  element.tagName.toLowerCase() === 'iframe' &&
  !element.classList.contains(PDF_PREVIEW_CLASS) &&
  (element.getAttribute('src') ?? '').toLowerCase().includes('docview.aspx')

export const materializeScriptResources = (document: Document, baseUrl: string): void => {
  const existing = new Set<string>()
  for (const element of document.body.querySelectorAll(
    'iframe[src],video[src],video source[src],audio[src],audio source[src]'
  )) {
    if (element.closest('noscript') || isLegacyAttachmentPreview(element)) continue
    const url = resolveHttpUrl(element.getAttribute('src') ?? '', baseUrl)
    if (!url) continue
    const kind = classifyResourceReference(url, {
      tagName: element.tagName,
      className: element.getAttribute('class') ?? '',
      parentTagName: element.parentElement?.tagName ?? '',
      attributeName: 'src'
    })
    if (element.tagName.toLowerCase() === 'iframe' && kind !== 'attachment') continue
    if (kind === 'attachment' || kind === 'audio' || kind === 'video') {
      existing.add(`${kind === 'attachment' ? 'pdf' : kind}:${url}`)
    }
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
      const kind = resource.kind === 'pdf' ? 'pdf' :
        classifyResourceReference(absoluteUrl, { tagName: '', attributeName: 'src' }) === 'audio'
          ? 'audio' : 'video'
      const key = `${kind}:${absoluteUrl}`
      if (existing.has(key)) continue
      existing.add(key)

      const element = document.createElement(kind === 'pdf' ? 'iframe' : kind)
      if (kind === 'pdf') {
        element.setAttribute('src', sourceUrl)
        element.setAttribute('scrolling', 'no')
        element.setAttribute('frameborder', '0')
        element.setAttribute('style', 'width: 90%;height: 1000px;margin: 0px auto 0;display: block;')
        element.setAttribute('class', PDF_PREVIEW_CLASS)
      } else if (kind === 'video') {
        element.setAttribute('class', 'edui-upload-video  video-js')
        element.setAttribute('controls', '')
        element.setAttribute('preload', 'none')
        element.setAttribute('width', '640')
        element.setAttribute('height', '480')
        element.setAttribute('src', sourceUrl)
        element.setAttribute('data-setup', '{}')
        element.setAttribute('autoplay', 'true')
      } else {
        element.setAttribute('controls', '')
        element.setAttribute('src', sourceUrl)
        element.textContent = '音频'
      }
      script.before(element)
    }
    if (recognized) script.remove()
  }
}
