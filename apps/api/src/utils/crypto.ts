import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96 bits recomendados por NIST para GCM
const ENCRYPTED_PREFIX = 'enc:v1';

function getKeyBuffer(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}

/**
 * Cifra un texto plano usando AES-256-GCM con IV aleatorio de 12 bytes y AuthTag de 16 bytes.
 * Formato devuelto: `enc:v1:<iv_hex>:<authTag_hex>:<cipherText_hex>`
 * Si el texto ya está cifrado con el prefijo `enc:v1:`, lo devuelve intacto (idempotente).
 */
export function encrypt(text: string): string {
  if (!text) {
    return text;
  }

  if (text.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    return text;
  }

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const key = getKeyBuffer();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encryptedBuffer = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}:${iv.toString('hex')}:${authTag.toString('hex')}:${encryptedBuffer.toString('hex')}`;
}

/**
 * Descifra un payload cifrado con AES-256-GCM (`enc:v1:<iv_hex>:<authTag_hex>:<cipherText_hex>`).
 * Incluye soporte de fallback transparente: si el valor no posee el prefijo `enc:v1:`
 * (por ejemplo, un registro antiguo de prueba en texto plano), devuelve el valor original.
 */
export function decrypt(payload: string): string {
  if (!payload) {
    return payload;
  }

  if (!payload.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    // Fallback limpio para tokens antiguos guardados en texto plano antes de Fase 4
    return payload;
  }

  const parts = payload.split(':');
  // ['enc', 'v1', ivHex, authTagHex, cipherTextHex]
  if (parts.length !== 5) {
    console.warn('[Crypto] Formato de payload cifrado inválido; retornando fallback.');
    return payload;
  }

  const ivHex = parts[2];
  const authTagHex = parts[3];
  const cipherTextHex = parts[4];

  if (!ivHex || !authTagHex || cipherTextHex === undefined) {
    return payload;
  }

  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encryptedData = Buffer.from(cipherTextHex, 'hex');
    const key = getKeyBuffer();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decryptedBuffer = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);

    return decryptedBuffer.toString('utf8');
  } catch (err) {
    console.warn(
      '[Crypto] No se pudo descifrar payload con la ENCRYPTION_KEY actual; usando fallback limpio:',
      err instanceof Error ? err.message : err
    );
    return payload;
  }
}

/**
 * Helper seguro para descifrar un campo nullable de la base de datos (`whatsapp_access_token` | `google_refresh_token`)
 */
export function decryptNullableToken(token: string | null | undefined): string | null {
  if (!token) {
    return null;
  }
  return decrypt(token);
}

/**
 * Helper seguro para cifrar un campo nullable antes de guardarlo en `clinics`
 */
export function encryptNullableToken(token: string | null | undefined): string | null {
  if (!token) {
    return null;
  }
  return encrypt(token);
}
