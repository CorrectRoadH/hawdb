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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import * as tar from 'tar';
import { abi, combinations, releaseFiles, type Identity } from '../contract.ts';
import { assemble, extractArchive, licenseDigests, pack, validateReleaseDirectory } from '../archive.ts';
import { publishFrozen, provenanceBody, verifyPublic, preflightRelease, type Frozen, type ReleaseHost, type RemoteRelease } from '../release.ts';
import { command, root, shaFile } from '../io.ts';
const identity: Identity = { version: '0.28.0', engineVersion: '0.28.0', revision: 'a'.repeat(40), producerCommit: 'b'.repeat(40), sourceDigest: 'c'.repeat(64), cargoLockDigest: 'd'.repeat(64) };
const frozen: Frozen = { runId: '123', artifactId: '456', artifactDigest: 'e'.repeat(64), producerCommit: identity.producerCommit, sourceDigest: identity.sourceDigest };
test('producer commands retain their working directory with an explicit stdout bound', async () => {
  const run = (script: string, limit: number) => Effect.runPromise(command(process.execPath, ['-e', script], limit).pipe(Effect.provide(NodeServices.layer)));
  assert.equal(await run('process.stdout.write(process.cwd())', 32 * 1024 * 1024), root);
  await assert.rejects(run('process.stdout.write("over limit")', 3), /output limit/u);
});
async function fixture(prepared: Identity = identity) {
  const identity = prepared;
  const dir = await mkdtemp(join(tmpdir(), 'hawdb-publish-test-'));
  const archives = join(dir, 'archives'), candidate = join(dir, 'candidate');
  for (const c of combinations) {
    const input = join(dir, c.name), folder = join(input, c.target);
    await mkdir(join(folder, 'licenses/example'), { recursive: true });
    await writeFile(join(folder, 'licenses/example/LICENSE'), 'external boundary fixture license');
    await writeFile(join(folder, 'hawdb.node'), `fixture bytes ${c.name}`);
    await writeFile(join(folder, 'HAWDB-LICENSE.txt'), 'Apache-2.0');
    await writeFile(join(folder, 'UPSTREAM.txt'), `revision ${identity.revision}\n`);
    await writeFile(join(folder, 'THIRD-PARTY-NOTICES.txt'), `Fixture notices\nConcord license file digests:\n${JSON.stringify(await licenseDigests(folder))}\n`);
    await writeFile(join(folder, 'artifact.json'), JSON.stringify({ target: c.target, abi, revision: identity.revision, sourceDigest: identity.sourceDigest, cargoLockDigest: identity.cargoLockDigest, binarySha256: await shaFile(join(folder, 'hawdb.node')), noticesSha256: await shaFile(join(folder, 'THIRD-PARTY-NOTICES.txt')), portable: true, testHooks: c.testHooks, ...(c.target === 'darwin-arm64' ? { deploymentTarget: '15.0' } : {}) }));
    await pack(input, archives, c.target, c.testHooks);
  }
  await assemble(archives, candidate, identity);
  return { dir, archives, candidate, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
// The only fake is GitHub/HTTP custody, not the release state machine or hashing.
class Host implements ReleaseHost {
  remote: RemoteRelease | undefined;
  bytes = new Map<string, Buffer>();
  failAfterUpload = -1;
  uploads = 0;
  createLost = false;
  expired = false;
  creates = 0;
  publications = 0;
  missingAfterCreate = 0;
  missingAfterPublish = 0;
  finds = 0;
  async find() {
    this.finds++;
    if (this.remote?.draft && this.missingAfterCreate-- > 0) return undefined;
    if (this.remote && !this.remote.draft && this.missingAfterPublish-- > 0) return undefined;
    return this.remote ? structuredClone(this.remote) : undefined;
  }
  async create(tag: string, _producer: string, body: string) {
    this.creates++;
    this.remote = { id: 1, tag_name: tag, draft: true, prerelease: true, body, assets: [] };
    if (this.createLost) { this.createLost = false; throw new Error('lost create response'); }
  }
  async download(_tag: string, name: string, dest: string) {
    const bytes = this.bytes.get(name);
    if (!bytes) throw new Error('HTTP 404');
    await writeFile(join(dest, name), bytes);
  }
  async upload(_tag: string, path: string) {
    const name = basename(path);
    assert.equal(this.remote?.draft, true, 'partial releases remain invisible');
    assert.equal(this.bytes.has(name), false, 'never overwrite');
    this.bytes.set(name, await readFile(path));
    this.remote = { ...this.remote!, assets: [...this.remote!.assets, { name, id: this.bytes.size }] };
    if (++this.uploads === this.failAfterUpload) throw new Error('lost upload response');
  }
  async publish() {
    assert.deepEqual([...this.bytes.keys()].sort(), releaseFiles);
    this.publications++;
    this.remote = { ...this.remote!, draft: false };
  }
  async artifact() { return { expired: this.expired, digest: frozen.artifactDigest, runId: frozen.runId }; }
}

for (const lostAfter of [1, 2, 3, 4, 5, 6]) test(`resume same frozen candidate after upload ${lostAfter} response loss`, async () => {
  const f = await fixture(); const host = new Host();
  try {
    host.failAfterUpload = lostAfter;
    await assert.rejects(publishFrozen(host, f.candidate, frozen), /lost upload response/u);
    assert.equal(host.remote?.draft, true);
    host.failAfterUpload = -1;
    await publishFrozen(host, f.candidate, frozen);
    assert.equal(host.creates, 1);
    assert.equal(host.uploads, 6);
    assert.equal(host.remote?.draft, false);
    const before = host.uploads;
    await publishFrozen(host, f.candidate, frozen);
    assert.equal(host.uploads, before);
  } finally { await f.cleanup(); }
});
test('lost draft creation response recovers by original provenance', async () => {
  const f = await fixture(); const host = new Host();
  try {
    host.createLost = true;
    await assert.rejects(publishFrozen(host, f.candidate, frozen), /lost create response/u);
    await publishFrozen(host, f.candidate, frozen);
    assert.equal(host.creates, 1);
  } finally { await f.cleanup(); }
});
for (const phase of ['create', 'publish'] as const) {
  test(`briefly missing release after ${phase} is reread without repeating mutations`, async () => {
    const f = await fixture(); const host = new Host();
    try {
      if (phase === 'create') host.missingAfterCreate = 1;
      else host.missingAfterPublish = 1;
      await publishFrozen(host, f.candidate, frozen);
      assert.equal(host.finds, 5);
      assert.equal(host.creates, 1);
      assert.equal(host.uploads, 6);
      assert.equal(host.publications, 1);
      assert.equal(host.remote?.draft, false);
    } finally { await f.cleanup(); }
  });
  test(`persistently missing release after ${phase} fails within five reads and original candidate recovers`, async () => {
    const f = await fixture(); const host = new Host();
    try {
      if (phase === 'create') host.missingAfterCreate = Infinity;
      else host.missingAfterPublish = Infinity;
      await assert.rejects(publishFrozen(host, f.candidate, frozen), phase === 'create' ? /DraftCreationUncertain/u : /PublicationUncertain/u);
      assert.equal(host.finds, phase === 'create' ? 6 : 8);
      assert.equal(host.creates, 1);
      assert.equal(host.uploads, phase === 'create' ? 0 : 6);
      assert.equal(host.publications, phase === 'create' ? 0 : 1);
      host.missingAfterCreate = 0; host.missingAfterPublish = 0;
      await publishFrozen(host, f.candidate, frozen);
      await publishFrozen(host, f.candidate, frozen);
      assert.equal(host.creates, 1);
      assert.equal(host.uploads, 6);
      assert.equal(host.publications, 1);
    } finally { await f.cleanup(); }
  });
}
test('readback errors and conflicting provenance after creation fail without retrying mutations', async () => {
  const f = await fixture();
  try {
    for (const mode of ['error', 'conflict'] as const) {
      const host = new Host();
      if (mode === 'conflict') host.missingAfterCreate = 1;
      const find = host.find.bind(host);
      let readbacks = 0;
      host.find = async () => {
        if (host.creates > 0) readbacks++;
        if (host.creates > 0 && mode === 'error') throw new Error('readback HTTP 403');
        const remote = await find();
        return remote && mode === 'conflict' ? { ...remote, body: provenanceBody({ ...frozen, runId: '999' }) } : remote;
      };
      await assert.rejects(publishFrozen(host, f.candidate, frozen), mode === 'error' ? /readback HTTP 403/u : /DraftFrozenCandidateMismatch/u);
      assert.equal(readbacks, mode === 'error' ? 1 : 2);
      assert.equal(host.finds, mode === 'error' ? 1 : 3);
      assert.equal(host.creates, 1);
      assert.equal(host.uploads, 0);
      assert.equal(host.publications, 0);
    }
  } finally { await f.cleanup(); }
});
test('lost publication response is not retried and the original candidate reuses the public bytes', async () => {
  const f = await fixture(); const host = new Host();
  try {
    const publish = host.publish.bind(host);
    host.publish = async () => { await publish(); throw new Error('lost publish response'); };
    await assert.rejects(publishFrozen(host, f.candidate, frozen), /lost publish response/u);
    await publishFrozen(host, f.candidate, frozen);
    assert.equal(host.creates, 1);
    assert.equal(host.uploads, 6);
    assert.equal(host.publications, 1);
  } finally { await f.cleanup(); }
});
test('different run, missing provenance, expired artifact and conflicting assets fail closed', async () => {
  const f = await fixture();
  try {
    for (const mode of ['run', 'missing', 'expired', 'conflict', 'extra']) {
      const host = new Host();
      await host.create('hawdb-0.28.0', identity.producerCommit, provenanceBody(frozen));
      if (mode === 'run') host.remote = { ...host.remote!, body: provenanceBody({ ...frozen, runId: '999' }) };
      if (mode === 'missing') host.remote = { ...host.remote!, body: '' };
      if (mode === 'expired') host.expired = true;
      if (mode === 'conflict' || mode === 'extra') {
        const name = mode === 'extra' ? 'evil.sh' : releaseFiles[0]!;
        host.remote = { ...host.remote!, assets: [...host.remote!.assets, { name, id: 2 }] }; host.bytes.set(name, Buffer.from('different'));
      }
      await assert.rejects(publishFrozen(host, f.candidate, frozen), /DraftFrozenCandidateMismatch|DraftProvenanceMissing|FrozenArtifactExpired|ReleaseAssetConflict|DraftUnexpectedAssets/u);
      assert.equal(host.publications, 0);
      assert.equal(host.uploads, 0);
    }
  } finally { await f.cleanup(); }
});
test('public reuse validates all six bytes, archive contents and expected engine', async () => {
  const f = await fixture(); const host = new Host();
  try {
    await publishFrozen(host, f.candidate, frozen);
    await verifyPublic(host, host.remote!, identity.version, identity.revision);
    await assert.rejects(verifyPublic(host, host.remote!, identity.version, 'f'.repeat(40)), /IdentityMismatch/u);
    host.bytes.set('SHA256SUMS', Buffer.from('bad'));
    await assert.rejects(verifyPublic(host, host.remote!, identity.version, identity.revision), /ChecksumsMismatch/u);
  } finally { await f.cleanup(); }
});
test('archive refuses symlinks and extra roots before extracting any bytes', async () => {
  const f = await fixture();
  try {
    const input = join(f.dir, 'unsafe'), dest = join(f.dir, 'extract');
    await mkdir(join(input, 'linux-x64-glibc'), { recursive: true });
    await symlink('/tmp', join(input, 'linux-x64-glibc/link'));
    const archive = join(f.dir, 'unsafe.tar.gz');
    await tar.c({ file: archive, cwd: input, gzip: true }, ['linux-x64-glibc']);
    await assert.rejects(extractArchive(archive, dest, 'linux-x64-glibc'), /UnsafeArchive/u);
    await writeFile(join(input, 'other-root'), 'bad');
    await tar.c({ file: archive, cwd: input, gzip: true }, ['other-root']);
    await assert.rejects(extractArchive(archive, dest, 'linux-x64-glibc'), /UnsafeArchive/u);
  } finally { await f.cleanup(); }
});
test('normalized archive metadata is stable; payload mutation changes checksum', async () => {
  const f = await fixture();
  try {
    const c = combinations[0]!;
    const before = await shaFile(join(f.archives, c.name));
    const again = await pack(join(f.dir, c.name), join(f.dir, 'again'), c.target, c.testHooks);
    assert.equal(await shaFile(again), before);
    const binary = join(f.dir, c.name, c.target, 'hawdb.node');
    await writeFile(binary, 'changed');
    await assert.rejects(pack(join(f.dir, c.name), join(f.dir, 'bad'), c.target, c.testHooks), /DigestMismatch/u);
    await writeFile(join(f.candidate, 'extra'), 'not a release asset');
    await assert.rejects(validateReleaseDirectory(f.candidate), /FilesMismatch/u);
  } finally { await f.cleanup(); }
});

test('full workflow rerun refuses draft and names original publish; complete public version skips build', async () => {
  const f = await fixture(); const host = new Host();
  const selected = { version: identity.version, revision: identity.revision };
  try {
    assert.equal(await preflightRelease(host, selected), true);
    host.failAfterUpload = 2;
    await assert.rejects(publishFrozen(host, f.candidate, frozen), /lost upload response/u);
    await assert.rejects(preflightRelease(host, selected), /DraftRequiresOriginalPublish: rerun publish job of run 123, artifact 456/u);
    const draftReads = host.finds;
    assert.equal(await preflightRelease(host, selected, true), true);
    assert.equal(host.finds, draftReads, 'validation does not acquire or modify draft custody');
    assert.equal(host.uploads, 2);
    host.expired = true;
    await assert.rejects(preflightRelease(host, selected), /FrozenArtifactExpired: 456/u);
    host.expired = false; host.failAfterUpload = -1;
    await publishFrozen(host, f.candidate, frozen);
    assert.equal(await preflightRelease(host, selected), false);
    const publicReads = host.finds;
    assert.equal(await preflightRelease(host, selected, true), true);
    assert.equal(host.finds, publicReads, 'validation builds current sources instead of reusing published bytes');
    assert.equal(host.uploads, 6);
  } finally { await f.cleanup(); }
});
