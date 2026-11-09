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

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { Effect, Schema } from 'effect';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { decodeRelease, releaseFiles, repository, stableVersion, nativeVersion, upstream, revision as revisionSchema, digest as digestSchema, type Release } from './contract.ts';
import { validateReleaseDirectory } from './archive.ts';
import { attempt, command, shaFile } from './io.ts';

const RemoteReleaseSchema = Schema.Struct({ id: Schema.Number, tag_name: Schema.String, draft: Schema.Boolean, prerelease: Schema.Boolean, body: Schema.NullOr(Schema.String), assets: Schema.Array(Schema.Struct({ name: Schema.String, id: Schema.Number })) });
export type RemoteRelease = Schema.Schema.Type<typeof RemoteReleaseSchema>;
export interface Frozen { runId: string; artifactId: string; artifactDigest: string; producerCommit: string; sourceDigest: string }
export interface ReleaseHost {
  find(tag: string): Promise<RemoteRelease | undefined>;
  create(tag: string, producer: string, body: string): Promise<void>;
  download(tag: string, name: string, dest: string): Promise<void>;
  upload(tag: string, path: string): Promise<void>;
  publish(tag: string): Promise<void>;
  artifact(id: string): Promise<{ expired: boolean; digest: string; runId: string }>;
}
async function findAfterMutation(host: ReleaseHost, tag: string): Promise<RemoteRelease | undefined> {
  // GitHub's release list may briefly omit a successful create or publication.
  // Retry only absence, never an error, conflicting identity, or the mutation.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await setTimeout(1000);
    const remote = await host.find(tag);
    if (remote) return remote;
  }
  return undefined;
}
export const provenanceBody = (f: Frozen): string => `Concord native binaries. Frozen candidate; do not replace assets.\n\n<!-- concord-frozen/v1\n${JSON.stringify(f)}\n-->\n`;
export function parseProvenance(body: string | null): Frozen {
  const match = body?.match(/<!-- concord-frozen\/v1\n([^\n]+)\n-->/u);
  if (!match) throw new Error('DraftProvenanceMissing: restore original release metadata manually');
  const schema = Schema.Struct({ runId: Schema.String.check(Schema.isPattern(/^\d+$/u)), artifactId: Schema.String.check(Schema.isPattern(/^\d+$/u)), artifactDigest: digestSchema, producerCommit: revisionSchema, sourceDigest: digestSchema });
  return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(JSON.parse(match[1]!));
}
export async function verifyPublic(host: ReleaseHost, remote: RemoteRelease, expectedVersion: string, expectedRevision: string): Promise<Release> {
  if (remote.draft || !remote.prerelease || remote.tag_name !== `hawdb-${expectedVersion}` || JSON.stringify(remote.assets.map(a => a.name).sort()) !== JSON.stringify(releaseFiles)) throw new Error('PublishedReleaseIncomplete');
  const temp = await mkdtemp(join(tmpdir(), 'hawdb-public-'));
  try {
    for (const name of releaseFiles) await host.download(remote.tag_name, name, temp);
    const release = await validateReleaseDirectory(temp);
    if (release.version !== expectedVersion || release.revision !== expectedRevision) throw new Error('PublishedReleaseIdentityMismatch');
    return release;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function preflightRelease(host: ReleaseHost, selected: { version: string; revision: string }, validateOnly = false): Promise<boolean> {
  if (validateOnly) return true;
  const remote = await host.find(`hawdb-${selected.version}`);
  if (remote?.draft) {
    const f = parseProvenance(remote.body);
    const a = await host.artifact(f.artifactId);
    if (a.expired) throw new Error(`FrozenArtifactExpired: ${f.artifactId}; original run ${f.runId}; do not rebuild`);
    if (a.runId !== f.runId || a.digest !== f.artifactDigest) throw new Error('FrozenArtifactIdentityMismatch');
    throw new Error(`DraftRequiresOriginalPublish: rerun publish job of run ${f.runId}, artifact ${f.artifactId}; full workflow rebuild refused`);
  }
  if (remote) await verifyPublic(host, remote, selected.version, selected.revision);
  return !remote;
}
export async function publishFrozen(host: ReleaseHost, directory: string, frozen: Frozen): Promise<void> {
  const r = await validateReleaseDirectory(directory);
  // Validate provenance with the same strict decoder used for recovered drafts.
  parseProvenance(provenanceBody(frozen));
  if (r.producerCommit !== frozen.producerCommit || r.sourceDigest !== frozen.sourceDigest) throw new Error('CandidateProvenanceMismatch');
  const artifact = await host.artifact(frozen.artifactId);
  if (artifact.expired) throw new Error(`FrozenArtifactExpired: ${frozen.artifactId}; cannot rebuild this version`);
  if (artifact.runId !== frozen.runId || artifact.digest !== frozen.artifactDigest) throw new Error('FrozenArtifactIdentityMismatch');
  let remote = await host.find(r.tag);
  if (remote && !remote.draft) {
    const published = await verifyPublic(host, remote, r.version, r.revision);
    if (JSON.stringify(published) !== JSON.stringify(r)) throw new Error('PublishedReleaseConflict');
    return;
  }
  if (!remote) {
    // If the create response is lost, the next invocation finds the draft.
    await host.create(r.tag, r.producerCommit, provenanceBody(frozen));
    remote = await findAfterMutation(host, r.tag);
    if (!remote) throw new Error('DraftCreationUncertain: rerun original publish job');
  }
  if (JSON.stringify(parseProvenance(remote.body)) !== JSON.stringify(frozen)) throw new Error('DraftFrozenCandidateMismatch: rerun original publish job');
  const existing = remote.assets.map(a => a.name);
  if (new Set(existing).size !== existing.length || existing.some(name => !releaseFiles.includes(name))) throw new Error('DraftUnexpectedAssets');
  const temp = await mkdtemp(join(tmpdir(), 'hawdb-upload-'));
  try {
    for (const name of releaseFiles) {
      if (existing.includes(name)) {
        await host.download(r.tag, name, temp);
        if (await shaFile(join(temp, name)) !== await shaFile(join(directory, name))) throw new Error(`ReleaseAssetConflict: ${name}; never overwritten`);
      } else await host.upload(r.tag, join(directory, name));
    }
    const final = await host.find(r.tag);
    if (!final || !final.draft || JSON.stringify(parseProvenance(final.body)) !== JSON.stringify(frozen) || JSON.stringify(final.assets.map(a => a.name).sort()) !== JSON.stringify(releaseFiles)) throw new Error('DraftFinalInventoryMismatch');
    // Confirm remote bytes after *all* uploads, including newly added assets.
    for (const name of releaseFiles) {
      await rm(join(temp, name), { force: true });
      await host.download(r.tag, name, temp);
      if (await shaFile(join(temp, name)) !== await shaFile(join(directory, name))) throw new Error(`ReleaseAssetConflict: ${name}`);
    }
    await host.publish(r.tag);
    const published = await findAfterMutation(host, r.tag);
    if (!published) throw new Error('PublicationUncertain');
    await verifyPublic(host, published, r.version, r.revision);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
const run = (name: string, args: readonly string[]) => Effect.runPromise(command(name, args).pipe(Effect.provide(NodeServices.layer)));
const gh = (args: readonly string[]) => run('gh', args);
const api = async (path: string): Promise<unknown> => JSON.parse(await gh(['api', path]));
const listReleases = async (repo: string): Promise<RemoteRelease[]> => {
  const pages = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])) as unknown;
  return Schema.decodeUnknownSync(Schema.Array(Schema.Array(RemoteReleaseSchema)), { onExcessProperty: 'ignore' })(pages).flat();
};
export const githubHost: ReleaseHost = {
  async find(tag) { return (await listReleases(repository)).find(r => r.tag_name === tag); },
  async create(tag, producer, body) {
    const temp = await mkdtemp(join(tmpdir(), 'hawdb-body-'));
    try {
      const file = join(temp, 'body.md'); await writeFile(file, body);
      await gh(['release', 'create', tag, '--repo', repository, '--target', producer, '--title', tag, '--draft', '--prerelease', '--notes-file', file]);
    } finally { await rm(temp, { recursive: true, force: true }); }
  },
  async download(tag, name, dest) { await gh(['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', dest]); },
  async upload(tag, path) { await gh(['release', 'upload', tag, path, '--repo', repository]); },
  async publish(tag) { await gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease']); },
  async artifact(id) {
    let value: unknown;
    try { value = await api(`repos/${repository}/actions/artifacts/${id}`); }
    catch { throw new Error(`FrozenArtifactUnavailable: ${id}; expired or deleted; do not rebuild this version`); }
    const a = Schema.decodeUnknownSync(Schema.Struct({ expired: Schema.Boolean, digest: Schema.NullOr(Schema.String), workflow_run: Schema.Struct({ id: Schema.Number }) }), { onExcessProperty: 'ignore' })(value);
    return { expired: a.expired, digest: (a.digest ?? '').replace(/^sha256:/u, ''), runId: String(a.workflow_run.id) };
  },
};
export interface UpstreamHost { releases(): Promise<RemoteRelease[]>; object(path: string): Promise<unknown> }
const upstreamHost: UpstreamHost = { releases: () => listReleases(upstream), object: api };
export async function selectUpstream(requested: string | undefined, host: UpstreamHost = upstreamHost): Promise<{ version: string; revision: string }> {
  const releases = (await host.releases()).filter(r => !r.draft && !r.prerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(r.tag_name));
  const selected = requested ? releases.find(r => r.tag_name.replace(/^v/u, '') === stableVersion(requested)) : releases.sort((a, b) => {
    const av = a.tag_name.replace(/^v/u, '').split('.').map(BigInt), bv = b.tag_name.replace(/^v/u, '').split('.').map(BigInt);
    for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i]! > bv[i]! ? -1 : 1;
    return 0;
  })[0];
  if (!selected) throw new Error('UpstreamStableReleaseMissing');
  const version = stableVersion(selected.tag_name.replace(/^v/u, ''));
  const objectSchema = Schema.Struct({ object: Schema.Struct({ type: Schema.String, sha: revisionSchema }) });
  let object = Schema.decodeUnknownSync(objectSchema, { onExcessProperty: 'ignore' })(await host.object(`repos/${upstream}/git/ref/tags/${selected.tag_name}`)).object;
  for (let i = 0; object.type === 'tag' && i < 8; i++) object = Schema.decodeUnknownSync(objectSchema, { onExcessProperty: 'ignore' })(await host.object(`repos/${upstream}/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit') throw new Error('UpstreamTagNotCommit');
  return { version, revision: object.sha };
}
if (import.meta.main) {
  const main = attempt(async () => {
    if (process.argv[2] === 'preflight') {
      const selected = await selectUpstream(process.env.UPSTREAM_VERSION || undefined);
      const version = nativeVersion(selected.version, process.env.BRIDGE_REVISION ?? '0');
      const mode = Schema.decodeUnknownSync(Schema.Literals(['true', 'false']))(process.env.VALIDATE_ONLY ?? 'false');
      const build = await preflightRelease(githubHost, { ...selected, version }, mode === 'true');
      if (!process.env.GITHUB_OUTPUT) throw new Error('GitHubOutputMissing');
      await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nengine_version=${selected.version}\nrevision=${selected.revision}\nbuild=${build ? 'true' : 'false'}\n`);
    } else if (process.argv[2] === 'check-frozen') {
      const id = process.env.FROZEN_ARTIFACT_ID ?? '';
      if (!/^\d+$/u.test(id)) throw new Error('FrozenArtifactIdMissing');
      const a = await githubHost.artifact(id);
      if (a.expired) throw new Error(`FrozenArtifactExpired: ${id}; cannot rebuild this version`);
      if (a.runId !== process.env.GITHUB_RUN_ID || a.digest !== (process.env.FROZEN_ARTIFACT_DIGEST ?? '').replace(/^sha256:/u, '')) throw new Error('FrozenArtifactIdentityMismatch');
    } else if (process.argv[2] === 'publish') {
      const directory = resolve(process.argv[3] ?? 'candidate');
      const release = decodeRelease(JSON.parse(await readFile(join(directory, 'native-release.json'), 'utf8')));
      for (const [field, variable] of [['version', 'EXPECTED_VERSION'], ['engineVersion', 'EXPECTED_ENGINE_VERSION'], ['revision', 'EXPECTED_REVISION'], ['producerCommit', 'EXPECTED_PRODUCER_COMMIT'], ['sourceDigest', 'EXPECTED_SOURCE_DIGEST'], ['cargoLockDigest', 'EXPECTED_CARGO_LOCK_DIGEST']] as const) {
        if (!process.env[variable] || release[field] !== process.env[variable]) throw new Error(`CandidateWorkflowIdentityMismatch: ${field}`);
      }
      await publishFrozen(githubHost, directory, {
        runId: process.env.GITHUB_RUN_ID ?? '', artifactId: process.env.FROZEN_ARTIFACT_ID ?? '',
        artifactDigest: (process.env.FROZEN_ARTIFACT_DIGEST ?? '').replace(/^sha256:/u, ''), producerCommit: release.producerCommit, sourceDigest: release.sourceDigest,
      });
    } else throw new Error('Usage: release.ts preflight|check-frozen|publish [candidate]');
  });
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
