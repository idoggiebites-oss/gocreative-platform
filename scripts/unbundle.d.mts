export function encryptFile(source: string, target: string, passphrase: string): Promise<void>
export function decryptFile(source: string, target: string, passphrase: string): Promise<void>
export function askPassphrase(prompt: string): Promise<string>
