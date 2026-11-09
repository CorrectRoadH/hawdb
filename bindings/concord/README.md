# Concord native binary producer

This independent, unpublished Cargo workspace and strict TypeScript/Effect package
own Concord's N-API bridge. Production Concord consumes released bytes and does
not contain Rust sources, build tools, or a Cargo fallback. This package is not a
production HawDB integration API and is not a member of the engine workspace.

The bridge preserves its declared ABI and table schema, parameterized SQL, namespace
and database budgets, atomic mutations, existing-only admission, original lock
inodes, and the full-handle coordination lease. The engine is canonical upstream
git, with version and revision owned by `crate/Cargo.toml` and default features
disabled. Toolchains, N-API dependencies and libc are selected by the runtime
version files, manifests and locks. Engine API drift
must fail compilation or behavioral acceptance; it is never assumed compatible.
Both read-only and writable opens explicitly select strict recovery; upstream
defaults cannot enable automatic WAL repair or prevent existing-only reads.

## Release ownership

The trusted `CorrectRoadH/hawdb` main workflow commit owns bridge code, dependency
pins, build/sign/archive recipes and the publishing program. The hourly
`release-binaries` workflow also supports a manual upstream semver, defaulting to
the latest official non-draft, non-prerelease release in `nowledge-co/hawdb`.
Only plain semver supported by `contract.ts` is admitted. Annotated tags are peeled to the
exact engine commit. Engine fetches use `nowledge-co/hawdb.git` directly, so
future releases do not depend on fork-network commit availability or overwriting
fork main. One Ubuntu preparation job updates the build copy's engine
pin and Rust identity, refreshes Cargo.lock, then freezes that copy for both
platforms. Subsequent metadata, lint and build operations use `--locked`.

The release tag is exactly `hawdb-<release version>`. A release version is the
official engine version with an optional `-concord.<positive integer>` bridge
revision. The manual `bridge_revision`
input defaults to `0` (no suffix); positive values have no leading zeroes.
Scheduled runs use no suffix. A bridge revision changes neither the selected
engine version nor its commit. Other prerelease suffixes and build metadata are
refused. Source and output hashes establish integrity and provenance; the full
release tag owns dependency and cache identity. Published tags and assets are
immutable; a bridge change uses a new revision, never replacement bytes.
Concord upgrades remain explicit dependency changes.

Manual runs may set `validate_only=true` to build the current producer against
the selected official engine even when that version already has a release.
This mode runs both platform and runtime matrices and freezes the six candidate
files as an Actions artifact; it never creates a tag, draft, or public release.
Existing release assets and draft recovery remain untouched. A validation
candidate is not an installable release pin and cannot replace published bytes.

The two platforms are Linux x64 glibc on Ubuntu 24.04 and macOS arm64 on macOS 15
with minimum deployment target 15.0. Each has production and test-hooks archives:

- `hawdb-linux-x64-glibc.tar.gz`
- `hawdb-linux-x64-glibc-test-hooks.tar.gz`
- `hawdb-darwin-arm64.tar.gz`
- `hawdb-darwin-arm64-test-hooks.tar.gz`

Each archive contains exactly one `<target>/` root, with `hawdb.node`, strict
`artifact.json`, `UPSTREAM.txt`, `HAWDB-LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` and
the complete collected `licenses/` tree. The notice trailer lists every license
file and its digest. Symlinks, hardlinks, special files, duplicate paths, path
traversal, extra roots and oversized unpacked payloads are refused before
extraction. Tar entries have sorted order and normalized ownership/timestamps;
gzip timestamps are zero. This does not claim reproducible Rust or signed bytes.

Both macOS modes are signed by this producer with an ad-hoc identity and checked
with `codesign --verify --strict`; their final signed bytes own the binary digest.
No stripping is applied because it may corrupt Mach-O LINKEDIT.
Production and hooks both record mandatory boolean `testHooks`; installation must
reject hooks. Portability describes linkage independently of test mode.

