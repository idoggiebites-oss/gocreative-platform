import { defensibleColors } from './inquiry'
// Representative artwork types, generated so the expected answer is known. These prove the behavior of the algorithm; only real shop artwork can measure its accuracy (plan §5).
import { describe, expect, test } from 'vitest'
import { ANALYSIS_DEFAULTS, ANALYZER_VERSION, analyzeArtwork, readImageSize, type Pixels } from './artworkAnalysis'

type RGBA = [number, number, number, number]
const image = (w: number, h: number, paint: (x: number, y: number) => RGBA): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4)
  return { width: w, height: h, data }
}
const WHITE: RGBA = [255, 255, 255, 255]; const NAVY: RGBA = [20, 40, 110, 255]; const GOLD: RGBA = [240, 180, 30, 255]; const RED: RGBA = [200, 30, 40, 255]
const CLEAR: RGBA = [0, 0, 0, 0]
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [0, 1, 2, 3].map((i) => a[i] * (1 - t) + b[i] * t) as RGBA
// A seeded generator, so a "random" image is the same every run.
const seeded = (s: number) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }

/** Circles of solid color, with soft edges like real exported artwork. */
const logo = (bg: RGBA, shapes: { c: RGBA; x: number; y: number; r: number }[], size = 300) => image(size, size, (x, y) => {
  let out = bg
  for (const s of shapes) out = mix(out, s.c, Math.min(1, Math.max(0, s.r - Math.hypot(x - s.x, y - s.y) + 0.5)))
  return out
})
const twoInks = [{ c: NAVY, x: 110, y: 150, r: 70 }, { c: GOLD, x: 210, y: 150, r: 50 }]

describe('flat logos', () => {
  test('a clean two-color logo on white: 2 inks, white as a stated background, high confidence', () => {
    const r = analyzeArtwork(logo(WHITE, twoInks))
    expect(r.estimatedInkColors).toBe(2)
    expect(r.detectedColors).toBe(3)
    expect(r.flags).toContain('likely_background')
    expect(r.palette.find((c) => c.likelyBackground)?.hex).toBe('#ffffff')
    expect(r.needsManualReview).toBe(false)
    expect(r.confidence).toBe('high')
  })
  test('anti-aliased edges add no colors, though they create hundreds of raw pixel values', () => {
    const img = logo(WHITE, twoInks)
    const raw = new Set<number>()
    for (let i = 0; i < img.data.length; i += 4) raw.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2])
    expect(raw.size).toBeGreaterThan(20) // a raw count would say this
    expect(analyzeArtwork(img).estimatedInkColors).toBe(2)
  })
  test('JPEG-like noise does not create inks', () => {
    const rand = seeded(7)
    const clean = logo(WHITE, twoInks)
    const noisy = image(300, 300, (x, y) => {
      const i = (y * 300 + x) * 4
      const n = () => (rand() - 0.5) * 8
      return [clean.data[i] + n(), clean.data[i + 1] + n(), clean.data[i + 2] + n(), 255]
    })
    expect(analyzeArtwork(noisy).estimatedInkColors).toBe(2)
  })
  test('more inks are counted, up to the spot-color limit', () => {
    const four = [...twoInks, { c: RED, x: 60, y: 60, r: 30 }, { c: [20, 140, 70, 255] as RGBA, x: 240, y: 240, r: 30 }]
    expect(analyzeArtwork(logo(WHITE, four)).estimatedInkColors).toBe(4)
  })
  test('one solid color with nothing else counts as one ink, not as a background', () => {
    const r = analyzeArtwork(image(100, 100, () => NAVY))
    expect(r.estimatedInkColors).toBe(1)
    expect(r.palette[0].likelyBackground).toBe(false)
  })
  test('close shades merge; clearly different ones do not', () => {
    const split = (b: RGBA) => image(200, 200, (x, y) => (y < 20 || y >= 180 || x < 20 || x >= 180 ? WHITE : x < 100 ? NAVY : b))
    expect(analyzeArtwork(split([26, 46, 116, 255])).estimatedInkColors).toBe(1)
    expect(analyzeArtwork(split(GOLD)).estimatedInkColors).toBe(2)
  })
  test('a speck is dropped and reported, never silently', () => {
    const r = analyzeArtwork(image(300, 300, (x, y) => (x < 3 && y < 3 ? RED : Math.hypot(x - 150, y - 150) < 80 ? NAVY : WHITE)))
    expect(r.estimatedInkColors).toBe(1)
    expect(r.flags).toContain('small_details_dropped')
    expect(r.confidence).not.toBe('high')
  })
})

