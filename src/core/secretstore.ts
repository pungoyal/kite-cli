import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { ExitCode, KiteCliError } from './errors.js';
import { configDir, credentialsFile, ensurePrivateDir } from './paths.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Encrypted-file credential store.
 *
 * This is the fallback for machines with no usable OS keyring — headless Linux
 * without D-Bus, containers, some CI runners. It is strictly worse than the
 * keyring (the passphrase has to come from somewhere) but strictly better than
 * the plaintext files that gh, aws, and stripe all fall back to.
 *
 * Format: a JSON header, a newline, then base64 ciphertext.
 * The header is bound as AES-GCM additional authenticated data, so an attacker
 * cannot downgrade the KDF parameters without failing decryption.
 */

/** OWASP-recommended scrypt parameters. ~270ms on an M-series laptop. */
const KDF = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  keylen: 32,
  // Node's default maxmem is 32MB; scrypt at N=2^17,r=8 needs 128*N*r = 134MB
  // and throws without this. A silent, confusing failure if you miss it.
  maxmem: 256 * 1024 * 1024,
} as const;

interface Header {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
}

async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return scrypt(passphrase, salt, KDF.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: KDF.maxmem,
  });
}

export async function encryptToFile(secrets: Record<string, string>, passphrase: string): Promise<void> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt, KDF);

  const header: Header = {
    v: 1,
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
  };
  const headerJson = JSON.stringify(header);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  // Bind the header so KDF parameters cannot be tampered with.
  cipher.setAAD(Buffer.from(headerJson, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(secrets), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = `${headerJson}\n${Buffer.concat([ciphertext, tag]).toString('base64')}\n`;

  await ensurePrivateDir(configDir());
  const path = credentialsFile();
  await writeFile(path, payload, { mode: 0o600, encoding: 'utf8' });
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
  }
}

export async function decryptFromFile(passphrase: string): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const newlineAt = raw.indexOf('\n');
  if (newlineAt === -1) {
    throw new KiteCliError('Credential file is corrupt (no header).', ExitCode.Failure);
  }

  const headerJson = raw.slice(0, newlineAt);
  const body = raw.slice(newlineAt + 1).trim();

  let header: Header;
  try {
    header = JSON.parse(headerJson) as Header;
  } catch {
    throw new KiteCliError('Credential file is corrupt (bad header).', ExitCode.Failure);
  }
  if (header.v !== 1 || header.kdf !== 'scrypt') {
    throw new KiteCliError(
      `Unsupported credential file version. Re-run \`kite login\` to rewrite it.`,
      ExitCode.Failure,
    );
  }

  const salt = Buffer.from(header.salt, 'base64');
  const nonce = Buffer.from(header.nonce, 'base64');
  const key = await deriveKey(passphrase, salt, {
    N: header.N,
    r: header.r,
    p: header.p,
  });

  const blob = Buffer.from(body, 'base64');
  if (blob.length < 17) {
    throw new KiteCliError('Credential file is corrupt (truncated).', ExitCode.Failure);
  }
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(headerJson, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
  } catch {
    // GCM authentication failed: wrong passphrase, or the file was tampered
    // with. We cannot distinguish the two, and should not try to.
    throw new KiteCliError(
      'Could not decrypt credentials — wrong passphrase, or the file was modified.',
      ExitCode.Auth,
      'Re-run `kite login` to rewrite the credential file.',
    );
  }
}

export async function deleteCredentialFile(): Promise<void> {
  try {
    await unlink(credentialsFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Constant-time string comparison, for any future passphrase confirmation.
 *
 * Length is compared on the encoded buffers, not on String.length —
 * timingSafeEqual throws RangeError on mismatched byte lengths, and UTF-16
 * code-unit counts can match while byte lengths do not.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
