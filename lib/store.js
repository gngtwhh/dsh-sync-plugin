/**
 * 备份集合的本地读写：路径解析、文件枚举、内容指纹、原子写入。
 * 只同步「会话日志 + 工作区登记」两处真相来源；派生的 session_projcache、
 * 缓存、附件与凭据默认不进入备份集合。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 工作区登记（工作区列表、会话归属、归档/置顶集合）。 */
export const WORKSPACE_REL = 'storages/workspace.json'
/** 会话日志根目录，内部按工作区 key / 会话 id 分层。 */
export const SESSIONS_DIR = 'sessions'

const HASH_CACHE_LIMIT = 4096
const hashCache = new Map()

/** 是否存在该路径。 */
export async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 读取 JSON，失败返回 undefined。 */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写入文本/二进制：同目录临时文件 + rename，避免半截文件。 */
export async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

/** 递归枚举目录下的普通文件，返回相对路径（posix 分隔符）。 */
export async function walkFiles(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walkFiles(root, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** 单个文件的内容指纹；按 (size, mtime) 记忆，避免重复读大文件。 */
export async function fingerprint(abs) {
  const stat = await fs.stat(abs)
  const cached = hashCache.get(abs)
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached
  const data = await fs.readFile(abs)
  const record = {
    size: data.length,
    mtimeMs: stat.mtimeMs,
    sha1: createHash('sha1').update(data).digest('hex'),
  }
  if (hashCache.size > HASH_CACHE_LIMIT) hashCache.clear()
  hashCache.set(abs, record)
  return record
}

/** 文件是否为另一个文件的前缀（追加写判定）。 */
export function isPrefix(short, long) {
  if (short.length > long.length) return false
  return short.equals(long.subarray(0, short.length))
}

/**
 * 扫描本机备份集合。
 * @param {{home: string, includeAttachments?: boolean, includeSettings?: boolean}} config
 * @returns {Promise<Map<string, {size: number, sha1: string}>>} 相对 home 的 posix 路径 → 指纹
 */
export async function scanLocal(config) {
  const files = new Map()
  const roots = [SESSIONS_DIR]
  if (config.includeAttachments) roots.push('attachments')
  for (const root of roots) {
    for (const rel of await walkFiles(path.join(config.home, root), '')) {
      const key = `${root}/${rel}`
      try {
        const info = await fingerprint(path.join(config.home, key))
        files.set(key, { size: info.size, sha1: info.sha1 })
      } catch {
        /* 文件在扫描过程中被移动/删除：忽略，下次同步再处理 */
      }
    }
  }
  const workspace = path.join(config.home, WORKSPACE_REL)
  if (await pathExists(workspace)) {
    const info = await fingerprint(workspace)
    files.set(WORKSPACE_REL, { size: info.size, sha1: info.sha1 })
  }
  if (config.includeSettings) {
    for (const rel of ['settings.yaml']) {
      const abs = path.join(config.home, rel)
      if (!(await pathExists(abs))) continue
      const info = await fingerprint(abs)
      files.set(rel, { size: info.size, sha1: info.sha1 })
    }
  }
  return files
}

/** 拒绝越界路径，防止备份/恢复写到 home 之外。 */
export function assertInside(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('备份条目路径为空')
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`拒绝绝对路径: ${rel}`)
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '' || part === '.')) throw new Error(`拒绝可疑路径: ${rel}`)
  const abs = path.resolve(root, normalized)
  const base = path.resolve(root)
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`拒绝越界路径: ${rel}`)
  return abs
}

/** 统计文件数量与总字节数。 */
export function summarize(files) {
  let bytes = 0
  for (const info of files.values()) bytes += info.size
  return { files: files.size, bytes }
}

/** 计算集合的稳定摘要，用于判断登记文件是否真的变化。 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input)
    if (seen.has(input)) throw new Error('循环引用')
    seen.add(input)
    if (Array.isArray(input)) return `[${input.map(walk).join(',')}]`
    const keys = Object.keys(input).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${walk(input[key])}`).join(',')}}`
  }
  return walk(value)
}

/** 人类可读的字节数。 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}
