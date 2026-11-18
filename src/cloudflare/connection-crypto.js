const bytes = text => new TextEncoder().encode(text);
const hex = value => Array.from(value, n => n.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) ?? [], n => parseInt(n, 16));
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))));
export const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

const context = connection => bytes(JSON.stringify([1, connection.family_id, connection.provider, connection.id, connection.revision]));
async function key(value) {
  if (!validKey(value)) throw new Error('connection_key_unavailable');
  return crypto.subtle.importKey('raw', unhex(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealCredentials(credentials, connection, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(connection) },
    await key(secret), bytes(JSON.stringify(credentials)));
  return JSON.stringify({ version: 1, iv: hex(iv), ciphertext: hex(new Uint8Array(encrypted)) });
}
export async function openCredentials(envelope, connection, secret) {
  const data = JSON.parse(envelope);
  if (data.version !== 1 || !/^[a-f0-9]{24}$/.test(data.iv) || !/^(?:[a-f0-9]{2}){16,8192}$/.test(data.ciphertext)) {
    throw new Error('invalid_credential_envelope');
  }
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(data.iv), additionalData: context(connection) },
    await key(secret), unhex(data.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
