// The browser side of artwork analysis, for staff tools and later the storefront. Any failure, timeout or unsupported format is a refusal, which means manual review.
import { analyzeArtwork, type ArtworkAnalysis } from '@shared/artworkAnalysis'
import type { ArtworkReport } from '@shared/inquiry'

export type AnalyzerOutcome = { analysis: ArtworkAnalysis } | { refused: 'unreadable' | 'too_large' | 'timed_out' | 'unsupported' }
/** The part of a result sent to the server. Null means it was refused, so a person looks. */
export const reportOf = (o: AnalyzerOutcome): ArtworkReport | null =>
  ('analysis' in o ? { analyzerVersion: o.analysis.analyzerVersion, estimatedInkColors: o.analysis.estimatedInkColors, confidence: o.analysis.confidence, needsManualReview: o.analysis.needsManualReview, flags: o.analysis.flags } : null)
const TIMEOUT_MS = 20_000
const SVG_MAX_BYTES = 1024 * 1024
const SVG_MAX_ELEMENTS = 5000
const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'title', 'desc', 'metadata', 'defs', 'style'])
const SVG_ATTRIBUTES = /^(id|class|version|xmlns|xmlns:.*|xml:space|enable-background|style|width|height|viewbox|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|transform|fill|fill-opacity|fill-rule|clip-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|opacity|display)$/i
// Tiny dashes are a way to make drawing take very long, so only "no dashes" passes.
const noDashes = (name: string, value: string) => !/^stroke-dash/i.test(name.trim()) || /^(none|0)$/i.test(value.trim())
// Checked by namespace, not by prefix: a file can bind the prefix "inkscape" to SVG itself, to smuggle a real element past this.
const EDITOR_NAMESPACES = new Set(['http://www.inkscape.org/namespaces/inkscape', 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd'])
const STYLE_PROPERTIES = /^(fill|fill-opacity|fill-rule|clip-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|opacity|display|enable-background|-inkscape-[a-z-]+)$/i
const SAFE_VALUE = /^[#\w\s.,%()-]*$/

/** Plain paint settings only. Anything that can fetch, run or filter is refused: url(), @rules, expressions, escapes and any property not listed. */
export function isPlainStyle(declarations: string) {
  return declarations.split(';').every((d) => {
    if (!d.trim()) return true
    const at = d.indexOf(':')
    if (at < 0) return false
    const value = d.slice(at + 1).trim()
    return STYLE_PROPERTIES.test(d.slice(0, at).trim()) && noDashes(d.slice(0, at), value) && SAFE_VALUE.test(value) && !/url|expression|image|var|attr|env/i.test(value)
  })
}
/** A style block holding only simple class or id rules of plain paint. */
export function isPlainStyleSheet(css: string) {
  const text = css.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').replace(/\/\*[^*]*\*\//g, '')
  if (/[@\\<]/.test(text)) return false
  const rest = text.replace(/\s*[.#]?[\w-]+(\s*,\s*[.#]?[\w-]+)*\s*\{([^{}]*)\}\s*/g, (_, _names, body: string) => (isPlainStyle(body) ? '' : '!'))
  return rest.trim() === ''
}
// Illustrator's standard line. No internal subset, so it can't declare entities.
const PLAIN_DOCTYPE = /<!DOCTYPE\s+svg\s+PUBLIC\s+"[^"[\]<>]*"\s+"[^"[\]<>]*"\s*>/gi

/**
 * An allowlist over the parsed document, not a text search: character references like u&#114;l( are already decoded here, so they can't slip past.
 * Only plain shapes with plain paints get rendered. Filters, masks, images, gradients, fonts and links are all work or requests we refuse; a person reviews those.
 */
export function isPlainSvg(text: string) {
  if (/<!ENTITY|<!\[/i.test(text.replace(/<!\[CDATA\[/g, '')) || /<!DOCTYPE/i.test(text.replace(PLAIN_DOCTYPE, ''))) return false
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') return false
  const all = doc.querySelectorAll('*')
  if (all.length > SVG_MAX_ELEMENTS) return false
  const SVG_NS = 'http://www.w3.org/2000/svg'
  for (const el of all) {
    // Metadata is data, but a style or script placed inside it still takes effect.
    if (el.closest('metadata') && el.localName !== 'metadata') {
      if (el.namespaceURI === SVG_NS || el.namespaceURI === 'http://www.w3.org/1999/xhtml') return false
      continue
    }
    if (el.namespaceURI && EDITOR_NAMESPACES.has(el.namespaceURI)) continue // a browser draws nothing for these
    if (el.namespaceURI !== SVG_NS || !SVG_ELEMENTS.has(el.localName)) return false
    if (el.localName === 'style' && (el.children.length > 0 || !isPlainStyleSheet(el.textContent ?? ''))) return false
    for (const attr of el.attributes) {
      if (attr.namespaceURI && EDITOR_NAMESPACES.has(attr.namespaceURI)) continue
      if (!SVG_ATTRIBUTES.test(attr.name) || !noDashes(attr.name, attr.value) || /url\s*\(|javascript:|expression/i.test(attr.value)) return false
      if (attr.name.toLowerCase() === 'style' && !isPlainStyle(attr.value)) return false
    }
  }
  return true
}

function inWorker(file: File) {
  return new Promise<AnalyzerOutcome>((resolve) => {
    const worker = new Worker(new URL('./artworkWorker.ts', import.meta.url), { type: 'module' })
    const finish = (o: AnalyzerOutcome) => { clearTimeout(timer); worker.terminate(); resolve(o) }
    const timer = setTimeout(() => finish({ refused: 'timed_out' }), TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<AnalyzerOutcome>) => finish(e.data)
    worker.onerror = () => finish({ refused: 'unreadable' })
    worker.postMessage(file)
  })
}

async function simpleSvg(file: File): Promise<AnalyzerOutcome> {
  if (file.size > SVG_MAX_BYTES) return { refused: 'too_large' }
  const text = await file.text()
  if (!isPlainSvg(text)) return { refused: 'unsupported' }
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url }) // <img>: scripts never run
    const stalled = new Promise((_, reject) => setTimeout(() => reject(new Error('timed_out')), TIMEOUT_MS))
    await Promise.race([loaded, stalled])
    const longest = Math.max(img.naturalWidth || 1000, img.naturalHeight || 1000)
    const scale = 1000 / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round((img.naturalWidth || 1000) * scale)
    canvas.height = Math.round((img.naturalHeight || 1000) * scale)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { analysis: analyzeArtwork({ width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data }) }
  } catch {
    return { refused: 'unreadable' }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** PDF is not analyzed (plan §4): it goes to a person. */
export function analyzeFile(file: File): Promise<AnalyzerOutcome> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return simpleSvg(file)
  if (file.type === 'image/png' || file.type === 'image/jpeg') return inWorker(file)
  return Promise.resolve({ refused: 'unsupported' })
}
