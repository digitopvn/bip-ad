const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Prefixed random id, e.g. prd_1x9k... (time-sortable prefix + 80 random bits). */
export function newId(prefix: string): string {
  const t = Date.now().toString(32).padStart(9, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let r = '';
  for (const b of bytes) r += ALPHABET[b & 31];
  return `${prefix}_${t}${r}`;
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
