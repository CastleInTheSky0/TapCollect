export interface PreviewSelection {
  selector: string
  matches: Element[]
}

/**
 * Resolves the selector used by the remote preview picker.
 *
 * An empty scope means the user is choosing the repeated list-item container.
 * A non-empty scope means the user is choosing a field relative to that scope.
 * `:root` is used for fields that belong to the whole document (for example,
 * a detail-page body) rather than to a repeated list item.
 * `ancestorAttribute` is reserved for detail-link picking. It allows a link
 * attribute on the list-item root or its nearest wrapping ancestor.
 *
 * Keep this function self-contained: PreviewService serializes it with
 * Function.prototype.toString() and runs it inside the isolated preview page.
 */
export function resolvePreviewSelection(
  target: Element,
  scopeSelector: string,
  ancestorAttribute = '',
  generalizeTextPosition = false
): PreviewSelection {
  const ownerDocument = target.ownerDocument

  const cssEscape = (value: string): string => {
    const css = ownerDocument.defaultView?.CSS
    if (css && typeof css.escape === 'function') return css.escape(value)
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
  }

  const safeMatches = (element: Element, selector: string): boolean => {
    try {
      return element.matches(selector)
    } catch {
      return false
    }
  }

  const structureSignature = (element: Element): string => {
    const childTags = Array.from(element.children)
      .map((child) => child.tagName.toLowerCase())
      .join(',')
    const hasText = (element.textContent || '').trim() ? 'text' : 'empty'
    const hasLink = element.querySelector('a[href]') ? 'link' : 'no-link'
    const hasMedia = element.querySelector('img, video, audio, source') ? 'media' : 'no-media'
    return `${childTags}|${hasText}|${hasLink}|${hasMedia}`
  }

  const exactSegment = (
    element: Element,
    reusableAcrossScopes: boolean,
    allowUniqueId: boolean
  ): string => {
    const parent = element.parentElement
    const tag = element.tagName.toLowerCase()
    const reusableCandidate = (selector: string): boolean => {
      if (!reusableAcrossScopes) return true
      try {
        const scopes = Array.from(ownerDocument.querySelectorAll(scopeSelector))
        return (
          scopes.length > 0 &&
          scopes.every((scope) => scope.querySelectorAll(selector).length === 1) &&
          scopes.some((scope) => Array.from(scope.querySelectorAll(selector)).includes(element))
        )
      } catch {
        return false
      }
    }

    const candidates: string[] = []
    if (allowUniqueId && element.id) {
      const idSelector = `#${cssEscape(element.id)}`
      let globallyUnique = false
      try {
        globallyUnique = ownerDocument.querySelectorAll(idSelector).length === 1
      } catch {
        // Continue with class and structural candidates for malformed page IDs.
      }
      const candidate = globallyUnique ? idSelector : `${tag}${idSelector}`
      if (reusableCandidate(candidate)) candidates.push(candidate)
    }

    const classes = Array.from(element.classList).slice(0, 3)
    const classCandidates = classes.map((className) => `.${cssEscape(className)}`)
    for (let left = 0; left < classes.length; left += 1) {
      for (let right = left + 1; right < classes.length; right += 1) {
        const leftClass = classes[left]
        const rightClass = classes[right]
        if (!leftClass || !rightClass) continue
        classCandidates.push(
          `.${cssEscape(leftClass)}.${cssEscape(rightClass)}`
        )
      }
    }
    if (classes.length === 3) {
      classCandidates.push(classes.map((className) => `.${cssEscape(className)}`).join(''))
    }
    const reusableClassCandidates = Array.from(new Set(classCandidates)).filter(
      reusableCandidate
    )
    candidates.push(
      ...reusableClassCandidates,
      ...reusableClassCandidates.map((candidate) => `${tag}${candidate}`),
      tag
    )

    const siblingMatches = (selector: string): Element[] =>
      parent
        ? Array.from(parent.children).filter((sibling) => safeMatches(sibling, selector))
        : [element]

    const uniqueCandidate = candidates.find(
      (candidate) =>
        safeMatches(element, candidate) && siblingMatches(candidate).length === 1
    )
    if (uniqueCandidate) return uniqueCandidate

    if (!parent) return candidates[0] || tag
    const sameTagSiblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === element.tagName
    )
    const position = sameTagSiblings.indexOf(element) + 1
    const positionalCandidate = candidates
      .map((candidate) => `${candidate}:nth-of-type(${position})`)
      .find(
        (candidate) =>
          safeMatches(element, candidate) && siblingMatches(candidate).length === 1
      )
    return positionalCandidate || `${tag}:nth-of-type(${position})`
  }

  const exactSelectorFor = (
    element: Element,
    root: Document | Element,
    reusableAcrossScopes: boolean,
    allowUniqueId: boolean,
    allowElementAsAnchor = false
  ): string => {
    if (element === root) return ':scope'
    const documentRoot = root === ownerDocument || root === ownerDocument.documentElement
    let boundary: Element | null = null
    let boundarySelector = ''

    if (documentRoot) {
      let candidate: Element | null = allowElementAsAnchor ? element : element.parentElement
      while (candidate) {
        if (allowUniqueId && candidate.id) {
          const idSelector = `#${cssEscape(candidate.id)}`
          try {
            if (ownerDocument.querySelectorAll(idSelector).length === 1) {
              boundary = candidate
              boundarySelector = idSelector
              break
            }
          } catch {
            // Continue toward body when the page ID cannot form a valid selector.
          }
        }
        candidate = candidate.parentElement
      }

      if (!boundary) {
        const body = ownerDocument.body
        boundary = body && (body === element || body.contains(element))
          ? body
          : ownerDocument.documentElement
        boundarySelector = boundary === body ? 'body' : 'html'
      }
    }

    const parts: string[] = []
    let current: Element | null = element
    while (current && current !== root) {
      if (current === boundary) {
        parts.unshift(boundarySelector)
        break
      }
      const part = exactSegment(current, reusableAcrossScopes, allowUniqueId)
      parts.unshift(part)
      current = current.parentElement
    }
    return parts.join(' > ')
  }

  const attributedSelectorFor = (element: Element, attribute: string): string => {
    const tag = element.tagName.toLowerCase()
    const reusableClasses = Array.from(element.classList)
      .filter((className) => ownerDocument.getElementsByClassName(className).length > 1)
      .slice(0, 2)
    return `${tag}${reusableClasses
      .map((className) => `.${cssEscape(className)}`)
      .join('')}[${cssEscape(attribute)}]`
  }

  const closestWithAttribute = (element: Element, attribute: string): Element | null => {
    let current: Element | null = element
    while (current) {
      if (current.hasAttribute(attribute)) return current
      current = current.parentElement
    }
    return null
  }

  const uniqueMatches = (selector: string): Element[] => {
    if (!selector) return []
    const matches: Element[] = []
    try {
      const scopes: Array<Document | Element> = scopeSelector
        ? Array.from(ownerDocument.querySelectorAll(scopeSelector))
        : [ownerDocument]
      scopes.forEach((scope) => {
        if (selector === ':scope' && scope !== ownerDocument) {
          matches.push(scope as Element)
          return
        }
        matches.push(...Array.from(scope.querySelectorAll(selector)))
      })
    } catch {
      return []
    }
    return Array.from(new Set(matches))
  }

  const generalizedTextSelection = (selector: string): PreviewSelection | null => {
    if (!generalizeTextPosition) return null
    const generalized = selector.replace(/:nth-of-type\(\d+\)$/, '')
    if (!generalized || generalized === selector) return null
    const matches = uniqueMatches(generalized)
    if (matches.length < 2 || !matches.includes(target)) return null
    return { selector: generalized, matches }
  }

  const repeatedSegmentFor = (element: Element): string => {
    const parent = element.parentElement
    if (!parent) return ''
    const sameTagSiblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === element.tagName
    )
    if (sameTagSiblings.length < 2) return ''

    const signature = structureSignature(element)
    const similarSiblings = sameTagSiblings.filter(
      (sibling) => structureSignature(sibling) === signature
    )
    if (similarSiblings.length < 2) return ''

    const tag = element.tagName.toLowerCase()
    const universalClasses = Array.from(element.classList).filter((className) =>
      similarSiblings.every((sibling) => sibling.classList.contains(className))
    )
    if (universalClasses.length) {
      const classSelectors = universalClasses
        .slice(0, 2)
        .map((className) => `.${cssEscape(className)}`)
      for (const classSelector of classSelectors) {
        const matches = Array.from(parent.children).filter((sibling) =>
          safeMatches(sibling, classSelector)
        )
        if (
          matches.length >= 2 &&
          matches.every(
            (match) =>
              match.tagName === element.tagName && structureSignature(match) === signature
          )
        ) {
          return classSelector
        }
      }
      return `${tag}${classSelectors.join('')}`
    }

    const semanticRepeatTags = ['tr', 'li', 'article', 'dt', 'dd']
    if (element.classList.length && !semanticRepeatTags.includes(tag)) return ''
    return tag
  }

  const repeatedChildrenWithin = (container: Element): PreviewSelection | null => {
    const containerTag = container.tagName.toLowerCase()
    if (containerTag === 'html' || containerTag === 'body') return null

    let level: Element[] = [container]
    const maxDepth = 2
    for (let depth = 0; depth <= maxDepth && level.length; depth += 1) {
      const candidates: Array<{
        parent: Element
        segment: string
        score: number
      }> = []

      level.forEach((parent) => {
        const children = Array.from(parent.children)
        const seenSegments = new Set<string>()
        children.forEach((child) => {
          const segment = repeatedSegmentFor(child)
          if (!segment || seenSegments.has(segment)) return
          seenSegments.add(segment)

          const matches = children.filter((sibling) => safeMatches(sibling, segment))
          if (matches.length < 2) return
          const signature = structureSignature(child)
          if (matches.filter((match) => structureSignature(match) === signature).length < 2) {
            return
          }

          const linkCount = matches.filter(
            (match) => safeMatches(match, 'a[href]') || Boolean(match.querySelector('a[href]'))
          ).length
          const textCount = matches.filter((match) => Boolean((match.textContent || '').trim())).length
          candidates.push({
            parent,
            segment,
            score: linkCount * 4 + textCount * 2 + matches.length
          })
        })
      })

      candidates.sort((left, right) => right.score - left.score)
      for (const candidate of candidates) {
        const parentSelector = exactSelectorFor(
          candidate.parent,
          ownerDocument,
          false,
          true,
          true
        )
        const selector = `${parentSelector} > ${candidate.segment}`
        let matches: Element[] = []
        try {
          matches = Array.from(ownerDocument.querySelectorAll(selector))
        } catch {
          matches = []
        }
        if (matches.length > 1) return { selector, matches }
      }

      if (depth === maxDepth) break
      level = level
        .flatMap((parent) => Array.from(parent.children))
        .filter((child) => !['script', 'style', 'template'].includes(child.tagName.toLowerCase()))
        .slice(0, 200)
    }

    return null
  }

  if (!scopeSelector) {
    let current: Element | null = target
    while (current && current !== ownerDocument.documentElement) {
      const parent = current.parentElement
      const repeatedSegment = repeatedSegmentFor(current)
      if (parent && repeatedSegment) {
        const parentSelector = exactSelectorFor(parent, ownerDocument, false, true, true)
        const selector = `${parentSelector} > ${repeatedSegment}`
        let matches: Element[] = []
        try {
          matches = Array.from(ownerDocument.querySelectorAll(selector))
        } catch {
          matches = []
        }
        if (matches.length > 1 && matches.includes(current)) return { selector, matches }
      }
      current = current.parentElement
    }

    const nestedSelection = repeatedChildrenWithin(target)
    if (nestedSelection) return nestedSelection

    const selector = exactSelectorFor(target, ownerDocument, false, true)
    return { selector, matches: uniqueMatches(selector) }
  }

  const documentScope = scopeSelector === ':root'
  let root: Document | Element = ownerDocument
  let scopedRoot: Element | null = null
  if (documentScope) {
    root = target.closest(':root') || ownerDocument
  } else {
    try {
      scopedRoot = target.closest(scopeSelector)
    } catch {
      throw new Error('列表项范围选择器无效，请返回第 2 步重新配置')
    }
    if (!scopedRoot) {
      throw new Error(
        '当前点击位置不在已配置的列表项范围内；若正在选择详情内容，请先将“页面来源”改为“详情页”'
      )
    }
    root = scopedRoot
  }

  const attribute = ancestorAttribute.trim()
  if (scopedRoot && attribute) {
    const attributedTarget = closestWithAttribute(target, attribute)
    if (attributedTarget === scopedRoot) {
      const matches = Array.from(ownerDocument.querySelectorAll(scopeSelector)).filter((scope) =>
        scope.hasAttribute(attribute)
      )
      return { selector: ':scope', matches }
    }
    if (attributedTarget && scopedRoot.contains(attributedTarget)) {
      const exact = exactSelectorFor(attributedTarget, scopedRoot, true, true)
      const selector = `${exact}[${cssEscape(attribute)}]`
      return {
        selector,
        matches: uniqueMatches(selector).filter((match) => match.hasAttribute(attribute))
      }
    }
    if (attributedTarget?.contains(scopedRoot)) {
      const selector = attributedSelectorFor(attributedTarget, attribute)
      const matches = Array.from(ownerDocument.querySelectorAll(scopeSelector))
        .map((scope) => scope.closest(selector))
        .filter((match): match is Element => Boolean(match?.hasAttribute(attribute)))
      return { selector, matches: Array.from(new Set(matches)) }
    }
  }

  const selector = exactSelectorFor(target, root, !documentScope, true)
  return generalizedTextSelection(selector) ?? { selector, matches: uniqueMatches(selector) }
}
