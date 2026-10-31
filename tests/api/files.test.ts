import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { UploadResponse } from '../../shared/api'
import { FILE_CSP, MAX_UPLOAD_BYTES, contentDisposition, sanitizeFilename, sniff } from '../../worker/files'
import { EXE, HTML, JPEG, PDF, PNG, SVG, TIFF_BE, TIFF_LE, setupUploads } from './r2'

const text = (s: string) => new TextEncoder().encode(s)
const ARTWORK = '/orders/2026-0022/artwork' // active, no designs yet

describe('sniff (magic bytes)', () => {
  test('each allowed type', () => {
    expect([PNG, JPEG, TIFF_LE, TIFF_BE, PDF, SVG].map(sniff)).toEqual(['png', 'jpeg', 'tiff', 'tiff', 'pdf', 'svg'])
    expect(sniff(text('<svg xmlns="http://www.w3.org/2000/svg"/>'.replace('/>', '></svg>')))).toBe('svg')
    expect(sniff(text('  \n<svg>'))).toBe('svg')
  })
  test('everything else', () => {
    for (const b of [HTML, EXE, new Uint8Array(), text('<?xml version="1.0"?><html><script>x</script></html>'), text('<svgx>'), text('<html><svg></svg></html>'),
      text('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>'), text('PK\u0003\u0004'), new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00])]) {
      expect(sniff(b), new TextDecoder().decode(b)).toBeNull()
    }
  })
})

describe('file names', () => {
  test('sanitised for display only', () => {
    expect(sanitizeFilename('C:\\Users\\me\\logo final.png')).toBe('logo final.png')
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a"b;c\r\nd\u202egnp.exe')).toBe('abcdgnp.exe')
    expect(sanitizeFilename('..')).toBeNull()
    expect(sanitizeFilename('')).toBeNull()
    expect([...sanitizeFilename('é'.repeat(300))!]).toHaveLength(200)
  })
  test('Content-Disposition carries an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'logo é (1).svg')).toBe(`attachment; filename="logo _ (1).svg"; filename*=UTF-8''logo%20%C3%A9%20%281%29.svg`)
    expect(contentDisposition('inline', null)).toBe('inline')
  })
})

