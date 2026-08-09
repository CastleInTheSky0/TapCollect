import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  resolve(projectRoot, 'node_modules/xlsx/xlsx.js'),
  resolve(projectRoot, 'node_modules/xlsx/xlsx.mjs')
]

const replaceSection = (source, startMarker, endMarker, replacement, patchMarker) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`SheetJS 0.20.3 源码结构不匹配：${startMarker}`)
  }
  const current = source.slice(start, end)
  if (current.includes(patchMarker)) return source
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`
}

const unicodeWriter = `function write_XLUnicodeRichExtendedString(xlstr) {
\t/* TapCollect BIFF8 long-string chunk patch */
\tvar str = (xlstr.t||""), nfmts = 1;

\tvar hdr = new_buf(3 + (nfmts > 1 ? 2 : 0));
\thdr.write_shift(2, str.length);
\thdr.write_shift(1, (nfmts > 1 ? 0x08 : 0x00) | 0x01);
\tif(nfmts > 1) hdr.write_shift(2, nfmts);

\t/* A BIFF8 record holds at most 8224 bytes.  Keep surrogate pairs together. */
\tvar maxFirstChars = 4110, maxContinueChars = 4111;
\tif(str.length <= maxFirstChars) {
\t\tvar otext = new_buf(2 * str.length);
\t\totext.write_shift(2 * str.length, str, 'utf16le');
\t\treturn bconcat([hdr, otext]);
\t}

\tvar out = [], parts = [], start = 0;
\tvar end = Math.min(str.length, maxFirstChars);
\tif(end < str.length && end > start && str.charCodeAt(end - 1) >= 0xD800 && str.charCodeAt(end - 1) <= 0xDBFF && str.charCodeAt(end) >= 0xDC00 && str.charCodeAt(end) <= 0xDFFF) --end;
\tvar first = new_buf(2 * (end - start));
\tfirst.write_shift(2 * (end - start), str.slice(start, end), 'utf16le');
\tout.push(hdr, first);
\tparts.push(-(hdr.length + first.length));
\tstart = end;

\twhile(start < str.length) {
\t\tend = Math.min(str.length, start + maxContinueChars);
\t\tif(end < str.length && str.charCodeAt(end - 1) >= 0xD800 && str.charCodeAt(end - 1) <= 0xDBFF && str.charCodeAt(end) >= 0xDC00 && str.charCodeAt(end) <= 0xDFFF) --end;
\t\tvar continuation = new_buf(1 + 2 * (end - start));
\t\tcontinuation.write_shift(1, 0x01);
\t\tcontinuation.write_shift(2 * (end - start), str.slice(start, end), 'utf16le');
\t\tout.push(continuation);
\t\tparts.push(-continuation.length);
\t\tstart = end;
\t}

\tvar result = bconcat(out);
\tresult.parts = parts;
\treturn result;
}`

const sstWriter = `function write_SST(sst, opts) {
\t/* TapCollect BIFF8 SST part-boundary patch */
\tvar header = new_buf(8);
\theader.write_shift(4, sst.Count);
\theader.write_shift(4, sst.Unique);
\tvar strs = [], parts = [header.length];
\tfor(var j = 0; j < sst.length; ++j) {
\t\tstrs[j] = write_XLUnicodeRichExtendedString(sst[j], opts);
\t\tparts = parts.concat(strs[j].parts || [strs[j].length]);
\t}
\tvar o = bconcat([header].concat(strs));
\to.parts = parts;
\treturn o;
}`

const continueWriter = `function write_biff_continue(ba, type, payload, length) {
\t/* TapCollect BIFF8 forced-boundary patch */
\tvar len = length || (payload||[]).length || 0;
\tif(len <= 8224) return write_biff_rec(ba, type, payload, len);
\tvar t = type;
\tif(isNaN(t)) return;
\tvar parts = payload.parts || [], sidx = 0;
\tvar i = 0, w = 0;
\tfunction next_record_length() {
\t\tvar size = 0;
\t\twhile(sidx < parts.length) {
\t\t\tvar raw = parts[sidx], forced = raw < 0, part = Math.abs(raw);
\t\t\tif(part > 8224) throw new Error("BIFF8 record part exceeds 8224 bytes");
\t\t\tif(forced && size > 0) break;
\t\t\tif(size + part > 8224) break;
\t\t\tsize += part;
\t\t\t++sidx;
\t\t}
\t\tif(size === 0) throw new Error("Unable to split BIFF8 record");
\t\treturn size;
\t}
\tw = parts.length ? next_record_length() : Math.min(8224, len);
\tvar o = ba.next(4);
\to.write_shift(2, t);
\to.write_shift(2, w);
\tba.push(payload.slice(i, i + w));
\ti += w;
\twhile(i < len) {
\t\to = ba.next(4);
\t\to.write_shift(2, 0x3c);
\t\tw = parts.length ? next_record_length() : Math.min(8224, len - i);
\t\to.write_shift(2, w);
\t\tba.push(payload.slice(i, i+w)); i+= w;
\t}
}`

for (const target of targets) {
  let source = await readFile(target, 'utf8')
  source = replaceSection(
    source,
    'function write_XLUnicodeRichExtendedString(',
    '/* 2.5.296 XLUnicodeStringNoCch */',
    unicodeWriter,
    'TapCollect BIFF8 long-string chunk patch'
  )
  source = replaceSection(
    source,
    'function write_SST(',
    '/* [MS-XLS] 2.4.107 */',
    sstWriter,
    'TapCollect BIFF8 SST part-boundary patch'
  )
  source = replaceSection(
    source,
    'function write_biff_continue(',
    'function write_BIFF2BERR(',
    continueWriter,
    'TapCollect BIFF8 forced-boundary patch'
  )
  await writeFile(target, source, 'utf8')
}

process.stdout.write('SheetJS BIFF8 长字符串补丁已应用\n')
