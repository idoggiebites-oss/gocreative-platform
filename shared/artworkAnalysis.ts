// Estimates how many ink colors a piece of artwork needs for screen printing. Deterministic image processing only: no randomness, no AI, no network.
// The result is an estimate from pixels, never a verified separation. A raw pixel-color count is meaningless (anti-aliasing and JPEG noise alone can
// produce thousands of colors), so colors are counted from flat regions only, merged by how different they look.
export const ANALYZER_VERSION = 1

export type AnalysisSettings = {
  maxPixels: number // refused above this; the caller downsizes first
  alphaOpaque: number // 0-255: below this a pixel is transparent or an edge, not ink
  flatTolerance: number // the summed RGB difference to a neighbor that still counts as the same flat color
  mergeDeltaE: number // colors closer than this (CIE76) are one ink
  minCoverage: number // a color below this share of flat pixels is a speck, reported and not counted
  minFlatShare: number // below this share of flat pixels, the artwork has too little solid color to count
  maxSpotColors: number // above this, spot-color printing is doubtful
  gradientBinShare: number // distinct color bins per 1000 flat pixels, above which colors are a ramp, not inks
  gradientMinBins: number
  softBoundaryShare: number // this share of flat pixels where two inks touch with no edge between them means a ramp
  backgroundEdgeShare: number // this share of the border in one color suggests a background
}
export const ANALYSIS_DEFAULTS: AnalysisSettings = {
  maxPixels: 4_000_000, alphaOpaque: 200, flatTolerance: 30, mergeDeltaE: 14, minCoverage: 0.004, minFlatShare: 0.4, maxSpotColors: 8, gradientBinShare: 6, gradientMinBins: 48, softBoundaryShare: 0.002, backgroundEdgeShare: 0.6,
}

export type AnalysisFlag = 'gradient' | 'photographic' | 'too_little_flat_color' | 'too_many_colors' | 'small_details_dropped' | 'likely_background' | 'partly_transparent' | 'fully_transparent' | 'too_large' | 'too_small'
export type AnalysisColor = { hex: string; coverage: number; likelyBackground: boolean }
export type ArtworkAnalysis = {
  analyzerVersion: number
  width: number; height: number
  /** Colors found, counting a likely background. */
  detectedColors: number
  /** The estimate for pricing: excludes a likely background, stated as an assumption. Null when no count can be defended. */
  estimatedInkColors: number | null
  confidence: 'high' | 'medium' | 'low'
  needsManualReview: boolean
  flags: AnalysisFlag[]
  palette: AnalysisColor[]
  settings: AnalysisSettings
}
export type Pixels = { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

type Lab = [number, number, number]
function toLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047)
  const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B)
  const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883)
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}
const deltaE = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const hexOf = (r: number, g: number, b: number) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

type Cluster = { r: number; g: number; b: number; n: number; lab: Lab; border: number; keys: number[] }
const center = (c: Cluster): Lab => toLab(c.r / c.n, c.g / c.n, c.b / c.n)

