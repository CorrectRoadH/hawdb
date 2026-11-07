/*
 * Copyright 2026 Nowledge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Effect, FileSystem, Schema, type PlatformError } from 'effect';
import { decodeIdentity, abi, type Artifact, type Target } from './contract.ts';
import { sourceDigest } from './prepare.ts';
import { attempt, command, failure, ProducerFailed, root, shaFile } from './io.ts';
const crate = join(root, 'crate');
const commandOutput = command;
const inspectEntry = (path: string) => attempt(() => lstat(path));
const CargoMetadataSchema = Schema.Struct({ packages: Schema.Array(Schema.Struct({
  name: Schema.String, version: Schema.String, license: Schema.NullOr(Schema.String),
  manifest_path: Schema.String, source: Schema.NullOr(Schema.String),
})) });
const licenseMarker = 'Concord license file digests:';
const licenseDigests = Effect.fn('native.licenseDigests')(function*(folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const files = ['HAWDB-LICENSE.txt', 'UPSTREAM.txt'];
  const visit = Effect.fn('native.visitLicenseDirectory')(function*(directory: string): Effect.fn.Return<void, ProducerFailed | PlatformError.PlatformError, FileSystem.FileSystem> {
    for (const name of yield* fs.readDirectory(join(folder, directory))) {
      const path = `${directory}/${name}`;
      const entry = yield* inspectEntry(join(folder, path));
      if (entry.isDirectory()) yield* visit(path);
      else if (entry.isFile()) files.push(path);
      else return yield* new ProducerFailed({ detail: `native license must be a regular file: ${path}` });
    }
  });
  yield* visit('licenses');
  return yield* Effect.all(files.sort().map(path => attempt(() => shaFile(join(folder, path))).pipe(Effect.map(sha256 => ({ path, sha256 })))));
});
// FileSystem.copy has no recursive dereference option; Cargo license trees use
// the resolved file bytes, not links into the compiler's registry directory.
const copyLicense = Effect.fn('native.copyLicense')(function*(source: string, destination: string): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const resolved = yield* fs.realPath(source);
  if ((yield* fs.stat(resolved)).type === 'Directory') {
    yield* fs.makeDirectory(destination, { recursive: true });
    for (const name of yield* fs.readDirectory(resolved)) yield* copyLicense(join(resolved, name), join(destination, name));
  } else yield* fs.copyFile(resolved, destination);
});
const dependencyNotices = Effect.fn('native.dependencyNotices')(function*(dest: string) {
  const fs = yield* FileSystem.FileSystem;
  const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CargoMetadataSchema), { onExcessProperty: 'ignore' })(yield* commandOutput('cargo', [
    '+1.97.1', 'metadata', '--locked', '--format-version=1', '--manifest-path', join(crate, 'Cargo.toml'),
  ], 32 * 1024 * 1024));
  const lines = ['Pinned Cargo dependency licenses; see licenses/ for distributed license and notice files.', ''];
  for (const pkg of [...metadata.packages].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
    if (pkg.source === null || pkg.source.startsWith('git+')) continue; // HawDB and its crates use HAWDB-LICENSE.txt.
    if (!pkg.license) return yield* new ProducerFailed({ detail: `dependency has no license declaration: ${pkg.name}@${pkg.version}` });
    const id = `${pkg.name}-${pkg.version}`;
    lines.push(`${id} | ${pkg.license} | ${pkg.source}`);
    const packageDir = resolve(pkg.manifest_path, '..');
    const files = (yield* fs.readDirectory(packageDir)).filter(name => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/iu.test(name));
    if (files.length > 0) {
      const licenseDir = join(dest, 'licenses', id);
      yield* fs.makeDirectory(licenseDir, { recursive: true });
      for (const name of files) yield* copyLicense(join(packageDir, name), join(licenseDir, name));
    }
  }
  lines.push('', licenseMarker, JSON.stringify(yield* licenseDigests(dest)));
  yield* fs.writeFileString(join(dest, 'THIRD-PARTY-NOTICES.txt'), `${lines.join('\n')}\n`);
});

const build = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem;
  const identity = decodeIdentity(JSON.parse(yield* fs.readFileString(join(root, 'identity.json'))));
  if (identity.sourceDigest !== (yield* attempt(() => sourceDigest())) || identity.cargoLockDigest !== (yield* attempt(() => shaFile(join(crate, 'Cargo.lock'))))) return yield* failure('PreparedSourceIdentityMismatch');
  const target: Target = process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64' : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64-glibc' : (() => { throw failure('UnsupportedTarget'); })();
  const hooks = process.argv.includes('--test-hooks');
  const output = resolve(process.argv[2] ?? 'dist');
  if (target === 'darwin-arm64' && process.env.MACOSX_DEPLOYMENT_TARGET !== '15.0') return yield* failure('MACOSX_DEPLOYMENT_TARGET=15.0 required');
  yield* command('cargo', ['+1.97.1', 'build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml'), ...(hooks ? ['--features', 'test-hooks'] : [])]);
  const dest = join(output, target);
  yield* fs.makeDirectory(dest, { recursive: true });
  const binary = join(dest, 'hawdb.node');
  yield* fs.copyFile(join(process.env.CARGO_TARGET_DIR ?? join(crate, 'target'), 'release', target === 'darwin-arm64' ? 'libconcord_hawdb_native.dylib' : 'libconcord_hawdb_native.so'), binary);
  if (target === 'darwin-arm64') {
    yield* command('codesign', ['--force', '--sign', '-', '--timestamp=none', binary]);
    yield* command('codesign', ['--verify', '--strict', '--verbose=2', binary]);
    const load = yield* command('otool', ['-l', binary]);
    if (!/\bminos\s+15\.0(?:\s|$)/u.test(load) || !(yield* command('otool', ['-D', binary])).includes('@rpath/hawdb.node')) return yield* failure('DarwinDeploymentMismatch');
  }
  const glibc = target === 'darwin-arm64' ? undefined : (yield* command('getconf', ['GNU_LIBC_VERSION'])).trim().match(/^glibc 2\.(\d+)$/u);
  const portable = target === 'darwin-arm64' || Boolean(glibc && Number(glibc[1]) <= 39 && !(yield* command('ldd', [binary])).match(/not found|\/nix\/store\//u));
  if (process.env.CI && !portable) return yield* failure('NonPortableBinary');
  for (const name of ['HAWDB-LICENSE.txt', 'UPSTREAM.txt']) yield* fs.copyFile(join(crate, name), join(dest, name));
  yield* fs.makeDirectory(join(dest, 'licenses'), { recursive: true });
  yield* dependencyNotices(dest);
  const artifact: Artifact = {
    target, abi, revision: identity.revision, sourceDigest: identity.sourceDigest, cargoLockDigest: identity.cargoLockDigest,
    binarySha256: yield* attempt(() => shaFile(binary)), noticesSha256: yield* attempt(() => shaFile(join(dest, 'THIRD-PARTY-NOTICES.txt'))),
    portable: Boolean(portable), testHooks: hooks, ...(target === 'darwin-arm64' ? { deploymentTarget: '15.0' as const } : {}),
  };
  if (identity.sourceDigest !== (yield* attempt(() => sourceDigest())) || identity.cargoLockDigest !== (yield* attempt(() => shaFile(join(crate, 'Cargo.lock'))))) return yield* failure('SourceChangedDuringBuild');
  yield* fs.writeFileString(join(dest, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`);
}).pipe(Effect.scoped);
build.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
