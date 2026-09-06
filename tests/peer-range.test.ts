import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const DSH_SCOPE = '@deepseek-ai/'
/** The currently supported official DSH prerelease line (Issue #77). */
const SUPPORTED_DSH_LINE = '0.1.2-rc.1'
/** dsh-client-runtime has no newer published version yet; it stays on rc.2. */
const CLIENT_RUNTIME_PIN = '0.1.1-rc.2'

test('#77: every @deepseek-ai peer range accepts the devDependency the repo compiles against', () => {
  const peers = pkg.peerDependencies ?? {}
  const devs = pkg.devDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith(DSH_SCOPE)) continue
    const pinned = devs[name]
    assert.ok(pinned, `${name} must have a devDependency pin`)
    const compatible = semver.valid(pinned) !== null
      ? semver.satisfies(pinned, range)
      : semver.intersects(pinned, range)
    assert.equal(
      compatible,
      true,
      `${name}: pinned ${pinned} must satisfy/intersect the peer range "${range}"`,
    )
  }
})

test('#77: the currently supported DSH prerelease line is accepted by the peer ranges', () => {
  const peers = pkg.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith(DSH_SCOPE) || !name.startsWith(DSH_SCOPE + 'dsh-')) continue
    const supported = name === '@deepseek-ai/dsh-client-runtime' ? CLIENT_RUNTIME_PIN : SUPPORTED_DSH_LINE
    assert.equal(
      semver.satisfies(supported, range),
      true,
      `${name}: supported ${supported} must satisfy the peer range "${range}"`,
    )
  }
})