`native-release.json` has exactly the v1 fields encoded in `contract.ts`: fixed
repository, release version and matching tag, plain engineVersion, producer commit, engine
revision, ABI, source/lock digests and four target/mode assets with archive,
binary and notice digests. `SHA256SUMS` covers these four archives and the JSON.
There are exactly six release assets, with no executable publishing input in them.
Removing the optional bridge suffix from `version` must yield `engineVersion`.
The prepared identity records both fields; preparation receives engine version,
engine commit, producer commit and an optional release version in that order.
Only the engine version enters the Cargo dependency pin and upstream notice.
Preflight exports separate `version` and `engine_version` outputs; preparation,
freeze and publication bind both to the selected workflow inputs. A mismatched
engine/release pair fails before compiling or publishing.

## Source custody and immutable recovery

`prepare.ts` exports the explicit lexically sorted `sourceFiles` recipe list.
It covers bridge Rust, manifest, toolchain, upstream notices, build/sign/archive/
publication scripts, actual runtime versions, package/JS lock, TS configuration,
native acceptance code, shared Cargo profiles and workflow. Entries are hashed
as `relative path + NUL + bytes + NUL`; Cargo.lock is hashed independently.
Preparation computes this identity once. Both builds verify the same source and
lock bytes, and the publisher checks the candidate against the workflow's
preparation outputs and exact producer commit. Metadata never supplies a repo,
script, command, arbitrary path or release destination.

All jobs have `contents: read` and checkout without persisted credentials. Only
the publishing job has `contents: write`; it executes scripts checked out at the
fixed workflow commit. Build inputs cannot supply publishing code. The workflow
serializes scheduled and manual runs without cancellation.

Before any build, an existing public release must have all six expected assets,
correct SHA256SUMS, strict JSON, source/engine identity and fully verified archive
contents. It is reused without rebuilding. A draft blocks a full workflow rerun
and reports its original run/artifact; rerun **only the original publish job**.

The first candidate's complete six files are frozen in an immutable Actions
artifact (90-day retention). Draft metadata records original run ID, producer,
source digest, artifact ID and GitHub artifact digest. Publishing creates a draft
prerelease, compares every existing same-name asset without overwriting it,
appends only missing files, downloads and verifies all six remote assets, then
makes the prerelease public. Lost create/upload responses are recoverable by
rerunning the original publish job. After successful creation or publication,
an absent release-list result is reread up to five times total, one second apart.
Only reads are retried; read errors and visible identity conflicts fail immediately.
Persistent absence still requires recovery through the original publish job.
Unexpected assets, mismatched provenance or different bytes fail closed.
Expired/deleted original artifacts produce a named
failure; there is no automatic rebuild, replacement or invented version.

If the original artifact expires, maintainers must resolve the release incident
explicitly. Do not delete assets or rerun the build to try to reconstruct signed
bytes. No token, signing identity or upload capability is passed to build jobs.

## Local verification

### Asynchronous handle lifecycle

`native.openCache(path, readOnly, create): Promise<CacheBridge>` opens persistent
storage on the official N-API worker pool. `CacheBridge.closeAsync(): Promise<void>`
completes after database destruction and coordination-lease release. The existing
synchronous constructor, memory constructor and data methods retain their contracts.
During asynchronous close, valid data methods immediately fail with `HawdbClosed`;
they must not wait for worker-held state. GC of the JS shell does not cancel an
already submitted close. Normal open/close do database work off the event loop;
wrapping or submission failure cleanup may drain resources synchronously.

Open tasks retain custody until JS wrapping and successful handoff. Failed or
unhanded-off opens drain the shared handle, dropping the database before its
lease. Close submission failure similarly drains reachable shared state even if
the underlying task allocation is leaked. These guarantees concern database and
lease release; they do not claim to fix the pinned N-API dependency's allocation
leaks. Concord separately owns Effect scope cancellation, owner serialization and
the wrapper's shared close Promise.

### Commands and acceptance scope

Use the Node and Bun versions in this package's `.node-version` and `.bun-version`,
the pnpm version in `package.json`, and Rust from `crate/rust-toolchain.toml`.
Install this package's own locked dependencies; no Concord checkout or node_modules is used:

```sh
pnpm --dir bindings/concord install --frozen-lockfile --ignore-scripts
pnpm --dir bindings/concord typecheck
pnpm --dir bindings/concord test
cargo fmt --manifest-path bindings/concord/crate/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path bindings/concord/crate/Cargo.toml --workspace --all-targets --all-features -- -D warnings
```

To prepare the pinned version, use the actual trusted producer commit as the last
argument (the workflow provides it from `github.sha`):

