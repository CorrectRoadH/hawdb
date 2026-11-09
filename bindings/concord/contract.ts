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

import { Schema } from 'effect';
export const repository = 'CorrectRoadH/hawdb';
export const upstream = 'nowledge-co/hawdb';
export const abi = 'concord-hawdb-1';
export const targets = ['linux-x64-glibc', 'darwin-arm64'] as const;
export type Target = typeof targets[number];
export const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
export const versionSchema = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/u));
export const releaseVersionSchema = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-concord\.[1-9]\d*)?(?![\s\S])/u));
export function stableVersion(value: string): string {
  const v = Schema.decodeUnknownSync(versionSchema)(value);
  const [major, minor] = v.split('.').map(Number);
  if (major === 0 && minor! < 28) throw new Error('UpstreamVersionUnsupported: minimum is 0.28.0');
  return v;
}
export function engineVersionOf(value: string): string {
  const version = Schema.decodeUnknownSync(releaseVersionSchema)(value);
  return stableVersion(version.split('-concord.')[0]!);
}
export function nativeVersion(engineVersion: string, bridgeRevision = '0'): string {
  const engine = stableVersion(engineVersion);
  const bridge = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)(?![\s\S])/u)))(bridgeRevision);
  return bridge === '0' ? engine : `${engine}-concord.${bridge}`;
}
export const ArtifactSchema = Schema.Struct({
  target: Schema.Literals(targets), abi: Schema.Literal(abi), revision,
  sourceDigest: digest, cargoLockDigest: digest, binarySha256: digest, noticesSha256: digest,
  portable: Schema.Boolean, testHooks: Schema.Boolean, deploymentTarget: Schema.optional(Schema.Literal('15.0')),
});
export type Artifact = Schema.Schema.Type<typeof ArtifactSchema>;
export const decodeArtifact = Schema.decodeUnknownSync(ArtifactSchema, { onExcessProperty: 'error' });
export const assetName = (target: Target, hooks: boolean): string => `hawdb-${target}${hooks ? '-test-hooks' : ''}.tar.gz`;
export const combinations = targets.flatMap(target => [false, true].map(testHooks => ({ target, testHooks, name: assetName(target, testHooks) })));
export const releaseFiles = [...combinations.map(x => x.name), 'native-release.json', 'SHA256SUMS'].sort();
const AssetSchema = Schema.Struct({ target: Schema.Literals(targets), testHooks: Schema.Boolean, name: Schema.String, archiveSha256: digest, binarySha256: digest, noticesSha256: digest });
export const ReleaseSchema = Schema.Struct({
  format: Schema.Literal('concord.native-release/v1'), repository: Schema.Literal(repository), version: releaseVersionSchema,
  tag: Schema.String, producerCommit: revision, engineVersion: versionSchema, revision, abi: Schema.Literal(abi),
  sourceDigest: digest, cargoLockDigest: digest, assets: Schema.Array(AssetSchema),
});
export type Release = Schema.Schema.Type<typeof ReleaseSchema>;
export function decodeRelease(value: unknown): Release {
  const r = Schema.decodeUnknownSync(ReleaseSchema, { onExcessProperty: 'error' })(value);
  if (r.engineVersion !== engineVersionOf(r.version) || r.tag !== `hawdb-${r.version}` || r.assets.length !== 4) throw new Error('ReleaseIdentityMismatch');
  for (const c of combinations) if (r.assets.filter(a => a.target === c.target && a.testHooks === c.testHooks && a.name === c.name).length !== 1) throw new Error('ReleaseAssetsMismatch');
  return r;
}
export const IdentitySchema = Schema.Struct({ version: releaseVersionSchema, engineVersion: versionSchema, revision, producerCommit: revision, sourceDigest: digest, cargoLockDigest: digest });
export type Identity = Schema.Schema.Type<typeof IdentitySchema>;
export function decodeIdentity(value: unknown): Identity {
  const identity = Schema.decodeUnknownSync(IdentitySchema, { onExcessProperty: 'error' })(value);
  if (identity.engineVersion !== engineVersionOf(identity.version)) throw new Error('PreparedEngineVersionMismatch');
  return identity;
}