export function analyzeArtwork(px: Pixels, settings: AnalysisSettings = ANALYSIS_DEFAULTS): ArtworkAnalysis {
  const { width: w, height: h, data } = px
  const base = { analyzerVersion: ANALYZER_VERSION, width: w, height: h, settings }
  const refuse = (flag: AnalysisFlag): ArtworkAnalysis => ({ ...base, detectedColors: 0, estimatedInkColors: null, confidence: 'low', needsManualReview: true, flags: [flag], palette: [] })
  const total = w * h
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || data.length !== total * 4) return refuse('too_small')
  if (total > settings.maxPixels) return refuse('too_large')

  // Flat pixels: opaque, and matching every opaque neighbor. Edges between two colors and photographic texture aren't flat.
  const bins = new Map<number, Cluster>()
  const flatKey = new Int32Array(total).fill(-1)
  let opaque = 0
  let flat = 0
  let semi = 0
  const same = (i: number, j: number) => Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) <= settings.flatTolerance
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const a = data[i + 3]
      if (a < settings.alphaOpaque) {
        if (a > 15) semi++
        continue
      }
      opaque++
      let isFlat = true
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = (ny * w + nx) * 4
        if (data[j + 3] < settings.alphaOpaque) continue
        if (!same(i, j)) { isFlat = false; break }
      }
      if (!isFlat) continue
      flat++
      const key = (data[i] >> 3 << 10) | (data[i + 1] >> 3 << 5) | (data[i + 2] >> 3)
      flatKey[y * w + x] = key
      const bin = bins.get(key) ?? { r: 0, g: 0, b: 0, n: 0, lab: [0, 0, 0] as Lab, border: 0, keys: [key] }
      bin.r += data[i]; bin.g += data[i + 1]; bin.b += data[i + 2]; bin.n++
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) bin.border++
      bins.set(key, bin)
    }
  }
  if (opaque === 0) return refuse('fully_transparent')

  const flags: AnalysisFlag[] = []
  if (semi > 0 && semi / total > 0.02) flags.push('partly_transparent')
  const flatShare = flat / opaque
  // Many distinct shades spread across the flat pixels mean a smooth ramp: neighbors match, yet there is no small set of inks.
  const binsPerK = flat > 0 ? (bins.size / flat) * 1000 : 0
  const significant = [...bins.values()].filter((b) => b.n / Math.max(flat, 1) >= settings.minCoverage / 4).length
  const isRamp = bins.size >= settings.gradientMinBins && (binsPerK >= settings.gradientBinShare || significant >= settings.gradientMinBins)
  if (flatShare < settings.minFlatShare) {
    flags.push(bins.size >= settings.gradientMinBins || flatShare < 0.1 ? 'photographic' : 'too_little_flat_color')
    return { ...base, detectedColors: 0, estimatedInkColors: null, confidence: 'low', needsManualReview: true, flags, palette: [] }
  }
  if (isRamp) {
    flags.push('gradient')
    return { ...base, detectedColors: 0, estimatedInkColors: null, confidence: 'low', needsManualReview: true, flags, palette: [] }
  }

  // Deterministic merging: largest bins first, ties by key, so the same pixels always give the same answer.
  const ordered = [...bins.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).map(([, b]) => b)
  const clusters: Cluster[] = []
  for (const b of ordered) {
    const lab = center(b)
    const home = clusters.find((c) => deltaE(c.lab, lab) <= settings.mergeDeltaE)
    if (home) {
      home.r += b.r; home.g += b.g; home.b += b.b; home.n += b.n; home.border += b.border; home.keys.push(...b.keys)
    } else clusters.push({ ...b, lab })
  }
  // A cluster keeps its first (largest) shade as its anchor, then a final pass joins any that ended up alike.
  for (let i = 0; i < clusters.length; i++) {
    for (let j = clusters.length - 1; j > i; j--) {
      if (deltaE(center(clusters[i]), center(clusters[j])) <= settings.mergeDeltaE) {
        const [a, b] = [clusters[i], clusters[j]]
        a.r += b.r; a.g += b.g; a.b += b.b; a.n += b.n; a.border += b.border; a.keys.push(...b.keys)
        clusters.splice(j, 1)
      }
    }
  }
  // Real inks meet at an edge, and edge pixels aren't flat. Colors that touch with no edge between them are one smooth ramp, however few shades it has.
  const clusterOf = new Map<number, number>()
  clusters.forEach((c, i) => { for (const k of c.keys) clusterOf.set(k, i) })
  let soft = 0
  for (let p = 0; p < total; p++) {
    if (flatKey[p] < 0) continue
    const here = clusterOf.get(flatKey[p])
    if ((p + 1) % w !== 0 && flatKey[p + 1] >= 0 && clusterOf.get(flatKey[p + 1]) !== here) soft++
    if (p + w < total && flatKey[p + w] >= 0 && clusterOf.get(flatKey[p + w]) !== here) soft++
  }
  if (soft / flat >= settings.softBoundaryShare) {
    flags.push('gradient')
    return { ...base, detectedColors: 0, estimatedInkColors: null, confidence: 'low', needsManualReview: true, flags, palette: [] }
  }
  const kept = clusters.filter((c) => c.n / flat >= settings.minCoverage)
  if (kept.length < clusters.length) flags.push('small_details_dropped')

  const borderTotal = kept.reduce((n, c) => n + c.border, 0)
  const background = borderTotal > 0 ? kept.find((c) => c.border / borderTotal >= settings.backgroundEdgeShare) : undefined
  const palette = kept.map((c) => ({ hex: hexOf(c.r / c.n, c.g / c.n, c.b / c.n), coverage: Math.round((c.n / flat) * 10000) / 10000, likelyBackground: c === background && kept.length > 1 }))
  const hasBackground = palette.some((c) => c.likelyBackground)
  if (hasBackground) flags.push('likely_background')
  const inks = palette.length - (hasBackground ? 1 : 0)
  if (inks > settings.maxSpotColors) flags.push('too_many_colors')

  const tooMany = flags.includes('too_many_colors')
  const confidence = tooMany ? 'low' : flatShare >= 0.7 && !flags.includes('small_details_dropped') && !flags.includes('partly_transparent') ? 'high' : 'medium'
  return { ...base, detectedColors: palette.length, estimatedInkColors: tooMany || inks < 1 ? null : inks, confidence, needsManualReview: tooMany || inks < 1, flags, palette }
}

/** Width and height from a PNG or JPEG header, without decoding, so an oversized image can be refused first. Null when it can't tell. */
export function readImageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) { i++; continue }
      const size = (b[i + 2] << 8) | b[i + 3]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] }
      if (size < 2) return null
      i += 2 + size
    }
  }
  return null
}
