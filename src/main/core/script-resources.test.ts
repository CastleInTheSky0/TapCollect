import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { createTask } from '@shared/defaults'
import { processHtmlWithResources } from './html-processing'

const pageUrl = 'https://www.example.com/news/1.html'
const downloadTask = () => {
  const task = createTask('script-resources')
  task.resources.download.enabled = true
  task.resources.download.rootDirectory = 'D:/resource-root'
  task.resources.download.urlPrefix = '/resources'
  return task
}
const scriptHtml = '<script>var vsb_pdf_image_data = ["/preview/1.jpg","/preview/2.jpg"];' +
  'showVsbpdfIframe("/files/report.PDF", "100%", "900", "0", "", vsb_pdf_image_data);</script>' +
  '<script name="_videourl" vurl="/media/movie.mp4?e=.mp4">' +
  'showVsbVideo("/media/movie.mp4?e=.mp4", "height=\\"280\\"", "width=\\"420\\"");</script>'

describe('script-backed HTML resources', () => {
  it.each([true, false])('materializes the original PDF and video with cleanHtml=%s', (cleanHtml) => {
    const task = downloadTask()
    task.html.cleanHtml = cleanHtml
    const result = processHtmlWithResources(scriptHtml, pageUrl, pageUrl, task)
    const document = new JSDOM(result.value).window.document

    expect(result.resources).toHaveLength(2)
    expect(result.resources[0]).toMatchObject({
      sourceUrl: 'https://www.example.com/files/report.PDF',
      sourcePageUrl: pageUrl,
      xmlUrl: '/resources/files/report.PDF',
      kind: 'attachment'
    })
    expect(result.resources[1]).toMatchObject({
      sourceUrl: 'https://www.example.com/media/movie.mp4?e=.mp4',
      sourcePageUrl: pageUrl,
      kind: 'video'
    })
    expect(result.resources[1]?.xmlUrl).toMatch(/^\/resources\/media\/movie__[a-f0-9]{8}\.mp4$/)
    expect(document.querySelector('a')?.getAttribute('href')).toBe(result.resources[0]?.xmlUrl)
    expect(document.querySelector('video')?.getAttribute('src')).toBe(result.resources[1]?.xmlUrl)
    expect(document.querySelector('video')?.hasAttribute('controls')).toBe(true)
    expect(document.querySelectorAll('script,img')).toHaveLength(0)
    expect(result.value).not.toContain('preview')
  })

  it('recovers video metadata and decodes JavaScript string escapes without evaluating expressions', () => {
    const result = processHtmlWithResources(
      String.raw`<script>showVsbpdfIframe('\u002f\u9644\u4ef6\/report.PDF?x=1\x26y=2');</script>` +
        '<script name="_videourl" vurl="../media/movie.mp4?x=1&amp;y=2"></script>',
      pageUrl, pageUrl, downloadTask()
    )
    expect(result.resources.map(({ sourceUrl }) => sourceUrl)).toEqual([
      'https://www.example.com/%E9%99%84%E4%BB%B6/report.PDF?x=1&y=2',
      'https://www.example.com/media/movie.mp4?x=1&y=2'
    ])
  })

  it('ignores comments, ordinary strings, function bodies, computed values and invalid scripts', () => {
    const result = processHtmlWithResources(
      `<script>
        // showVsbpdfIframe('/comment.pdf');
        /* showVsbVideo('/comment.mp4'); */
        const text = "showVsbpdfIframe('/quoted.pdf')";
        const path = '/unused.pdf';
        function unused() { showVsbVideo('/uninvoked.mp4'); }
        if (false) showVsbVideo('/conditional.mp4');
        showVsbpdfIframe('/computed' + '.pdf');
        showVsbVideo(path);
        showVsbVideo(\`/template.mp4\`);
        unrelated('/ordinary.pdf');
      </script>` +
        '<script>showVsbpdfIframe("/invalid.pdf"</script>' +
        '<script type="application/json">{"url":"/data.pdf"}</script>' +
        '<script src="/player.js">showVsbVideo("/external-script.mp4")</script>',
      pageUrl, pageUrl, downloadTask()
    )
    expect(result).toEqual({ value: '', resources: [] })
  })

  it('rejects non-HTTP and fragment-only sources and preserves external resources without downloading', () => {
    const result = processHtmlWithResources(
      '<script>showVsbpdfIframe("javascript:alert(1)");showVsbVideo("data:video/mp4,x");' +
        'showVsbVideo("file:///movie.mp4");showVsbVideo("#player");' +
        'showVsbVideo("https://cdn.example.com/movie.mp4");</script>',
      pageUrl, pageUrl, downloadTask()
    )
    expect(result.resources).toEqual([])
    expect(new JSDOM(result.value).window.document.querySelector('video')?.getAttribute('src'))
      .toBe('https://cdn.example.com/movie.mp4')
    expect(result.value).not.toMatch(/javascript:|data:|file:|#player/)
  })

  it('does not duplicate existing rendered resources or repeated script references', () => {
    const result = processHtmlWithResources(
      scriptHtml + scriptHtml + '<a href="/files/report.PDF">报告</a>' +
        '<video><source src="/media/movie.mp4?e=.mp4"></video>',
      pageUrl, pageUrl, downloadTask()
    )
    const document = new JSDOM(result.value).window.document
    expect(document.querySelectorAll('a')).toHaveLength(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(result.resources).toHaveLength(2)
  })

  it('keeps downloads when duplicate links are removed by cleanup or lack file semantics', () => {
    const result = processHtmlWithResources(
      '<noscript><a href="/files/report.pdf">备用链接</a></noscript>' +
        '<script>showVsbpdfIframe("/files/report.pdf");</script>' +
        '<a href="/download?id=1">入口</a>' +
        '<script>showVsbpdfIframe("/download?id=1");</script>',
      pageUrl, pageUrl, downloadTask()
    )
    expect(result.resources.map(({ sourceUrl }) => sourceUrl)).toEqual([
      'https://www.example.com/files/report.pdf',
      'https://www.example.com/download?id=1'
    ])
    expect(result.value).not.toContain('备用链接')
  })

  it('uses existing absolute, replacement and prefix modes without scheduling downloads', () => {
    const task = createTask('script-without-download')
    task.resourceReplacements = [{ id: '1', from: 'https://www.example.com/', to: '/legacy/' }]
    const absolute = processHtmlWithResources(scriptHtml, pageUrl, pageUrl, task)
    expect(absolute.value).toContain('href="/legacy/files/report.PDF"')
    expect(absolute.value).toContain('src="/legacy/media/movie.mp4?e=.mp4"')
    expect(absolute.resources).toEqual([])

    task.resources.addressMode = 'prefix'
    task.resources.urlPrefix = '/static'
    const prefixed = processHtmlWithResources(scriptHtml, pageUrl, pageUrl, task)
    expect(prefixed.value).toContain('href="/static/files/report.PDF"')
    expect(prefixed.value).toContain('src="/static/media/movie.mp4"')
    expect(prefixed.resources).toEqual([])
  })
})
