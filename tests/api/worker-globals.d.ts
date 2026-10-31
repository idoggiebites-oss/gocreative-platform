// tests/ is type-checked by the node project (tsconfig.node.json), but these tests import
// Worker code, which uses Worker globals. Pull just those from the module form of
// workers-types: its global form clashes with @types/node (URL, fetch, ...).
// oxlint-disable-next-line triple-slash-reference -- env.d.ts is a global script, it has nothing to import
/// <reference path="../../worker/env.d.ts" />
type D1Database = import('@cloudflare/workers-types/index.ts').D1Database
type R2Bucket = import('@cloudflare/workers-types/index.ts').R2Bucket
type JsonWebKey = import('@cloudflare/workers-types/index.ts').JsonWebKey
// worker/files.ts streams uploads through these; tests/setup.ts supplies them at runtime in Node.
declare const FixedLengthStream: typeof import('@cloudflare/workers-types/index.ts').FixedLengthStream
// crypto.DigestStream: see worker-crypto.d.ts (a module augmentation needs a module file).
