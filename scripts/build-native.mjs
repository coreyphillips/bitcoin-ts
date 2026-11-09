import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '0.8.0';
const url = 'https://codeload.github.com/bitcoin-core/secp256k1/tar.gz/refs/tags/v' + version;
const expectedHash = 'eb52b0e9239dff7dc26be5f9623567141b8720ec47da29eb3c1e0a660d17c8bb';
const root = fileURLToPath(new URL('..', import.meta.url));

if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The optional native build supports macOS and Linux');
const nodeInclude = process.env.NODE_INCLUDE_DIR ?? resolve(dirname(process.execPath), '../include/node');
if (!existsSync(join(nodeInclude, 'node_api.h'))) throw new Error('Set NODE_INCLUDE_DIR to the directory containing node_api.h');

const build = join(root, 'native/build', process.platform + '-' + process.arch);
mkdirSync(build, { recursive: true });
const temp = mkdtempSync(join(build, 'temp-'));
try {
  const archive = join(temp, 'upstream.tar.gz');
  if (process.env.SECP256K1_TARBALL) {
    writeFileSync(archive, readFileSync(process.env.SECP256K1_TARBALL));
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not download libsecp256k1: HTTP ' + response.status);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expectedHash) {
    throw new Error('Unexpected SHA-256 for libsecp256k1 v' + version);
  }
  execFileSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' });
  const source = join(temp, 'secp256k1-' + version);
  const output = join(temp, 'verify.node');
  const linker = process.platform === 'darwin' ? ['-bundle', '-undefined', 'dynamic_lookup'] : ['-shared'];
  execFileSync(process.env.CC ?? 'cc', [
    '-std=c99', '-O3', '-fPIC', '-fvisibility=hidden', '-DSECP256K1_NO_API_VISIBILITY_ATTRIBUTES',
    '-DENABLE_MODULE_EXTRAKEYS', '-DENABLE_MODULE_SCHNORRSIG', '-DNAPI_VERSION=8',
    '-I', nodeInclude, '-I', join(source, 'include'), ...linker,
    join(root, 'native/verify.c'), join(source, 'src/secp256k1.c'),
    join(source, 'src/precomputed_ecmult.c'), join(source, 'src/precomputed_ecmult_gen.c'),
    '-o', output,
  ], { stdio: 'inherit' });
  // Check the actual Node/architecture combination before atomically publishing the addon.
  createRequire(import.meta.url)(output);
  renameSync(output, join(build, 'verify.node'));
  console.log('Built libsecp256k1 v' + version + ' for ' + process.platform + '-' + process.arch);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