describe('transparency', () => {
  test('a logo on transparency: only real inks, with no background assumed', () => {
    const r = analyzeArtwork(logo(CLEAR, twoInks))
    expect(r.estimatedInkColors).toBe(2)
    expect(r.flags).not.toContain('likely_background')
  })
  test('a hidden color under transparency does not count', () => {
    const r = analyzeArtwork(image(200, 200, (x, y) => (Math.hypot(x - 100, y - 100) < 60 ? NAVY : [255, 0, 0, 0])))
    expect(r.estimatedInkColors).toBe(1)
  })
  test('uniform partial transparency is not solid ink, even when nearly opaque', () => {
    for (const alpha of [220, 250, 254]) {
      const r = analyzeArtwork(image(100, 100, () => [100, 20, 30, alpha]))
      expect(r.flags, String(alpha)).toContain('partly_transparent')
      expect(r.estimatedInkColors, String(alpha)).toBeNull()
      expect(r.needsManualReview, String(alpha)).toBe(true)
    }
  })
  test('mostly semi-transparent artwork has no count', () => {
    expect(analyzeArtwork(image(100, 100, (x) => (x < 30 ? NAVY : [240, 180, 30, 120]))).needsManualReview).toBe(true)
  })
  test('nothing but transparency goes to manual review', () => {
    const r = analyzeArtwork(image(50, 50, () => CLEAR))
    expect(r.flags).toEqual(['fully_transparent'])
    expect(r.estimatedInkColors).toBeNull()
    expect(r.needsManualReview).toBe(true)
  })
  test('broad semi-transparency is flagged and lowers confidence', () => {
    const r = analyzeArtwork(image(200, 200, (_x, y) => (y < 100 ? NAVY : [240, 180, 30, 120])))
    expect(r.flags).toContain('partly_transparent')
    expect(r.confidence).toBe('low')
  })
})

