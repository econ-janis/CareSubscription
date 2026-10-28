const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, detectImageType, fetchLogo } = require('../lib/logo');

test('detecta IPs privadas', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('detecta PNG y JPEG por firma', () => {
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectImageType(Buffer.from('<svg>')), null);
});

test('rechaza URLs no HTTPS y con credenciales', async () => {
  await assert.rejects(fetchLogo('http://example.com/logo.png'), /HTTPS/);
  await assert.rejects(fetchLogo('https://user:pass@example.com/logo.png'), /credenciales/);
  await assert.rejects(fetchLogo('no-es-url'), /inválida/);
});
