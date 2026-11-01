// Runs artwork analysis off the main thread, so a slow or hostile image can be cancelled by terminating this worker. It decodes in the browser's sandbox, and nothing leaves the page.
import { ANALYSIS_DEFAULTS, analyzeArtwork, readImageSize } from '@shared/artworkAnalysis'

const WORKING_EDGE = 1200
const MAX_PIXELS = 40_000_000 // about 160 MB once decoded

self.onmessage = async (e: MessageEvent<File>) => {
  try {
    const file = e.data
    const size = readImageSize(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
    // Refuse before decoding: a small file can unpack into an enormous image.
    if (!size || size.width * size.height > MAX_PIXELS) return self.postMessage({ refused: size ? 'too_large' : 'unreadable' })
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    // A header can lie. What was really decoded decides.
    if (bitmap.width !== size.width || bitmap.height !== size.height) {
      bitmap.close()
      return self.postMessage({ refused: 'unreadable' })
    }
    const scale = Math.min(1, WORKING_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    self.postMessage({ analysis: analyzeArtwork({ width: w, height: h, data: ctx.getImageData(0, 0, w, h).data }, ANALYSIS_DEFAULTS) })
  } catch {
    self.postMessage({ refused: 'unreadable' })
  }
}
