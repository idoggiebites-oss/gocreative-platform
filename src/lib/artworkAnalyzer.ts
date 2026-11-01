// The browser side of artwork analysis, for staff tools and later the storefront. Any failure, timeout or unsupported format is a refusal, which means manual review.
import { analyzeArtwork, type ArtworkAnalysis } from '@shared/artworkAnalysis'

export type AnalyzerOutcome = { analysis: ArtworkAnalysis } | { refused: 'unreadable' | 'too_large' | 'timed_out' | 'unsupported' }
const TIMEOUT_MS = 20_000
const SVG_MAX_BYTES = 1024 * 1024
// Only drawn shapes. Anything that fetches, embeds or scripts is refused rather than rendered.
const SVG_REFUSE = /<script|<foreignObject|<image|<use\b|<iframe|<style|href\s*=|url\s*\(|on[a-z]+\s*=/i

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
  if (SVG_REFUSE.test(text)) return { refused: 'unsupported' }
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url }) // <img>: scripts never run
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
