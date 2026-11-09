import { createRequire } from 'node:module';

interface NativeVerifier {
  verifyECDSA(key: Buffer, digest: Buffer, compact: Buffer): boolean;
  verifySchnorr(key: Buffer, message: Buffer, signature: Buffer): boolean;
}

function loadNative(): NativeVerifier | undefined {
  const mode = process.env.BITCOIN_TS_CRYPTO ?? 'auto';
  if (mode === 'js') return undefined;
  if (mode !== 'native' && mode !== 'auto') throw new Error('BITCOIN_TS_CRYPTO must be auto, js or native');
  const path = '../native/build/' + process.platform + '-' + process.arch + '/verify.node';
  try {
    return createRequire(import.meta.url)(path) as NativeVerifier;
  } catch (error) {
    if (mode === 'native') throw new Error('Native verifier unavailable. Run npm run build:native', { cause: error });
    return undefined;
  }
}

export const nativeVerifier = loadNative();
