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

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { Effect } from 'effect';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { abi, assetName, combinations, decodeArtifact, decodeIdentity, decodeRelease, releaseFiles, type Identity, type Target, type Artifact } from './contract.ts';
import { attempt, root, shaFile } from './io.ts';

export async function licenseDigests(folder: string): Promise<{ path: string; sha256: string }[]> {
  const paths = ['HAWDB-LICENSE.txt', 'UPSTREAM.txt'];
  async function visit(directory: string): Promise<void> {
    if (!(await lstat(join(folder, directory))).isDirectory()) throw new Error('UnsafeLicenseDirectory');
    for (const name of await readdir(join(folder, directory))) {
      const path = `${directory}/${name}`;
      const stat = await lstat(join(folder, path));
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) paths.push(path);
      else throw new Error(`UnsafeLicenseEntry: ${path}`);
    }
  }
  await visit('licenses');
  return Promise.all(paths.sort().map(async path => ({ path, sha256: await shaFile(join(folder, path)) })));
}
export async function validateArtifact(folder: string, target: Target, hooks: boolean, identity?: Identity): Promise<Artifact> {
  const expected = ['artifact.json', 'hawdb.node', 'UPSTREAM.txt', 'HAWDB-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'licenses'].sort();
  if (JSON.stringify((await readdir(folder)).sort()) !== JSON.stringify(expected)) throw new Error('ArtifactFilesMismatch');
  for (const name of expected.filter(n => n !== 'licenses')) if (!(await lstat(join(folder, name))).isFile()) throw new Error('UnsafeArtifactFile');
  const a = decodeArtifact(JSON.parse(await readFile(join(folder, 'artifact.json'), 'utf8')));
  if (a.target !== target || a.testHooks !== hooks || (target === 'darwin-arm64' ? a.deploymentTarget !== '15.0' : a.deploymentTarget !== undefined)) throw new Error('ArtifactIdentityMismatch');
  if (identity && (a.revision !== identity.revision || a.sourceDigest !== identity.sourceDigest || a.cargoLockDigest !== identity.cargoLockDigest)) throw new Error('ArtifactSourceMismatch');
  if (a.binarySha256 !== await shaFile(join(folder, 'hawdb.node')) || a.noticesSha256 !== await shaFile(join(folder, 'THIRD-PARTY-NOTICES.txt'))) throw new Error('ArtifactDigestMismatch');
  const lines = (await readFile(join(folder, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).trimEnd().split('\n');
  if (lines.at(-2) !== 'Concord license file digests:' || lines.at(-1) !== JSON.stringify(await licenseDigests(folder))) throw new Error('LicenseDigestMismatch');
  const upstream = await readFile(join(folder, 'UPSTREAM.txt'), 'utf8');
  if (!upstream.includes(`revision ${a.revision}\n`)) throw new Error('UpstreamNoticeMismatch');
  return a;
}
export async function extractArchive(archive: string, dest: string, target: Target): Promise<void> {
  if ((await lstat(archive)).size > 128 * 1024 * 1024) throw new Error('ArchiveTooLarge');
  const names = new Set<string>();
  let size = 0;
  let unsafe: string | undefined;
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/u, '');
    size += entry.size;
    if (names.has(name) || !name.startsWith(`${target}/`) && name !== target || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.' || p === '') || !['File', 'Directory'].includes(entry.type) || size > 512 * 1024 * 1024 || names.size >= 20_000) unsafe = entry.path;
    names.add(name);
  } });
  if (unsafe || names.size === 0) throw new Error(`UnsafeArchive: ${unsafe ?? 'empty'}`);
  await mkdir(dest, { recursive: true });
  if ((await readdir(dest)).length !== 0) throw new Error('ExtractionDestinationNotEmpty');
  await tar.x({ file: archive, cwd: dest, strict: true, noChmod: true, preserveOwner: false });
}
export async function pack(input: string, output: string, target: Target, hooks: boolean): Promise<string> {
  await validateArtifact(join(input, target), target, hooks);
  await mkdir(output, { recursive: true });
  const file = join(output, assetName(target, hooks));
  const paths: string[] = [];
  async function visit(path: string): Promise<void> {
    paths.push(path);
    if ((await lstat(join(input, path))).isDirectory()) for (const name of (await readdir(join(input, path))).sort()) await visit(`${path}/${name}`);
  }
  await visit(target);
  await tar.c({ file, cwd: input, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true, follow: false }, paths);
  return file;
}
export async function assemble(input: string, output: string, identity: Identity): Promise<void> {
  await mkdir(output, { recursive: true });
  const assets = [];
  for (const c of combinations) {
    const name = c.name;
    const scratch = await mkdtemp(join(tmpdir(), 'hawdb-release-'));
    try {
      const archive = join(input, name);
      await extractArchive(archive, scratch, c.target);
      const a = await validateArtifact(join(scratch, c.target), c.target, c.testHooks, identity);
      if (!a.portable) throw new Error('ReleaseRequiresPortableBinary');
      assets.push({ ...c, archiveSha256: await shaFile(archive), binarySha256: a.binarySha256, noticesSha256: a.noticesSha256 });
      await writeFile(join(output, name), await readFile(archive));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  const release = decodeRelease({ format: 'concord.native-release/v1', repository: 'CorrectRoadH/hawdb', ...identity, tag: `hawdb-${identity.version}`, abi, assets });
  await writeFile(join(output, 'native-release.json'), `${JSON.stringify(release, null, 2)}\n`);
  const sums = await Promise.all(releaseFiles.filter(n => n !== 'SHA256SUMS').map(async name => `${await shaFile(join(output, name))}  ${name}\n`));
  await writeFile(join(output, 'SHA256SUMS'), sums.join(''));
  await validateReleaseDirectory(output);
}
export async function validateReleaseDirectory(folder: string): Promise<ReturnType<typeof decodeRelease>> {
  if (JSON.stringify((await readdir(folder)).sort()) !== JSON.stringify(releaseFiles)) throw new Error('ReleaseFilesMismatch');
  for (const name of releaseFiles) if (!(await lstat(join(folder, name))).isFile()) throw new Error('UnsafeReleaseFile');
  const release = decodeRelease(JSON.parse(await readFile(join(folder, 'native-release.json'), 'utf8')));
  const sums = await Promise.all(releaseFiles.filter(n => n !== 'SHA256SUMS').map(async name => `${await shaFile(join(folder, name))}  ${name}\n`));
  if (await readFile(join(folder, 'SHA256SUMS'), 'utf8') !== sums.join('')) throw new Error('ReleaseChecksumsMismatch');
  for (const asset of release.assets) {
    if (asset.archiveSha256 !== await shaFile(join(folder, asset.name))) throw new Error('ReleaseArchiveDigestMismatch');
    const scratch = await mkdtemp(join(tmpdir(), 'hawdb-verify-'));
    try {
      await extractArchive(join(folder, asset.name), scratch, asset.target);
      const a = await validateArtifact(join(scratch, asset.target), asset.target, asset.testHooks, release);
      if (!a.portable || a.binarySha256 !== asset.binarySha256 || a.noticesSha256 !== asset.noticesSha256) throw new Error('ReleaseArtifactMismatch');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  return release;
}
if (import.meta.main) {
  const [mode, input, output, target, hooks] = process.argv.slice(2);
  const program = attempt(async () => {
    if (!input || !output) throw new Error('Usage: archive.ts pack|extract|assemble INPUT OUTPUT [TARGET] [hooks]');
    if (mode === 'assemble') await assemble(resolve(input), resolve(output), decodeIdentity(JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'))));
    else if (mode === 'pack' || mode === 'extract') {
      if (target !== 'linux-x64-glibc' && target !== 'darwin-arm64') throw new Error('InvalidTarget');
      if (mode === 'pack') await pack(resolve(input), resolve(output), target, hooks === 'hooks');
      else await extractArchive(resolve(input), resolve(output), target);
    } else throw new Error('InvalidArchiveMode');
  });
  program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
