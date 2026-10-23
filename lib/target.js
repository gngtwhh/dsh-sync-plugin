/**
 * 同步目标抽象：Git 远端 或 共享目录（Syncthing / OneDrive / 坚果云等）。
 *
 * 两种目标共用同一套「镜像目录 + index.json」约定：
 *   <目标根>/
 *     index.json          上一次发布时的文件指纹表
 *     manifest.json       设备、时间、规模摘要
 *     storages/workspace.json
 *     sessions/<工作区>/<会话>/session.*.jsonl.zstd
 * 因此恢复 = 复制回 ~/.dsh，查看 = 直接浏览目录。
 *
 * Git 目标不依赖 merge：每次同步都把远端 reset 成本地基线，再叠加本机快照后
 * 生成一个线性快照提交。这样永远快进推送，也不会产生 Git 冲突文件。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertInside, fingerprint, pathExists, readJson, writeAtomic, walkFiles } from './store.js'

const run = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
const IDENT = ['-c', 'user.name=DSH Sync', '-c', 'user.email=dsh-sync@localhost', '-c', 'core.autocrlf=false']

/** 执行一条 git 命令；失败时抛出带 stderr 的错误。 */
async function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await run('git', [...IDENT, ...args], {
      cwd,
      env: GIT_ENV,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (error) {
    if (allowFailure) return undefined
    const stderr = String(error.stderr ?? error.message ?? '').trim()
    throw new Error(`git ${args.join(' ')} 失败：${stderr || '未知错误'}`)
  }
}

/** 远端分支是否已存在。 */
async function remoteBranchExists(target) {
  const out = await git(target.workDir, ['ls-remote', '--heads', 'origin', target.branch], {
    allowFailure: true,
  })
  return typeof out === 'string' && out.trim().length > 0
}

/** 远端根目录：Git 为工作树，目录目标为其自身。 */
export function remoteRoot(target) {
  return target.kind === 'git' ? target.workDir : target.dir
}

/** 准备工作目录 / 远端仓库。 */
export async function prepare(target) {
  if (target.kind === 'directory') {
    await fs.mkdir(target.dir, { recursive: true })
    return
  }
  await fs.mkdir(target.workDir, { recursive: true })
  if (!(await pathExists(path.join(target.workDir, '.git')))) {
    await git(target.workDir, ['init', '-q', '-b', target.branch])
    await git(target.workDir, ['config', 'core.autocrlf', 'false'])
  }
  const remotes = (await git(target.workDir, ['remote'], { allowFailure: true })) ?? ''
  if (!remotes.split(/\r?\n/).includes('origin')) {
    await git(target.workDir, ['remote', 'add', 'origin', target.remote])
  } else {
    await git(target.workDir, ['remote', 'set-url', 'origin', target.remote])
  }
}

/** 把远端状态取到本地工作树（Git：fetch + reset --hard）。 */
export async function refreshRemote(target) {
  if (target.kind === 'directory') return { fetched: false, reason: 'directory' }
  if (!(await remoteBranchExists(target))) return { fetched: false, reason: 'empty-remote' }
  await git(target.workDir, ['fetch', '--depth', '1', '--quiet', 'origin', target.branch])
  await git(target.workDir, ['reset', '--hard', '--quiet', 'FETCH_HEAD'])
  return { fetched: true }
}

function parseIndex(doc) {
  const files = new Map()
  if (!doc || typeof doc !== 'object' || !doc.files || typeof doc.files !== 'object') return files
  for (const [rel, info] of Object.entries(doc.files)) {
    if (!info || typeof info !== 'object') continue
    const size = Number(info.size)
    const sha1 = typeof info.sha1 === 'string' ? info.sha1 : undefined
    if (!Number.isFinite(size) || sha1 === undefined) continue
    files.set(rel.replace(/\\/g, '/'), { size, sha1 })
  }
  return files
}

/** 读取远端 index.json；缺失时回退为扫描远端目录。 */
export async function readRemoteIndex(target) {
  const root = remoteRoot(target)
  const doc = await readJson(path.join(root, 'index.json'), undefined)
  if (doc) return { files: parseIndex(doc), scanned: false }
  const files = new Map()
  for (const rootDir of ['sessions', 'attachments']) {
    for (const rel of await walkFiles(path.join(root, rootDir), '')) {
      const key = `${rootDir}/${rel}`
      try {
        const info = await fingerprint(path.join(root, key))
        files.set(key, { size: info.size, sha1: info.sha1 })
      } catch {
        /* 忽略读取失败的文件 */
      }
    }
  }
  const workspace = path.join(root, 'storages/workspace.json')
  if (await pathExists(workspace)) {
    const info = await fingerprint(workspace)
    files.set('storages/workspace.json', { size: info.size, sha1: info.sha1 })
  }
  return { files, scanned: true }
}

/** 读取远端 manifest（规模与时间摘要）。 */
export async function readManifest(target) {
  return readJson(path.join(remoteRoot(target), 'manifest.json'), undefined)
}

/** 把一份内容写进远端镜像目录。 */
export async function writeRemoteFile(target, rel, data) {
  const root = remoteRoot(target)
  await writeAtomic(assertInside(root, rel), data)
}

/** 读取远端某文件。 */
export async function readRemoteFile(target, rel) {
  return fs.readFile(assertInside(remoteRoot(target), rel))
}

/**
 * 发布远端：写 index/manifest，Git 目标再提交并推送。
 * @param {object} target
 * @param {{files: Map<string,{size:number,sha1:string}>, device: string, summary: object, message: string}} input
 * @returns {Promise<{committed: boolean, pushed: boolean}>}
 */
export async function publishRemote(target, input) {
  const root = remoteRoot(target)
  const indexDoc = {
    format: 1,
    updatedAt: new Date().toISOString(),
    device: input.device,
    counts: input.summary,
    files: Object.fromEntries(input.files),
  }
  const manifest = {
    format: 1,
    generator: '@local/dsh-sync',
    updatedAt: indexDoc.updatedAt,
    device: input.device,
    counts: input.summary,
  }
  await writeAtomic(path.join(root, 'index.json'), `${JSON.stringify(indexDoc, null, 2)}\n`)
  await writeAtomic(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await ensureReadme(root)

  if (target.kind === 'directory') return { committed: false, pushed: false }

  await git(root, ['add', '-A', '--', '.'])
  const staged = await git(root, ['diff', '--cached', '--name-only'])
  if (staged.trim().length === 0) return { committed: false, pushed: false }
  await git(root, ['commit', '-q', '-m', input.message])
  await git(root, ['push', '--quiet', 'origin', `HEAD:refs/heads/${target.branch}`])
  return { committed: true, pushed: true }
}

const README = `# DSH 备份仓库

本仓库由 DeepSeek Harness 的 dsh-sync 插件自动维护，请勿手工编辑。

- \`storages/workspace.json\`：工作区登记（工作区列表、会话归属、归档与置顶）。
- \`sessions/\`：会话事件日志（追加写，一台设备同一时刻只写一个会话）。
- \`index.json\`：上一次发布时的文件指纹，用于增量对比。
- \`manifest.json\`：发布设备、时间与规模摘要。

恢复：在另一台设备安装 dsh-sync，把同一远端填入配置，执行「拉取」即可。
注意：工作区目录路径需要在该设备上同样存在，会话才会归入对应工作区。
`

async function ensureReadme(root) {
  const file = path.join(root, 'README.md')
  if (await pathExists(file)) return
  await writeAtomic(file, README)
}

/** 目标的可读描述。 */
export function describeTarget(target) {
  if (target.kind === 'git') return `${target.remote} (${target.branch})`
  return target.dir
}