describe('upload', () => {
  test('each allowed type is accepted by its bytes and stored under a random key, never the file name; the hash is in the row', async () => {
    const t = setupUploads()
    const orderId = t.order('2026-0022').id
    for (const [bytes, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [TIFF_LE, 'image/tiff'], [TIFF_BE, 'image/tiff'], [PDF, 'application/pdf'], [SVG, 'image/svg+xml']] as const) {
      const res = await t.upload(`${ARTWORK}?expectedVersion=${t.order('2026-0022').version}`, bytes, mime, { filename: '../evil name.png' })
      expect(res.status, mime).toBe(201)
      const { id } = (await res.json()) as UploadResponse
      const f = t.one<{ r2_key: string; mime: string; bytes: number; sha256: string; filename: string; uploaded_by: number }>(
        'SELECT f.* FROM files f JOIN artwork a ON a.file_id = f.id WHERE a.id = ?', id)
      const sha = createHash('sha256').update(bytes).digest('hex')
      expect(f).toMatchObject({ mime, bytes: bytes.byteLength, sha256: sha, filename: 'evil name.png', uploaded_by: 1 })
      expect(f.r2_key).toMatch(new RegExp(`^orders/${orderId}/[0-9a-f-]{36}$`))
      expect(t.r2.objects.get(f.r2_key)).toMatchObject({ contentType: mime })
    }
  })

  test('HTML, an executable, and HTML renamed to .png are refused, with nothing written anywhere', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const v = t.order('2026-0022').version
    for (const [bytes, type, filename] of [[HTML, 'text/html', 'page.html'], [EXE, 'application/octet-stream', 'setup.exe'], [HTML, 'image/png', 'logo.png'], [EXE, 'image/png', 'logo.png']] as const) {
      const res = await t.upload(`${ARTWORK}?expectedVersion=${v}`, bytes, type, { filename })
      expect(res.status, filename).toBe(415)
      expect(await res.json()).toMatchObject({ code: 'unsupported_file_type' })
    }
    expect(t.footprint()).toEqual(before)
    expect(t.r2.calls).toEqual([])
  })

  test('the declared type must match the bytes', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const v = t.order('2026-0022').version
    for (const [bytes, type] of [[PNG, 'image/jpeg'], [SVG, 'text/xml'], [PDF, 'application/octet-stream'], [JPEG, '']] as const) {
      const res = await t.upload(`${ARTWORK}?expectedVersion=${v}`, bytes, type)
      expect(res.status, type).toBe(415)
      expect(await res.json()).toMatchObject({ code: 'file_type_mismatch' })
    }
    // Parameters and case don't matter.
    expect((await t.upload(`${ARTWORK}?expectedVersion=${v}`, PNG, 'IMAGE/PNG; charset=binary')).status).toBe(201)
    expect(t.footprint().files).toBe(before.files + 1)
  })

  test('Content-Length is required (411) and over 50 MB is refused (413), both before anything is read or stored', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const v = t.order('2026-0022').version
    for (const length of [null, 'abc', '-1', '1.5', '']) {
      const res = await t.upload(`${ARTWORK}?expectedVersion=${v}`, PNG, 'image/png', { length })
      expect(res.status, String(length)).toBe(411)
      expect(await res.json()).toMatchObject({ code: 'length_required' })
    }
    const declared = await t.upload(`${ARTWORK}?expectedVersion=${v}`, PNG, 'image/png', { length: MAX_UPLOAD_BYTES + 1 })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toMatchObject({ code: 'file_too_large' })
    expect(t.footprint()).toEqual(before)
    expect(t.r2.calls).toEqual([])
    // Exactly 50 MB is fine, and is stored whole.
    const big = new Uint8Array(MAX_UPLOAD_BYTES)
    big.set(PNG)
    const res = await t.upload(`${ARTWORK}?expectedVersion=${v}`, big, 'image/png')
    expect(res.status).toBe(201)
    const f = t.one<{ r2_key: string; bytes: number; sha256: string }>('SELECT f.r2_key, f.bytes, f.sha256 FROM files f JOIN artwork a ON a.file_id = f.id WHERE a.id = ?', ((await res.json()) as UploadResponse).id)
    expect(f).toMatchObject({ bytes: MAX_UPLOAD_BYTES, sha256: createHash('sha256').update(big).digest('hex') })
    expect(t.r2.objects.get(f.r2_key)!.bytes.byteLength).toBe(MAX_UPLOAD_BYTES)
  })

  test('a body shorter or longer than its Content-Length is refused, with no files row and no object left', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const v = t.order('2026-0022').version
    const long = new Uint8Array(64 * 1024)
    long.set(PNG)
    for (const [bytes, length] of [[PNG, PNG.byteLength + 10], [long, 1000], [long, long.byteLength * 4]] as const) {
      const res = await t.upload(`${ARTWORK}?expectedVersion=${v}`, bytes, 'image/png', { length })
      expect(res.status, `${bytes.byteLength} bytes, declared ${length}`).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'invalid_request' })
    }
    expect(t.footprint()).toEqual(before)
  })

  // Codex security review of 1729ff4: an object a committed row names must never be deleted.
  test('the batch commits, then the follow-up read fails: the object stays and the rows reference it', async () => {
    const t = setupUploads()
    const before = t.footprint()
    let committed = false
    const flaky = {
      prepare: (sql: string) => (committed ? { bind: () => ({ first: async () => { throw new Error('D1 read timed out') } }) } : t.db.prepare(sql)),
      batch: async (stmts: Parameters<typeof t.db.batch>[0]) => {
        const r = await t.db.batch(stmts)
        committed = true
        return r
      },
    } as unknown as typeof t.db
    const res = await t.upload(`${ARTWORK}?expectedVersion=${t.order('2026-0022').version}`, PNG, 'image/png', { DB: flaky })
    expect(res.status).toBe(500)
    expect(t.r2.calls.map(([op]) => op)).toEqual(['put'])
    expect(t.footprint()).toMatchObject({ files: before.files + 1, artwork: before.artwork + 1, r2: before.r2 + 1 })
    const key = t.r2.calls[0]![1]
    expect(t.count('SELECT COUNT(*) AS n FROM artwork a JOIN files f ON f.id = a.file_id WHERE f.r2_key = ?', key)).toBe(1)
    expect(t.r2.objects.get(key)!.bytes).toEqual(PNG)
  })

  test('a D1 failure that may have committed keeps the object (an unreferenced object is harmless)', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const failing = { prepare: t.db.prepare.bind(t.db), batch: async () => { throw new Error('Network connection lost') } } as unknown as typeof t.db
    const res = await t.upload(`${ARTWORK}?expectedVersion=${t.order('2026-0022').version}`, PNG, 'image/png', { DB: failing })
    expect(res.status).toBe(500)
    expect(t.r2.calls.map(([op]) => op)).toEqual(['put'])
    expect(t.footprint()).toEqual({ ...before, r2: before.r2 + 1 })
  })

  test('a batch that certainly rolled back (a constraint failure) deletes the object', async () => {
    const t = setupUploads()
    const n = '2026-0017' // design 17
    const before = t.footprint()
    // Design 17 moves to another order between the route's read and the batch: the version subquery is NULL, NOT NULL aborts the batch.
    const racing = {
      prepare: t.db.prepare.bind(t.db),
      batch: async (stmts: Parameters<typeof t.db.batch>[0]) => {
        t.sqlite.exec(`UPDATE artwork SET order_id = 1 WHERE lineage_id = 17`)
        return t.db.batch(stmts)
      },
    } as unknown as typeof t.db
    const res = await t.upload(`/orders/${n}/artwork?expectedVersion=${t.order(n).version}&lineageId=17`, PNG, 'image/png', { DB: racing })
    expect(res.status).toBe(409)
    expect(t.r2.calls.map(([op]) => op)).toEqual(['put', 'delete'])
    expect(t.footprint()).toEqual(before)
  })
})

