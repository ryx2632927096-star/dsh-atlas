import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPatches } from '../lib/patches/patches.js'

const emptyRoot = mkdtempSync(join(process.env.ATLAS_TEST_ROOT || tmpdir(), 'atlas-package-'))
const bundled = realpathSync(fileURLToPath(new URL('../patches/known-patches.json', import.meta.url)))
const patches = loadPatches(emptyRoot)
const expected = ['liangshen-burst', 'snowluma-windowshide', 'surfcore-health', 'surfcore-setup', 'surfcore-snowluma-lock', 'surfcore-whitelist']
assert.deepEqual(patches.map(patch => patch.id).sort(), expected)
for (const patch of patches) {
  assert.equal(realpathSync(patch._file), bundled)
  assert.ok(patch.target && patch.marker)
}
console.log('Verified six packaged patch definitions')
