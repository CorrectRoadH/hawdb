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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Effect, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
export const root = import.meta.dirname;
export const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
export const shaFile = async (path: string): Promise<string> => hash(await readFile(path));
export class ProducerFailed extends Schema.TaggedError<ProducerFailed>()('ProducerFailed', { detail: Schema.String }) {
  override get message(): string { return this.detail; }
}
export const failure = (error: unknown): ProducerFailed => new ProducerFailed({ detail: error instanceof Error ? error.message : String(error) });
export const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });
export const command = Effect.fn('producer.command')(function*(name: string, args: readonly string[], limit = 64 * 1024 * 1024) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(name, args, { cwd: root, stderr: 'inherit' }));
  let bytes = 0;
  const output = child.stdout.pipe(Stream.mapEffect(chunk => {
    bytes += chunk.byteLength;
    return bytes > limit ? Effect.fail(failure(`${name}: output limit`)) : Effect.succeed(chunk);
  }), Stream.decodeText(), Stream.mkString);
  const [text, code] = yield* Effect.all([output, child.exitCode], { concurrency: 'unbounded' });
  if (code !== 0) return yield* failure(`${name} exited ${code}`);
  return text;
}, Effect.scoped);
