import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { signatureBackend, verifyECDSA, verifySchnorr } from '../dist/crypto.js';

test('signature verifier accepts the historical Bitcoin ECDSA encodings', () => {
  const secret = Buffer.alloc(32, 19);
  const msg = Buffer.alloc(32, 200);
  const compressed = Buffer.from(secp256k1.getPublicKey(secret));
  const hybrid = Buffer.from(secp256k1.getPublicKey(secret, false));
  hybrid[0] = 6 + (hybrid[64] & 1);
  const low = secp256k1.sign(msg, secret, { prehash: false, lowS: true });
  const high = new secp256k1.Signature(low.r, secp256k1.Point.Fn.ORDER - low.s);
  const der = Buffer.from(high.toDERRawBytes());
  // Core's historical parser permits a nonminimal length and trailing data.
  const lax = Buffer.concat([Buffer.of(0x30, 0x81), der.subarray(1), Buffer.of(0xf1)]);
  assert.equal(verifyECDSA(compressed, msg, der), true);
  assert.equal(verifyECDSA(hybrid, msg, lax), true);
  assert.equal(verifyECDSA(hybrid, Buffer.alloc(32), lax), false);
  hybrid[0] ^= 1;
  assert.equal(verifyECDSA(hybrid, msg, lax), false);
  assert.equal(verifyECDSA(compressed, msg, Buffer.from('3006020100020100', 'hex')), false);
});

test('BIP340 verification accepts variable message lengths and rejects invalid points', () => {
  const secret = Buffer.alloc(32, 7);
  const key = Buffer.from(schnorr.getPublicKey(secret));
  const invalidX = Buffer.alloc(32, 255);
  for (const length of [0, 1, 32, 100]) {
    const msg = Buffer.alloc(length, 33);
    const sig = Buffer.from(schnorr.sign(msg, secret, Buffer.alloc(32)));
    assert.equal(verifySchnorr(key, msg, sig), true);
    assert.equal(verifySchnorr(key, Buffer.concat([msg, Buffer.of(1)]), sig), false);
    assert.equal(verifySchnorr(invalidX, msg, sig), false);
    sig.fill(255, 32);
    assert.equal(verifySchnorr(key, msg, sig), false);
  }
  if (['native', 'js'].includes(process.env.BITCOIN_TS_CRYPTO)) {
    assert.equal(signatureBackend, process.env.BITCOIN_TS_CRYPTO);
  }
});
