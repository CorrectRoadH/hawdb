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

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { stableVersion, engineVersionOf, revision as revisionSchema } from './contract.ts';
import { Schema } from 'effect';
import { attempt, command, root, shaFile, hash } from './io.ts';
// Explicit sorted recipe list. Cargo.lock has its own independent digest.
export const sourceFiles = [
  '../../.cargo/config.toml', '../../.github/workflows/release-binaries.yml', '.bun-version', '.node-version',
  'archive.ts', 'build.ts', 'contract.ts', 'crate/Cargo.toml', 'crate/HAWDB-LICENSE.txt', 'crate/UPSTREAM.txt',
  'crate/build.rs', 'crate/rust-toolchain.toml', 'crate/src/lib.rs', 'io.ts', 'package.json', 'pnpm-lock.yaml',
  'prepare.ts', 'release.ts', 'tests/native.test.ts', 'tsconfig.json',
].sort();
export const sourceDigest = async (recipeRoot = root): Promise<string> => {
  const parts: Buffer[] = [];
  for (const file of sourceFiles) parts.push(Buffer.from(`${file}\0`), await readFile(join(recipeRoot, file)), Buffer.from('\0'));
  return hash(Buffer.concat(parts));
};
const writeChanged = async (path: string, bytes: Uint8Array | string): Promise<void> => {
  const next = Buffer.from(bytes);
  const old = await readFile(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!old?.equals(next)) await writeFile(path, next);
};
const prepare = Effect.gen(function*() {
  const engineVersion = stableVersion(process.argv[2] ?? '');
  const version = process.argv[5] ?? engineVersion;
  if (engineVersionOf(version) !== engineVersion) throw new Error('PreparedEngineVersionMismatch');
  const revision = Schema.decodeUnknownSync(revisionSchema)(process.argv[3]);
  const producerCommit = Schema.decodeUnknownSync(revisionSchema)(process.argv[4]);
  const manifest = join(root, 'crate/Cargo.toml');
  yield* attempt(async () => {
    const before = await readFile(manifest, 'utf8');
    if ((before.match(/rev = "[a-f0-9]{40}", version = "=[^"]+"/gu) ?? []).length !== 1) throw new Error('EngineManifestPinMissing');
    await writeChanged(manifest, before.replace(/rev = "[a-f0-9]{40}", version = "=[^"]+"/u, `rev = "${revision}", version = "=${engineVersion}"`));
    const rust = join(root, 'crate/src/lib.rs');
    await writeChanged(rust, (await readFile(rust, 'utf8')).replace(/const REVISION: &str = "[a-f0-9]{40}"/u, `const REVISION: &str = "${revision}"`));
    await writeChanged(join(root, 'crate/UPSTREAM.txt'), `HawDB https://github.com/nowledge-co/hawdb.git\nversion ${engineVersion}\nrevision ${revision}\nlicense Apache-2.0\nThe release artifact includes HawDB's LICENSE as HAWDB-LICENSE.txt.\n`);
  });
  // Preserve pins; change only the selected engine and dependencies required by it.
  yield* command('cargo', ['+1.97.1', 'update', '--manifest-path', manifest, '-p', 'hawdb']);
  const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ packages: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.String, manifest_path: Schema.String, source: Schema.NullOr(Schema.String), license: Schema.NullOr(Schema.String) })) })), { onExcessProperty: 'ignore' })(yield* command('cargo', ['+1.97.1', 'metadata', '--locked', '--format-version=1', '--manifest-path', manifest]));
  const engine = metadata.packages.filter(p => p.name === 'hawdb');
  const expectedSource = `git+https://github.com/nowledge-co/hawdb.git?rev=${revision}#${revision}`;
  if (engine.length !== 1 || engine[0]!.version !== engineVersion || engine[0]!.source !== expectedSource || engine[0]!.license !== 'Apache-2.0') throw new Error('ResolvedEngineIdentityMismatch');
  yield* attempt(async () => writeChanged(join(root, 'crate/HAWDB-LICENSE.txt'), await readFile(join(dirname(engine[0]!.manifest_path), 'LICENSE'))));
  yield* attempt(async () => {
    const identity = { version, engineVersion, revision, producerCommit, sourceDigest: await sourceDigest(), cargoLockDigest: await shaFile(join(root, 'crate/Cargo.lock')) };
    await writeChanged(join(root, 'identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sourceDigest=${identity.sourceDigest}\ncargoLockDigest=${identity.cargoLockDigest}\n`);
  });
});
if (import.meta.main) prepare.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
