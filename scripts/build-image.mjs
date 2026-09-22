import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const image = process.argv[2] ?? `numen:${version}`
if (process.argv.length > 3 || image.startsWith('-') || !image.endsWith(`:${version}`)) {
  throw new Error(`Usage: pnpm image:build [repository:${version}]`)
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
// Local candidates remain useful, but must not claim to match an unchanged commit.
const sourceRevision = `${revision}${dirty ? '-dirty' : ''}`
execFileSync('docker', [
  'build', '--tag', image,
  '--build-arg', `NUMEN_VERSION=${version}`,
  '--build-arg', `NUMEN_REVISION=${sourceRevision}`,
  '--build-arg', `NUMEN_SOURCE=${process.env.NUMEN_SOURCE ?? ''}`,
  '.',
], { cwd: root, stdio: 'inherit' })
console.log(`Built ${image} from ${sourceRevision}. Run pnpm image:smoke ${image} before publishing.`)
