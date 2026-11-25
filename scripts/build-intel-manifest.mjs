/**
 * 生成 `intel/manifest.json`：给运行期同步用的"数据身份卡"。
 *
 * 插件同步时只认这张卡：版本、构建时间、sha256、体积。对不上就不换。
 * 每次重建底库后必须重跑本脚本，否则云端的卡和库不一致，同步会一直报 sha256 不符。
 *
 * **卡描述的是随包/喂给同步的那份文件本身**：
 *   现在随包的是原始 SQLite（构建时 `cve.slim.db` → 包内 `intel/cve.db`），
 *   所以 `file` 写 `cve.db`、sha256 和体积都按未压缩字节算。
 *   镜像端要么照样放原始 `.db`，要么放同名 `.gz` —— 运行期按 gzip 魔数自动识别，
 *   两种都不会认错（见 intel-sync.js 的 `isGzip`）。
 *
 * 用法：
 *   node scripts/build-intel-manifest.mjs                 # 描述 intel/cve.slim.db（随包那份）
 *   node scripts/build-intel-manifest.mjs --file x.db     # 指定源
 *   node scripts/build-intel-manifest.mjs --gz            # 描述 intel/cve.db.gz（旧压缩布局）
 *   node scripts/build-intel-manifest.mjs --print         # 只打印，不写盘
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INTEL = path.join(ROOT, 'intel')
const OUT = path.join(INTEL, 'manifest.json')
const printOnly = process.argv.includes('--print')
const argv = process.argv.slice(2)
const fileAt = argv.indexOf('--file')

/* 默认描述**随包那份**（slim 原始库）；--gz 回到旧的 cve.db.gz 布局。
   注意 `file` 记的是**发布名**不是构建产物名：slim-cve-db 产出 cve.slim.db，
   build-dist 把它放进包内 `intel/cve.db`；镜像端照这个名放，运行期才拼得对 URL。 */
const SRC = fileAt >= 0
  ? path.resolve(argv[fileAt + 1])
  : path.join(INTEL, argv.includes('--gz') ? 'cve.db.gz' : 'cve.slim.db')
const SHIPPED_NAME = argv.includes('--gz') ? 'cve.db.gz' : 'cve.db'

if (!fs.existsSync(SRC)) {
  console.error('缺少 ' + path.relative(ROOT, SRC) + '（先跑 node scripts/build-cve-db.mjs / slim-cve-db.mjs）')
  process.exit(1)
}

const bytes = fs.readFileSync(SRC)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

/* 从库里读 meta，而不是从文件名 / 上一条记录猜 —— 卡必须和库本身一致 */
async function readMeta() {
  if (!isGzip) {
    const db = new DatabaseSync(SRC, { readOnly: true })
    try {
      const out = {}
      for (const row of db.prepare('SELECT key, value FROM meta').all()) out[row.key] = row.value
      return out
    } finally { try { db.close() } catch { /* ignore */ } }
  }
  const tmp = path.join(INTEL, '.manifest-probe.db')
  try {
    await pipeline(fs.createReadStream(SRC), createGunzip(), fs.createWriteStream(tmp))
    const db = new DatabaseSync(tmp, { readOnly: true })
    try {
      const out = {}
      for (const row of db.prepare('SELECT key, value FROM meta').all()) out[row.key] = row.value
      return out
    } finally { try { db.close() } catch { /* ignore */ } }
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

const meta = await readMeta()
const sources = (() => {
  try { return JSON.parse(meta.sources || '{}') } catch { return {} }
})()

const manifest = {
  /* 让运行期能判断"这张卡配不配得上当前代码" */
  version: Number(meta.version) || 0,
  built_at: Number(meta.built_at) || 0,
  file: SHIPPED_NAME,
  size: bytes.length,
  sha256,
  gzip: isGzip,
  slim: meta.slim === '1',
  sources,
}

const text = JSON.stringify(manifest, null, 2) + '\n'
if (printOnly) {
  process.stdout.write(text)
} else {
  fs.writeFileSync(OUT, text)
  console.log('intel/manifest.json 已写入')
  console.log('  file      ' + manifest.file + (manifest.gzip ? '（gzip）' : '（原始 SQLite）'))
  console.log('  version   ' + manifest.version)
  console.log('  built_at  ' + manifest.built_at + '  (' + new Date(manifest.built_at).toISOString() + ')')
  console.log('  size      ' + (manifest.size / 1048576).toFixed(1) + ' MB')
  console.log('  sha256    ' + sha256)
  console.log('  rows      ' + (sources.rows ?? '?') + ' | EXP ' + (sources.exploitdb ?? '?')
    + ' | PoC-GH ' + (sources.poc_github ?? '?') + ' | 模板 ' + (sources.nuclei_templates ?? '?'))
}