```sh
node bindings/concord/prepare.ts <engine-version> <engine-commit> <producer-commit> <release-version>
node bindings/concord/build.ts /tmp/hawdb-production
node bindings/concord/archive.ts pack /tmp/hawdb-production /tmp/hawdb-archives linux-x64-glibc production
node bindings/concord/archive.ts extract /tmp/hawdb-archives/hawdb-linux-x64-glibc.tar.gz /tmp/hawdb-extracted linux-x64-glibc
NATIVE_ARTIFACT_ROOT=/tmp/hawdb-extracted NATIVE_TEST_HOOKS=0 node --test bindings/concord/tests/native.test.ts
NATIVE_ARTIFACT_ROOT=/tmp/hawdb-extracted NATIVE_TEST_HOOKS=0 bun test --no-env-file --config=/dev/null --timeout=300000 ./bindings/concord/tests/native.test.ts
```

Repeat with `build.ts ... --test-hooks`, `archive.ts pack ... hooks` and
`NATIVE_TEST_HOOKS=1`, using distinct build/extraction directories. On Darwin set
`MACOSX_DEPLOYMENT_TARGET=15.0` and use `darwin-arm64`. On NixOS, enter a GCC shell;
local Nix-linked bytes deliberately have `portable: false` and cannot be released.

Both modes load **the final extracted archive bytes** in Node and Bun. Production
proves native identity, durable reopen, parameterized data, quotas, atomic
validation failure, mode restrictions, checkpointing, cross-process ownership,
original inodes and unsafe-path refusal, including real async open, live-handle
handoff, durable data, async close and cross-process busy/reopen behavior.
Hook acceptance additionally proves
in-transaction rollback, SIGKILL/recovery and real raw/deferred owner/guard fences
before and after nested lock removal. Lifecycle children receive their hook
environment before startup; tests never change it while native work is running:

- `CONCORD_HAWDB_LIFECYCLE_WAIT=open|close`,
  `CONCORD_HAWDB_LIFECYCLE_READY=<path>` and
  `CONCORD_HAWDB_LIFECYCLE_RELEASE=<path>` pause the worker with its resource/lease
  acquired. At this barrier, a timer and TCP socket must run, valid closing-handle
  methods must report `HawdbClosed`, and another process must observe `HawdbBusy`.
  Explicit release must allow completion, guard acquisition and durable reopen.
  The native barrier has a 30-second failure ceiling; test deadlines detect hangs,
  and are not latency or throughput requirements.
- `CONCORD_HAWDB_LIFECYCLE_FAILURE=open-before-wrap|open-after-wrap|open-unsettled|close-submit-failure`
  proves same-process guard acquisition and reopen after custody cleanup, before
  process exit could release locks. `open-unsettled` simulates Task destruction
  before handoff and may return a closed JS shell. It does not trigger a real
  N-API settlement failure. `close-submit-failure` deliberately forgets the Task
  to model a failed submission allocation leak; the JS entry still drains the
  database and lease before reporting the named failure. These staged hooks do
  not prove all actual N-API wrapping/settlement/submission error paths.
- Closing-shell GC uses Node's `--expose-gc` or Bun's collector when available,
  reports `GC COLLECTED` only after a WeakRef proves collection while close remains
  pending, and then proves the lease survives until release. `GC UNAVAILABLE`
  explicitly records a runtime without a collector; it is not GC evidence.

For Concord's consumer runtime, replay both extracted modes with the Bun version
in Concord's `.bun-version` as well; the producer's selected Bun remains an
independent acceptance lane.
Tests require an explicit mode, validate
the artifact and its license tree, and never silently skip native acceptance.
Process-kill tests prove atomic process recovery, not hardware power-loss safety.
Concord separately owns its full consumer suite, old-cache upgrade/rebuild,
installation/download behavior and product gates.

`tests/release.test.ts` uses real normalized archives and hashes, with only the
GitHub custody boundary faked. It covers lost responses at creation and each of
six uploads, idempotent public reuse, conflicting bytes, wrong run/provenance,
artifact expiry, strict mode/manifest shape and unsafe archive rejection. Neither
local verification nor these tests publish anything.

See [test-family ownership](../../docs/TEST_INDEX.md). Actual macOS, portable Linux,
GitHub runner timing and remote publish/recovery acceptance require the authorized
release workflow; local Nix verification does not establish those outcomes.
