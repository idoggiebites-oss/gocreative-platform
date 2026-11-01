export function encryptFile(source: string, target: string, passphrase: string): Promise<void>
export function decryptFile(source: string, target: string, passphrase: string): Promise<void>
export function askPassphrase(prompt: string): Promise<string>
export function passphraseInput(): (chunk: Buffer) => { done?: boolean; cancelled?: boolean; text?: string }
export function sweepStale(prefix: string): void
