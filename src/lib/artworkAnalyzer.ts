// The browser side of artwork analysis, for staff tools and later the storefront. Any failure, timeout or unsupported format is a refusal, which means manual review.
import { analyzeArtwork, type ArtworkAnalysis } from '@shared/artworkAnalysis'

export type AnalyzerOutcome = { analysis: ArtworkAnalysis } | { refused: 'unreadable' | 'too_large' | 'timed_out' | 'unsupported' }
const TIMEOUT_MS = 20_000
const SVG_MAX_BYTES = 1024 * 1024
const SVG_MAX_ELEMENTS = 5000
const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'title', 'desc', 'metadata'])
const SVG_ATTRIBUTES = /^(id|class|version|xmlns|xmlns:.*|width|height|viewbox|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|transform|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-miterlimit|opacity)$/i

/**
 * An allowlist over the parsed document, not a text search: character references like u&#114;l( are already decoded here, so they can't slip past.
 * Only plain shapes with plain paints get rendered. Filters, masks, images, styles, fonts and links are all work or requests we refuse; a person reviews those.
 */
export function isPlainSvg(text: string) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg' || /<!DOCTYPE|<!ENTITY/i.test(text)) return false
  const all = doc.querySelectorAll('*')
  if (all.length > SVG_MAX_ELEMENTS) return false
  for (const el of all) {
    if (el.closest('metadata') && el.localName !== 'metadata') continue
    if (!SVG_ELEMENTS.has(el.localName)) return false
    for (const attr of el.attributes) if (!SVG_ATTRIBUTES.test(attr.name) || /url\s*\(|javascript:|expression/i.test(attr.value)) return false
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
