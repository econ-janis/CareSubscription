const dns = require('node:dns/promises');
const net = require('node:net');

// Descarga y valida la Logo URL de una suscripción para incrustarla por
// CID (nunca se re-publica en una URL pública). Reglas: HTTPS, PNG o JPEG
// (por content-type y por firma de bytes), máximo MAX_BYTES, y el host no
// puede resolver a una IP privada/loopback (evita usar el servidor para
// pegarle a la red interna).
const MAX_BYTES = 500 * 1024;
const MAX_REDIRECTS = 3;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

function detectImageType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function checkUrlSyntax(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Logo URL inválida');
  }
  if (url.protocol !== 'https:') throw new Error('La Logo URL debe ser HTTPS');
  if (url.username || url.password) throw new Error('La Logo URL no puede incluir credenciales');
  return url;
}

async function assertPublicHost(url) {
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('La Logo URL apunta a una dirección no permitida');
  }
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error(`El logo supera ${MAX_BYTES / 1024} KB`);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`El logo supera ${MAX_BYTES / 1024} KB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Devuelve { buffer, contentType } o tira Error con el motivo.
async function fetchLogo(rawUrl) {
  let url = checkUrlSyntax(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = checkUrlSyntax(new URL(response.headers.get('location'), url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`El logo respondió ${response.status}`);

    const declaredType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg'].includes(declaredType)) {
      throw new Error(`El logo debe ser image/png o image/jpeg (es ${declaredType || 'desconocido'})`);
    }

    const buffer = await readLimited(response);
    const realType = detectImageType(buffer);
    if (realType !== declaredType) throw new Error('El contenido del logo no coincide con su tipo declarado');
    return { buffer, contentType: realType };
  }
  throw new Error('La Logo URL tiene demasiadas redirecciones');
}

module.exports = { fetchLogo, isPrivateAddress, detectImageType, MAX_BYTES };