describe('artwork that has no honest ink count', () => {
  test('a smooth gradient is manual review, never a number', () => {
    const r = analyzeArtwork(image(300, 300, (x, _y) => mix(NAVY, GOLD, x / 299)))
    expect(r.flags).toContain('gradient')
    expect(r.estimatedInkColors).toBeNull()
    expect(r.needsManualReview).toBe(true)
  })
  test('a vertical sky-style gradient behaves the same', () => {
    expect(analyzeArtwork(image(400, 300, (_x, y) => mix([120, 180, 250, 255], WHITE, y / 299))).needsManualReview).toBe(true)
  })
  test('a photograph-like image is manual review', () => {
    const rand = seeded(3)
    const r = analyzeArtwork(image(300, 300, (x, y) => {
      const n = (rand() - 0.5) * 70
      return [120 + 60 * Math.sin(x / 17) + n, 110 + 50 * Math.cos(y / 23) + n, 90 + 40 * Math.sin((x + y) / 31) + n, 255]
    }))
    expect(r.flags.some((f) => f === 'photographic' || f === 'gradient')).toBe(true)
    expect(r.estimatedInkColors).toBeNull()
  })
  test('a faint gradient too narrow to split into colors is still a gradient', () => {
    const r = analyzeArtwork(image(300, 300, (x) => { const v = 100 + (20 * x) / 299; return [v, v, v, 255] }))
    expect(r.flags).toContain('gradient')
    expect(r.estimatedInkColors).toBeNull()
  })
  test('a thin line of another ink is not lost: no count rather than a wrong one', () => {
    const r = analyzeArtwork(image(100, 100, (x, y) => (x === 50 ? RED : x > 10 && x < 35 && y > 10 && y < 35 ? [20, 40, 200, 255] : WHITE)))
    expect(r.flags).toContain('thin_details')
    expect(r.estimatedInkColors).toBeNull()
    expect(r.needsManualReview).toBe(true)
  })
  test('a separate gray line is its own ink, not a black-and-white edge, even though its color lies between them', () => {
    const r = analyzeArtwork(image(200, 200, (x, y) => (x > 20 && x < 100 && y > 20 && y < 180 ? [0, 0, 0, 255] : x === 150 && y > 20 && y < 180 ? [120, 120, 120, 255] : WHITE)))
    expect(r.flags).toContain('thin_details')
    expect(r.estimatedInkColors).toBeNull()
  })
  test('thin parts of an ink already counted are fine: a thin black line beside a black shape', () => {
    const r = analyzeArtwork(image(200, 200, (x, y) => (x > 20 && x < 100 && y > 20 && y < 180 ? [0, 0, 0, 255] : x === 150 && y > 20 && y < 180 ? [0, 0, 0, 255] : WHITE)))
    expect(r.estimatedInkColors).toBe(1)
  })
  test('small anti-aliased type in a counted ink is that ink, not a reason to refuse', () => {
    const r = analyzeArtwork(image(200, 200, (x, y) => {
      if (x >= 20 && x < 80 && y >= 20 && y < 100) return [0, 0, 0, 255]
      if (y >= 130 && y < 150 && x >= 20 && x < 180) {
        const m = (x - 20) % 8
        if (m === 1) return [0, 0, 0, 255]
        if (m === 0 || m === 2) return [128, 128, 128, 255]
      }
      return WHITE
    }))
    expect(r.estimatedInkColors).toBe(1)
    expect(r.needsManualReview).toBe(false)
  })
  test('line art with no solid ink at all goes to manual review, not "one color: white"', () => {
    const r = analyzeArtwork(image(200, 200, (x, y) => ((x % 40 === 0 || y % 40 === 0) ? [0, 0, 0, 255] : WHITE)))
    expect(r.needsManualReview).toBe(true)
    expect(r.estimatedInkColors).toBeNull()
  })
  test('a halftone-style dot pattern does not pretend to be flat', () => {
    const r = analyzeArtwork(image(300, 300, (x, y) => (x % 4 < 2 && y % 4 < 2 ? NAVY : WHITE)))
    expect(r.needsManualReview).toBe(true)
  })
  test('too many colors is refused as a spot count', () => {
    const r = analyzeArtwork(image(300, 300, (x, y) => {
      const k = Math.floor(x / 30) + Math.floor(y / 100) * 10
      return [(k * 67) % 256, (k * 131) % 256, (k * 197) % 256, 255]
    }))
    expect(r.needsManualReview).toBe(true)
    expect(r.estimatedInkColors).toBeNull()
  })
})

describe('malformed input and limits', () => {
  test('wrong buffer length, tiny and oversized images are refused without analysis', () => {
    expect(analyzeArtwork({ width: 10, height: 10, data: new Uint8Array(4) }).flags).toEqual(['too_small'])
    expect(analyzeArtwork({ width: 2, height: 2, data: new Uint8Array(16) }).flags).toEqual(['too_small'])
    expect(analyzeArtwork({ width: -5, height: -5, data: new Uint8Array(100) }).flags).toEqual(['too_small'])
    expect(analyzeArtwork({ width: 100, height: 100, data: new Uint8Array(40000) }, { ...ANALYSIS_DEFAULTS, maxPixels: 100 }).flags).toEqual(['too_large'])
  })
  test('the same pixels always give the same answer', () => {
    const img = logo(WHITE, twoInks)
    expect(analyzeArtwork(img)).toEqual(analyzeArtwork(img))
  })
  test('the result records its analyzer version and the settings used', () => {
    const r = analyzeArtwork(logo(WHITE, twoInks))
    expect(r.analyzerVersion).toBe(ANALYZER_VERSION)
    expect(r.settings).toEqual(ANALYSIS_DEFAULTS)
  })
})

