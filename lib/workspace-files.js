/**
 * 工作区目录文件枚举。
 *
 * 优先使用 Git：工作区本身是 Git 仓库时，用 `git ls-files --cached --others --exclude-standard`
 * 得到「已跟踪 + 未忽略的未跟踪」文件，天然遵守 .gitignore，也不会把 .git/node_modules 带上。
 * 不是 Git 仓库时退化为目录遍历 + 内置排除表 + 用户 ignore 规则。
 *
 * 无论哪种方式都会应用：单文件大小上限、文件总数上限、符号链接跳过。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 不随备份走的重目录（仅在非 Git 遍历时生效）。 */
const HARD_EXCLUDES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  'coverage',
  '.idea',
  '.DS_Store',
])

function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
        if (pattern[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.+()[]{}|'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  out += '$'
  return new RegExp(out)
}

/** 编译用户 ignore 规则；目录形式（以 / 结尾）匹配其下所有内容。 */
export function compileIgnores(patterns) {
  const list = Array.isArray(patterns) ? patterns.filter((item) => typeof item === 'string' && item.trim()) : []
  const matchers = list.map((raw) => {
    const pattern = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (pattern.endsWith('/')) {
      const base = globToRegExp(pattern.slice(0, -1))
      const prefix = base.source.replace(/\$$/, '')
      return new RegExp(`${prefix}(/.*)?$`)
    }
    return globToRegExp(pattern)
  })
  return (rel) => matchers.some((matcher) => matcher.test(rel))
}

/** Git 仓库内的文件清单；失败返回 undefined 由调用方回退。 */
async function gitFiles(root) {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    )
    const seen = new Set()
    return stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .filter((entry) => {
        if (seen.has(entry)) return false
        seen.add(entry)
        return true
      })
  } catch {
    return undefined
  }
}

async function walkFiles(root, dirRel, ignored, out, limit) {
  const dirAbs = dirRel ? path.join(root, dirRel) : root
  let entries
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= limit) return
    if (entry.isSymbolicLink()) continue
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
    const abs = path.join(root, rel)
    if (entry.isDirectory()) {
      if (HARD_EXCLUDES.has(entry.name)) continue
      if (ignored(rel) || ignored(`${rel}/`)) continue
      await walkFiles(root, rel, ignored, out, limit)
    } else if (entry.isFile()) {
      if (ignored(rel)) continue
      out.push({ rel, abs })
    }
  }
}

/**
 * 列出一个工作区里应当备份的文件。
 * @param {{path: string, title?: string}} workspace
 * @param {{ignore?: string[], maxFileBytes?: number, maxFiles?: number}} options
 * @returns {Promise<{files: Array<{rel: string, abs: string, size: number}>, skipped: {large: number, count: number}, total: number}>}
 */
export async function listWorkspaceFiles(workspace, options = {}) {
  const root = typeof workspace.path === 'string' ? workspace.path : ''
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 4 * 1024 * 1024
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 20000
  const ignored = compileIgnores(options.ignore)
  const result = { files: [], skipped: { large: 0, count: 0 }, total: 0 }

  let stat
  try {
    stat = await fs.stat(root)
  } catch {
    return result
  }
  if (!stat.isDirectory()) return result

  let relatives
  if (await hasGit(root)) relatives = await gitFiles(root)
  if (relatives === undefined) {
    const found = []
    await walkFiles(root, '', ignored, found, maxFiles * 2)
    relatives = found.map((entry) => entry.rel)
  }

  for (const rel of relatives) {
    if (result.files.length >= maxFiles) {
      result.skipped.count = relatives.length - result.files.length
      break
    }
    if (ignored(rel)) continue
    const abs = path.join(root, rel)
    let info
    try {
      info = await fs.lstat(abs)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    if (info.size > maxFileBytes) {
      result.skipped.large += 1
      continue
    }
    result.files.push({ rel: rel.replace(/\\/g, '/'), abs, size: info.size })
  }
  result.total = relatives.length
  return result
}

async function hasGit(root) {
  try {
    const info = await fs.stat(path.join(root, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}
