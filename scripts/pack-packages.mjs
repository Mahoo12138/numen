import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts/npm')
await mkdir(output, { recursive: true })
const packages = []
for (const directory of await readdir(join(root, 'packages'))) {
  const path = join(root, 'packages', directory)
  let manifest
  try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  packages.push({ path, manifest })
}
const byName = new Map(packages.map(item => [item.manifest.name, item]))
const artifacts = []
for (const { path, manifest } of packages.filter(item => !item.manifest.private)) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (byName.get(name)?.manifest.private) throw new Error(`${manifest.name} depends on unpublished private package ${name}`)
    }
  }
  execFileSync('pnpm', ['pack', '--pack-destination', output], { cwd: path, stdio: 'inherit' })
  const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  const data = await readFile(join(output, filename))
  const packed = JSON.parse(execFileSync('tar', ['-xOf', join(output, filename), 'package/package.json'], { encoding: 'utf8' }))
  if (JSON.stringify(packed).includes('workspace:')) throw new Error(`${manifest.name} still has workspace dependencies`)
  const entries = execFileSync('tar', ['-tzf', join(output, filename)], { encoding: 'utf8' }).split('\n')
  if (entries.some(file => /(?:\.tsx?$|\.jsx$|\.tsbuildinfo$|\/tests\/)/.test(file) && !file.endsWith('.d.ts'))) {
    throw new Error(`${manifest.name} contains uncompiled or private files`)
  }
  const targets = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(targets)
  for (const target of targets(packed.exports ?? {})) {
    if (!entries.includes(`package/${target.replace(/^\.\//, '')}`)) throw new Error(`${manifest.name}: missing export ${target}`)
  }
  artifacts.push({ name: manifest.name, version: manifest.version, filename, sha256: createHash('sha256').update(data).digest('hex') })
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(artifacts, null, 2) + '\n')
console.log(`Verified ${artifacts.length} npm archives in ${output}`)