describe('readImageSize reads dimensions without decoding', () => {
  test('PNG, JPEG and junk', () => {
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); new DataView(png.buffer).setUint32(16, 5000); new DataView(png.buffer).setUint32(20, 7000)
    expect(readImageSize(png)).toEqual({ width: 5000, height: 7000 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0x90, 0x02, 0x58, 3, 0, 0])
    expect(readImageSize(jpeg)).toEqual({ width: 600, height: 400 })
    expect(readImageSize(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

const reportOf = (a: ReturnType<typeof analyzeArtwork>) => ({ analyzerVersion: a.analyzerVersion, estimatedInkColors: a.estimatedInkColors, confidence: a.confidence, needsManualReview: a.needsManualReview, flags: a.flags })

describe('what a file can and cannot say about background, white and shades', () => {
  const paint = (w: number, h: number, at: (x: number, y: number) => readonly number[]) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4)
    return { width: w, height: h, data }
  }
  const NAVY = [16, 11, 47, 255], RED = [204, 0, 0, 255], WHITE = [255, 255, 255, 255], CLEAR = [0, 0, 0, 0]

  test('with real transparency no color is background, even one running along the border', () => {
    // A navy frame around red, with see-through corners. Before, the frame was taken for background and one ink vanished.
    const a = analyzeArtwork(paint(200, 200, (x, y) => (x < 20 && y < 20 ? CLEAR : x < 25 || y < 25 || x >= 175 || y >= 175 ? NAVY : RED)))
    expect(a.estimatedInkColors).toBe(2)
    expect(a.flags).not.toContain('likely_background')
  })
  test('white on transparency is flagged as counted white', () => {
    const a = analyzeArtwork(paint(200, 200, (x, y) => (x < 20 || y < 20 ? CLEAR : x < 100 ? NAVY : WHITE)))
    expect(a.estimatedInkColors).toBe(2)
    expect(a.flags).toContain('white_ink')
  })
  test('white inside art on a white background is reported, because it may be ink', () => {
    const a = analyzeArtwork(paint(200, 200, (x, y) => (x > 60 && x < 140 && y > 60 && y < 140 ? WHITE : x > 30 && x < 170 && y > 30 && y < 170 ? NAVY : WHITE)))
    expect(a.flags).toEqual(expect.arrayContaining(['likely_background', 'white_background', 'background_inside']))
    expect(defensibleColors(reportOf(a), 'white')).toBe(1)
    expect(defensibleColors(reportOf(a), 'light')).toBeNull()
  })
  test('a colored background is never assumed away', () => {
    const a = analyzeArtwork(paint(200, 200, (x, y) => (x > 50 && x < 150 && y > 50 && y < 150 ? WHITE : NAVY)))
    expect(a.flags).toContain('likely_background')
    expect(a.flags).not.toContain('white_background')
    expect(defensibleColors(reportOf(a), 'white')).toBeNull()
  })
  test('close shades that could be one ink go to a person', () => {
    const a = analyzeArtwork(paint(200, 200, (x) => (x < 100 ? [0, 51, 102, 255] : [0, 25, 51, 255])))
    expect(a.flags).toContain('similar_shades')
    expect(a.needsManualReview).toBe(true)
  })
  test('more than four inks is a complex separation, not a count', () => {
    const inks = [[200, 0, 0, 255], [0, 150, 0, 255], [0, 0, 200, 255], [230, 200, 0, 255], [150, 0, 150, 255]]
    const a = analyzeArtwork(paint(250, 200, (x) => inks[Math.floor(x / 50)]))
    expect(a.flags).toContain('complex_separation')
    expect(a.estimatedInkColors).toBeNull()
  })
  test('soft edges on transparency are not translucent art; a real translucent area is', () => {
    const edged = analyzeArtwork(paint(200, 200, (x, y) => {
      const stripe = y % 12 < 6 && x > 10 && x < 190
      if (!stripe) return CLEAR
      return y % 12 === 0 || y % 12 === 5 ? [0, 72, 81, 128] : [0, 72, 81, 255]
    }))
    expect(edged.flags).not.toContain('partly_transparent')
    const glassy = analyzeArtwork(paint(200, 200, (x) => (x < 100 ? NAVY : [204, 0, 0, 128])))
    expect(glassy.flags).toContain('partly_transparent')
  })
  test('garment rules: dark or unknown never has a count, whatever the art; white-only art on a white item has none', () => {
    const r = { analyzerVersion: ANALYZER_VERSION, estimatedInkColors: 2, confidence: 'high' as const, needsManualReview: false, flags: [] }
    expect(defensibleColors(r, 'white')).toBe(2)
    expect(defensibleColors(r, 'light')).toBe(2)
    for (const g of ['dark', 'unsure', null, undefined] as const) expect(defensibleColors(r, g)).toBeNull()
    expect(defensibleColors({ ...r, estimatedInkColors: 1, flags: ['white_ink'] }, 'white')).toBeNull()
    expect(defensibleColors({ ...r, flags: ['white_ink'] }, 'white')).toBe(1)
    expect(defensibleColors({ ...r, flags: ['white_ink'] }, 'light')).toBe(2)
  })
})
