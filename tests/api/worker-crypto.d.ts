// Node's global `crypto` is typed as webcrypto.Crypto from its 'crypto' module; worker/files.ts also uses the
// Workers-only crypto.DigestStream, which tests/setup.ts supplies at runtime in Node.
export {}
declare module 'crypto' {
  namespace webcrypto {
    interface Crypto { DigestStream: typeof import('@cloudflare/workers-types/index.ts').DigestStream }
  }
}