describe('download', () => {
  const uploadOne = async (t: ReturnType<typeof setupUploads>, bytes: Uint8Array, mime: string, filename?: string) => {
    const res = await t.upload(`${ARTWORK}?expectedVersion=${t.order('2026-0022').version}`, bytes, mime, { filename })
    const { id } = (await res.json()) as UploadResponse
    return t.one<{ file_id: number }>('SELECT file_id FROM artwork WHERE id = ?', id).file_id
  }

  test('SVG downloads as an attachment, sandboxed, never sniffed or cached', async () => {
    const t = setupUploads()
    const fileId = await uploadOne(t, SVG, 'image/svg+xml', 'logo.svg')
    const res = await t.get(`/files/${fileId}`)
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/svg+xml',
      'content-disposition': `attachment; filename="logo.svg"; filename*=UTF-8''logo.svg`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_CSP,
      'cache-control': 'private, max-age=0',
    })
    expect(FILE_CSP).toBe("sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(SVG)
  })

  test('other types are inline, and ?download=1 forces an attachment', async () => {
    const t = setupUploads()
    const fileId = await uploadOne(t, PDF, 'application/pdf', 'po.pdf')
    const inline = await t.get(`/files/${fileId}`)
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(inline.headers.get('content-type')).toBe('application/pdf')
    expect(inline.headers.get('content-security-policy')).toBe(FILE_CSP)
    expect((await t.get(`/files/${fileId}?download=1`)).headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  test('only files linked to an order are served; unknown, unlinked and malformed ids are 404', async () => {
    const t = setupUploads()
    t.r2.objects.set('orphan', { bytes: PNG, contentType: 'image/png' })
    t.sqlite.exec(`INSERT INTO files (id, r2_key, mime, bytes, sha256) VALUES (900, 'orphan', 'image/png', ${PNG.byteLength}, 'x')`)
    for (const id of ['900', '99999', 'abc', '0', '1e3']) expect((await t.get(`/files/${id}`)).status, id).toBe(404)
    // Linked, but the object isn't in R2 (the seed's placeholder files): 404, not a 500.
    expect((await t.get('/files/1')).status).toBe(404)
    // Linking it through a PO document makes it servable.
    t.sqlite.exec(`INSERT INTO po_documents (po_id, file_id) VALUES (1, 900)`)
    expect((await t.get('/files/900')).status).toBe(200)
  })

  test('a file row from before M2 with a type outside the allowlist downloads as an opaque attachment', async () => {
    const t = setupUploads()
    t.r2.objects.set('old', { bytes: HTML })
    t.sqlite.exec(`INSERT INTO files (id, r2_key, mime, bytes, sha256) VALUES (901, 'old', 'text/html', 1, 'x'); INSERT INTO po_documents (po_id, file_id) VALUES (1, 901);`)
    const res = await t.get('/files/901')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  test('401 without auth', async () => {
    const t = setupUploads()
    const fileId = await uploadOne(t, PNG, 'image/png')
    expect((await t.get(`/files/${fileId}`, false)).status).toBe(401)
  })
})
