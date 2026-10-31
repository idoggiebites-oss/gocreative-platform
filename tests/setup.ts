// The two Workers-only stream classes worker/files.ts streams uploads through, for the tests that run the Worker's
// code in Node (tests/api). tests/d1/uploads.test.ts runs the same code on workerd, where these are the real ones.
import { createHash } from 'node:crypto'

const g = globalThis as Record<string, unknown>
if (!('FixedLengthStream' in g)) {
  /** Passes bytes through and errors if it is given more or fewer than `length`, like the Workers class. */
  g.FixedLengthStream = class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number) {
      let n = 0
      super({
        transform(chunk, ctl) {
          n += chunk.byteLength
          if (n > length) throw new TypeError('FixedLengthStream: more bytes than the declared length')
          ctl.enqueue(chunk)
        },
        flush() {
          if (n !== length) throw new TypeError('FixedLengthStream: fewer bytes than the declared length')
        },
      })
    }
  }
}
if (!('DigestStream' in crypto)) {
  /** A WritableStream whose `digest` resolves to the hash of everything written, once it is closed. */
  class DigestStream extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>
    constructor(algorithm: string) {
      const hash = createHash(algorithm.replace('-', '').toLowerCase())
      let done!: (b: ArrayBuffer) => void
      const digest = new Promise<ArrayBuffer>((r) => (done = r))
      super({
        write: (chunk) => void hash.update(chunk),
        close: () => {
          const b = hash.digest()
          done(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
        },
      })
      this.digest = digest
    }
  }
  Object.defineProperty(crypto, 'DigestStream', { value: DigestStream })
}
