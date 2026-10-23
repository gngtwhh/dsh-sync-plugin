/**
 * 同步引擎：把本机的会话日志、工作区登记（可选：工作区目录文件）与一个远端镜像双向对齐。
 *
 * 设计要点：
 *  - 会话日志是单写者追加写，按文件对比，两个版本互为前缀时取更长的一份。
 *  - 工作区登记是唯一需要语义合并的文件，交给 registry.js。
 *  - 工作区目录文件走三方合并（本机 / 远端 / 上次同步基线），两边都改才判冲突，
 *    冲突保留本机版本，远端版本写进仓库的 conflicts/ 目录，任何设备都能取回。
 *  - Git 目标只做线性快照提交（先 reset 到远端，再叠加本机内容），永远不会产生
 *    Git 冲突或非快进推送；共享目录目标用同样的镜像布局，便于 Syncthing/云盘搬运。
 *  - 所有写盘都是「临时文件 + rename」，中途失败不会留下半截 JSON。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeRegistry } from './registry.js'
import {
  SESSIONS_DIR,
  WORKSPACE_REL,
  assertInside,
  humanBytes,
  isPrefix,
  pathExists,
  readJson,
  stableStringify,
  writeAtomic,
} from './store.js'
import { listWorkspaceFiles } from './workspace-files.js'
import {
  describeTarget,
  prepare,
  publishRemote,
  readManifest,
  readRemoteIndex,
  refreshRemote,
  remoteRoot,
  writeRemoteFile,
} from './target.js'
import { buildZip, readZip } from './zip.js'

const STAMP = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

/** 同步层级。 */
export const SCOPES = ['sessions', 'workspace', 'full']

export const SCOPE_LABELS = {
  sessions: '仅会话历史（含工作区登记）',
  workspace: '会话 + 工作区目录文件',
  full: '全部（会话 + 工作区文件 + 附件 + 设置）',
}

/** 自动同步策略。 */
export const AUTO_MODES = ['off', 'interval', 'idle', 'startup']

/** DSH 数据根目录：$DSH_HOME 优先，否则 ~/.dsh。 */
export function defaultHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** 展开 ~ 与 ~/ 前缀。 */
export function expandHome(input) {
  if (typeof input !== 'string') return ''
  const text = input.trim()
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

function sanitizeName(input) {
  const cleaned = String(input ?? '')
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'dsh-sync'
}

/**
 * 归一化插件配置。
 * @param {any} raw cordis.patch.yml 或设置页写入的 config
 * @param {{home?: string, device?: string}} [options]
 */
export function resolveConfig(raw = {}, options = {}) {
  const home = path.resolve(expandHome(options.home) || defaultHome())
  const device =
    (typeof options.device === 'string' && options.device.trim()) ||
    (typeof raw.deviceName === 'string' && raw.deviceName.trim()) ||
    os.hostname() ||
    'unknown-device'
  const targetRaw = raw && typeof raw.target === 'object' && raw.target !== null ? raw.target : {}
  const kind = targetRaw.kind === 'directory' ? 'directory' : 'git'
  const remote = typeof targetRaw.remote === 'string' ? targetRaw.remote.trim() : ''
  const branch =
    typeof targetRaw.branch === 'string' && targetRaw.branch.trim().length > 0 ? targetRaw.branch.trim() : 'main'
  const dir = expandHome(typeof targetRaw.path === 'string' ? targetRaw.path : '')

  const scope = SCOPES.includes(raw.scope)
    ? raw.scope
    : raw.includeAttachments === true || raw.includeSettings === true
      ? 'full'
      : 'sessions'

  const autoRaw = raw.autoSync && typeof raw.autoSync === 'object' ? raw.autoSync : {}
  const legacyMinutes = Number.isFinite(Number(raw.autosyncMinutes)) ? Number(raw.autosyncMinutes) : 0
  const autoMode = AUTO_MODES.includes(autoRaw.mode)
    ? autoRaw.mode
    : legacyMinutes > 0
      ? 'interval'
      : 'off'
  const autoMinutes = Math.min(
    1440,
    Math.max(1, Math.round(Number(autoRaw.minutes) || legacyMinutes || 15)),
  )

  const name = sanitizeName(raw && raw.name ? raw.name : kind === 'git' ? remote.split('/').pop() : path.basename(dir))
  const workDir = path.resolve(expandHome(raw && raw.workDir ? raw.workDir : path.join(home, 'sync', name)))
  const backupDir = path.resolve(expandHome(raw && raw.backupDir ? raw.backupDir : path.join(home, 'backups')))

  return {
    home,
    device,
    name,
    kind,
    remote,
    branch,
    dir,
    workDir,
    backupDir,
    scope,
    ignore: Array.isArray(raw.ignore) ? raw.ignore : [],
    maxFileBytes: Number(raw.maxFileBytes) > 0 ? Number(raw.maxFileBytes) : 4 * 1024 * 1024,
    maxFiles: Number(raw.maxFiles) > 0 ? Math.round(Number(raw.maxFiles)) : 20000,
    autoSync: { mode: autoMode, minutes: autoMinutes },
    propagateDeletions: raw.propagateDeletions === true,
    includeAttachments: scope === 'full',
    includeSettings: scope === 'full',
    key: `${kind}|${kind === 'git' ? `${remote}#${branch}` : dir}|${scope}`,
    target: { kind, remote, branch, dir, workDir },
  }
}

function hashBuffer(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

function countSessions(files) {
  const ids = new Set()
  for (const rel of files.keys()) {
    const parts = rel.split('/')
    if (parts[0] !== SESSIONS_DIR || parts.length < 4) continue
    ids.add(parts[2])
  }
  return ids.size
}

function summarizeBy(files, predicate) {
  let count = 0
  let bytes = 0
  for (const [rel, info] of files) {
    if (!predicate(rel, info)) continue
    count += 1
    bytes += info.size ?? 0
  }
  return { count, bytes }
}

/**
 * 收集本机应当备份的文件。
 * @returns {Promise<Map<string, {size: number, sha1: string, kind: string, workspaceId?: string, abs?: string}>>}
 */
async function collectLocal(cfg) {
  const files = new Map()
  const add = async (rel, kind, abs, workspaceId) => {
    const data = await fs.readFile(abs)
    files.set(rel, { size: data.length, sha1: hashBuffer(data), kind, workspaceId, abs })
  }

  for (const rel of await walkRelative(path.join(cfg.home, SESSIONS_DIR))) {
    try {
      await add(`${SESSIONS_DIR}/${rel}`, 'session', path.join(cfg.home, SESSIONS_DIR, rel))
    } catch {
      /* 扫描期间被删除 */
    }
  }

  const workspaceFile = path.join(cfg.home, WORKSPACE_REL)
  if (await pathExists(workspaceFile)) await add(WORKSPACE_REL, 'registry', workspaceFile)

  if (cfg.scope !== 'sessions') {
    const doc = await readJson(workspaceFile, undefined)
    const workspaces = (doc && doc.tables && doc.tables.workspaces) || {}
    for (const [id, workspace] of Object.entries(workspaces)) {
      if (!workspace || typeof workspace.path !== 'string') continue
      const listing = await listWorkspaceFiles(workspace, cfg)
      for (const file of listing.files) {
        try {
          const data = await fs.readFile(file.abs)
          files.set(`workspaces/${id}/${file.rel}`, {
            size: data.length,
            sha1: hashBuffer(data),
            kind: 'file',
            workspaceId: id,
            abs: file.abs,
          })
        } catch {
          /* 忽略读取失败的文件 */
        }
      }
    }
  }

  if (cfg.includeAttachments) {
    for (const rel of await walkRelative(path.join(cfg.home, 'attachments'))) {
      try {
        await add(`attachments/${rel}`, 'attachment', path.join(cfg.home, 'attachments', rel))
      } catch {
        /* ignore */
      }
    }
  }
  if (cfg.includeSettings) {
    const settings = path.join(cfg.home, 'settings.yaml')
    if (await pathExists(settings)) await add('settings.yaml', 'settings', settings)
  }
  return files
}

async function walkRelative(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walkRelative(root, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** 相对路径是否安全（无空段、无 ..、无盘符、无绝对路径）。 */
function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  return !rel.split('/').some((part) => part === '' || part === '..' || part === '.')
}

/** 远端相对路径 → 本机绝对路径；工作区目录不存在或路径越界时返回 undefined。 */
function makeResolver(cfg, workspacePaths) {
  return (rel) => {
    if (!isSafeRel(rel)) return undefined
    if (rel.startsWith('workspaces/')) {
      const parts = rel.split('/')
      const id = parts[1]
      const rest = parts.slice(2)
      const root = workspacePaths.get(id)
      if (typeof root !== 'string' || root.length === 0) return undefined
      if (rest.length === 0) return undefined
      return path.join(root, ...rest)
    }
    return path.join(cfg.home, rel)
  }
}

async function workspacePathsFrom(cfg) {
  const doc = await readJson(path.join(cfg.home, WORKSPACE_REL), undefined)
  const map = new Map()
  const workspaces = (doc && doc.tables && doc.tables.workspaces) || {}
  for (const [id, workspace] of Object.entries(workspaces)) {
    if (workspace && typeof workspace.path === 'string') map.set(id, workspace.path)
  }
  return map
}

export class SyncEngine {
  /**
   * @param {ReturnType<typeof resolveConfig>} config
   * @param {{log?: (message: string) => void}} [hooks]
   */
  constructor(config, hooks = {}) {
    this.config = config
    this.log = hooks.log ?? (() => {})
    this.queue = Promise.resolve()
  }

  /** 串行化所有会写盘的同步操作。 */
  exclusive(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  get stateFile() {
    return path.join(this.config.home, 'sync', 'state.json')
  }

  async readState() {
    const doc = await readJson(this.stateFile, undefined)
    const entry = doc && doc.targets ? doc.targets[this.config.key] : undefined
    return entry && typeof entry === 'object' ? entry : {}
  }

  async writeState(patch) {
    const doc = (await readJson(this.stateFile, undefined)) ?? { version: 1, targets: {} }
    if (!doc.targets || typeof doc.targets !== 'object') doc.targets = {}
    doc.version = 1
    doc.targets[this.config.key] = { ...(doc.targets[this.config.key] ?? {}), ...patch }
    await writeAtomic(this.stateFile, `${JSON.stringify(doc, null, 2)}\n`)
  }

  describeTarget() {
    return describeTarget(this.config.target)
  }

  /**
   * 会话目录的轻量活动指纹（只 stat，不读内容）：文件数 + 总字节 + 最新 mtime。
   * 「空闲后同步」策略用它判断是否还有新活动，避免每次轮询都哈希全部文件。
   */
  async activityFingerprint() {
    const root = path.join(this.config.home, SESSIONS_DIR)
    let count = 0
    let bytes = 0
    let latest = 0
    const walk = async (dir) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await fs.stat(abs)
          count += 1
          bytes += info.size
          if (info.mtimeMs > latest) latest = info.mtimeMs
        } catch {
          /* ignore */
        }
      }
    }
    await walk(root)
    return `${count}:${bytes}:${Math.round(latest)}`
  }

  /** 当前层级的可读描述。 */
  scopeSummary() {
    const cfg = this.config
    const parts = ['会话日志', '工作区登记']
    if (cfg.scope !== 'sessions') parts.push('工作区文件')
    if (cfg.scope === 'full') parts.push('附件', '设置')
    return parts.join(' + ')
  }

  /**
   * 读取当前状态；refresh=true 时会访问一次远端。
   * @param {{refresh?: boolean}} [options]
   */
  async status(options = {}) {
    const cfg = this.config
    const local = await collectLocal(cfg)
    const sessions = summarizeBy(local, (rel) => rel.startsWith(`${SESSIONS_DIR}/`))
    const workspaceFiles = summarizeBy(local, (rel) => rel.startsWith('workspaces/'))
    const attachments = summarizeBy(local, (rel) => rel.startsWith('attachments/'))
    const state = await this.readState()
    const result = {
      target: {
        kind: cfg.kind,
        description: cfg.kind === 'git' ? `${cfg.remote || '（未配置远端）'}` : cfg.dir || '（未配置目录）',
        branch: cfg.kind === 'git' ? cfg.branch : undefined,
        workDir: cfg.workDir,
      },
      scope: cfg.scope,
      scopeLabel: SCOPE_LABELS[cfg.scope],
      scopeSummary: this.scopeSummary(),
      autoSync: cfg.autoSync,
      device: cfg.device,
      home: cfg.home,
      local: {
        sessions: countSessions(local),
        files: local.size,
        bytes: summarizeBy(local, () => true).bytes,
        bytesText: humanBytes(summarizeBy(local, () => true).bytes),
        workspaceFiles: workspaceFiles.count,
        workspaceBytesText: humanBytes(workspaceFiles.bytes),
        attachments: attachments.count,
      },
      lastSyncAt: state.lastSyncAt ?? null,
      lastPushAt: state.lastPushAt ?? null,
      lastPullAt: state.lastPullAt ?? null,
      lastError: state.lastError ?? null,
      lastReport: state.lastReport ?? null,
      pending: null,
      remote: null,
      warnings: [],
      ready: cfg.kind === 'git' ? cfg.remote.length > 0 : cfg.dir.length > 0,
    }
    if (!result.ready) {
      result.warnings.push('尚未配置同步目标，请填写 Git 远端或共享目录。')
      return result
    }
    try {
      await prepare(cfg.target)
      if (options.refresh) await refreshRemote(cfg.target)
      const remoteView = await readRemoteIndex(cfg.target)
      const remoteIndex = remoteView.files
      const base = (await this.readState()).base ?? {}
      const plan = planSync(cfg, local, remoteIndex, base)
      result.pending = {
        toPush: plan.pushes.size,
        toPull: plan.pulls.length,
        conflicts: plan.conflicts.length,
        known: true,
      }
      const manifest = await readManifest(cfg.target)
      result.remote = manifest
        ? {
            updatedAt: manifest.updatedAt ?? null,
            device: manifest.device ?? null,
            files: manifest.counts?.files ?? null,
            bytesText: manifest.counts ? humanBytes(manifest.counts.bytes ?? 0) : null,
            sessions: manifest.counts?.sessions ?? null,
            workspaceFiles: manifest.counts?.workspaceFiles ?? null,
            scope: manifest.scope ?? null,
          }
        : null
    } catch (error) {
      result.pending = { toPush: null, toPull: null, conflicts: 0, known: false }
      result.warnings.push(String(error.message ?? error))
    }
    return result
  }

  /**
   * 双向同步。
   * @param {{mode?: 'pull'|'push', signal?: AbortSignal}} [options]
   */
  async sync(options = {}) {
    const mode = options.mode === 'pull' ? 'pull' : 'push'
    const signal = options.signal
    return this.exclusive(async () => {
      const cfg = this.config
      if (!(cfg.kind === 'git' ? cfg.remote : cfg.dir)) {
        throw new Error('尚未配置同步目标，请在插件配置中填写 target.remote 或 target.path。')
      }
      const startedAt = Date.now()
      await prepare(cfg.target)
      const refresh = await refreshRemote(cfg.target)
      throwIfAborted(signal)

      const root = remoteRoot(cfg.target)
      const remoteView = await readRemoteIndex(cfg.target)
      const remoteIndex = remoteView.files
      const localIndex = await collectLocal(cfg)
      const state = await this.readState()
      const base = state.base ?? {}
      const plan = planSync(cfg, localIndex, remoteIndex, base)

      const report = {
        mode,
        target: this.describeTarget(),
        scope: cfg.scope,
        pulled: { files: 0, bytes: 0 },
        pushed: { files: 0, bytes: 0 },
        conflicts: [],
        skipped: [],
        deleted: [],
        workspace: { workspaces: 0, sessions: 0, changed: false },
        remote: { fetched: refresh.fetched, committed: false, pushed: false },
        at: new Date().toISOString(),
        durationMs: 0,
      }

      // 1) 工作区登记先合并，工作区文件的目标路径依赖它
      const workspace = await this.#mergeWorkspace(root)
      report.workspace = workspace.report
      throwIfAborted(signal)

      // 2) 远端独有 / 远端更新的文件 → 本机
      const workspacePaths = await workspacePathsFrom(cfg)
      const resolveLocal = makeResolver(cfg, workspacePaths)
      const pulls = [...plan.pulls, ...plan.pullWins]
      for (const rel of pulls) {
        const target = resolveLocal(rel)
        if (!target) {
          report.skipped.push({ path: rel, reason: '工作区目录在本机不存在' })
          continue
        }
        const data = await fs.readFile(assertInside(root, rel))
        await writeAtomic(target, data)
        report.pulled.files += 1
        report.pulled.bytes += data.length
      }
      throwIfAborted(signal)

      // 3) 追加写前缀判定（会话 / 附件等内容寻址文件）
      for (const rel of plan.prefix) {
        const localEntry = localIndex.get(rel)
        const remoteEntry = remoteIndex.get(rel)
        if (!localEntry || !remoteEntry) continue
        const target = resolveLocal(rel)
        if (!target) continue
        const localBuf = await fs.readFile(target)
        const remoteBuf = await fs.readFile(assertInside(root, rel))
        if (isPrefix(localBuf, remoteBuf)) {
          await writeAtomic(target, remoteBuf)
          report.pulled.files += 1
          report.pulled.bytes += remoteBuf.length - localBuf.length
        } else if (isPrefix(remoteBuf, localBuf)) {
          plan.pushes.add(rel)
        } else {
          const saved = await this.#saveConflict(rel, remoteBuf)
          plan.pushes.add(rel)
          report.conflicts.push({ path: rel, savedTo: saved })
        }
      }
      throwIfAborted(signal)

      // 4) 冲突：保留本机，远端版本写进仓库 conflicts/，双方都能取回
      const stamp = STAMP()
      for (const rel of plan.conflicts) {
        const remoteBuf = await fs.readFile(assertInside(root, rel))
        const relPath = `conflicts/${stamp}/${rel}`
        if (mode === 'push') {
          await writeRemoteFile(cfg.target, relPath, remoteBuf)
          plan.publishedExtras.set(relPath, { size: remoteBuf.length, sha1: hashBuffer(remoteBuf) })
        }
        const saved = await this.#saveConflict(rel, remoteBuf)
        plan.pushes.add(rel)
        report.conflicts.push({ path: rel, savedTo: saved, preservedAs: relPath })
      }

      // 5) 删除：仅在显式开启「传播删除」时移除远端镜像里的文件
      const deletes = []
      if (cfg.propagateDeletions) {
        for (const [rel, sha1] of Object.entries(base)) {
          if (!rel.startsWith('workspaces/')) continue
          if (localIndex.has(rel) || remoteIndex.get(rel)?.sha1 !== sha1) continue
          deletes.push(rel)
        }
      }

      // 5) 发布本机内容
      let published
      if (mode === 'push') {
        published = new Map(remoteIndex)
        for (const [rel, info] of plan.publishedExtras) published.set(rel, info)
        for (const rel of plan.pushes) {
          const target = resolveLocal(rel)
          if (!target) {
            report.skipped.push({ path: rel, reason: '工作区目录在本机不存在' })
            continue
          }
          const data = await fs.readFile(target)
          await writeRemoteFile(cfg.target, rel, data)
          published.set(rel, { size: data.length, sha1: hashBuffer(data) })
          report.pushed.files += 1
          report.pushed.bytes += data.length
        }
        if (workspace.publish) {
          const text = workspace.text
          await writeRemoteFile(cfg.target, WORKSPACE_REL, text)
          published.set(WORKSPACE_REL, { size: Buffer.byteLength(text), sha1: hashBuffer(Buffer.from(text)) })
          report.pushed.files += 1
          report.pushed.bytes += Buffer.byteLength(text)
        }
        for (const rel of deletes) {
          const abs = assertInside(root, rel)
          await fs.rm(abs, { force: true })
          published.delete(rel)
          report.deleted.push(rel)
        }
        if (report.pushed.files > 0 || report.deleted.length > 0) {
          const summary = {
            ...summarizeBy(published, () => true),
            files: published.size,
            sessions: countSessions(published),
            workspaceFiles: summarizeBy(published, (rel) => rel.startsWith('workspaces/')).count,
          }
          const result = await publishRemote(cfg.target, {
            files: published,
            device: cfg.device,
            summary,
            scope: cfg.scope,
            message: `sync(${cfg.device}, ${cfg.scope}): ${report.pushed.files} 个文件变更`,
          })
          report.remote.committed = result.committed
          report.remote.pushed = result.pushed
        }
      }

      // 6) 记录本次同步基线（仅工作区文件需要三方比较）。
      //    只有本机与远端当前一致的文件才成为基线；冲突期间保持旧基线，下次继续提示。
      const finalRemote = published ?? remoteIndex
      const baseNext = {}
      for (const [rel, remoteEntry] of finalRemote) {
        if (!rel.startsWith('workspaces/')) continue
        const localEntry = localIndex.get(rel)
        if (localEntry) {
          if (localEntry.sha1 === remoteEntry.sha1) baseNext[rel] = remoteEntry.sha1
          else if (base[rel] !== undefined) baseNext[rel] = base[rel]
        } else {
          // 本次刚拉取（或本机没有该工作区目录）：以远端为准
          baseNext[rel] = remoteEntry.sha1
        }
      }
      for (const rel of Object.keys(base)) {
        if (rel.startsWith('workspaces/') && !baseNext[rel]) delete baseNext[rel]
      }

      report.durationMs = Date.now() - startedAt
      const patch = {
        lastSyncAt: report.at,
        lastError: null,
        lastReport: compactReport(report),
        device: cfg.device,
        base: baseNext,
      }
      if (mode === 'push') patch.lastPushAt = report.at
      else patch.lastPullAt = report.at
      await this.writeState(patch)
      return report
    })
  }

  /**
   * 导出一个可搬运的备份 zip。
   * @returns {Promise<{file: string, files: number, bytes: number}>}
   */
  async backup() {
    return this.exclusive(() => this.#backup())
  }

  /** backup 的实现体，供 restore 在已持锁时复用。 */
  async #backup() {
    const cfg = this.config
    const index = await collectLocal(cfg)
    const entries = []
    for (const rel of [...index.keys()].sort()) {
      const entry = index.get(rel)
      const abs = entry.abs ?? path.join(cfg.home, rel)
      const data = await fs.readFile(abs)
      entries.push({ name: rel, data })
    }
    entries.push({
      name: 'sync-manifest.json',
      data: Buffer.from(
        JSON.stringify(
          {
            format: 2,
            generator: '@local/dsh-sync',
            device: cfg.device,
            scope: cfg.scope,
            createdAt: new Date().toISOString(),
            files: entries.length,
            bytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
          },
          null,
          2,
        ),
      ),
    })
    const zip = buildZip(entries)
    const file = path.join(cfg.backupDir, `dsh-backup-${STAMP()}.zip`)
    await writeAtomic(file, zip)
    return { file, files: entries.length, bytes: zip.length, bytesText: humanBytes(zip.length) }
  }

  /**
   * 从备份 zip 恢复；恢复前会自动生成一份当前状态的备份。
   * @param {{file: string}} request
   */
  async restore(request) {
    return this.exclusive(async () => {
      const cfg = this.config
      const file = path.resolve(expandHome(request?.file ?? ''))
      if (!(await pathExists(file))) throw new Error(`备份文件不存在：${file}`)
      const entries = readZip(await fs.readFile(file))
      const pre = await this.#backup()
      const workspacePaths = await workspacePathsFrom(cfg)
      const resolveLocal = makeResolver(cfg, workspacePaths)
      const report = {
        file,
        preRestoreBackup: pre.file,
        files: 0,
        bytes: 0,
        skipped: [],
        conflicts: [],
        workspace: { workspaces: 0, sessions: 0, changed: false },
      }
      let workspaceText
      for (const entry of entries) {
        const name = entry.name.replace(/\\/g, '/')
        if (name === 'sync-manifest.json') continue
        if (name === WORKSPACE_REL) {
          workspaceText = entry.data.toString('utf8')
          continue
        }
        if (!isRestorable(name)) {
          report.skipped.push(name)
          continue
        }
        const target = resolveLocal(name)
        if (!target) {
          report.skipped.push(`${name}（工作区目录不存在）`)
          continue
        }
        if (await pathExists(target)) {
          const current = await fs.readFile(target)
          if (current.equals(entry.data)) continue
          if (isPrefix(current, entry.data)) {
            report.skipped.push(name)
            continue
          }
          if (!isPrefix(entry.data, current)) {
            const saved = await this.#saveConflict(name, current)
            report.conflicts.push({ path: name, savedTo: saved })
          }
        }
        await writeAtomic(target, entry.data)
        report.files += 1
        report.bytes += entry.data.length
      }
      if (workspaceText !== undefined) {
        const restored = JSON.parse(workspaceText)
        const current = await readJson(path.join(cfg.home, WORKSPACE_REL), undefined)
        const merged = mergeRegistry(current, restored)
        const before = current ? stableStringify(current) : ''
        const after = stableStringify(merged)
        if (after !== before) {
          await writeAtomic(path.join(cfg.home, WORKSPACE_REL), `${JSON.stringify(merged, null, 2)}\n`)
          report.workspace.changed = true
        }
        report.workspace.workspaces = Object.keys((merged && merged.tables && merged.tables.workspaces) ?? {}).length
        report.workspace.sessions = Object.values((merged && merged.tables && merged.tables.workspaces) ?? {}).reduce(
          (sum, workspace) => sum + ((workspace && workspace.sessionIds) ?? []).length,
          0,
        )
      }
      await this.writeState({ lastRestoreAt: new Date().toISOString(), lastError: null })
      return report
    })
  }

  /** 把一份与本地冲突的内容存到旁路目录，供人工取回。 */
  async #saveConflict(rel, data) {
    const dir = path.join(path.dirname(this.config.workDir), 'conflicts', STAMP())
    const file = assertInside(dir, rel)
    await writeAtomic(file, data)
    return file
  }

  /** 合并工作区登记，写回本机，并返回供发布使用的文本。 */
  async #mergeWorkspace(root) {
    const cfg = this.config
    const localFile = path.join(cfg.home, WORKSPACE_REL)
    const remoteFile = path.join(root, WORKSPACE_REL)
    const localDoc = await readJson(localFile, undefined)
    const remoteDoc = await readJson(remoteFile, undefined)
    if (!localDoc && !remoteDoc) {
      return { text: '', publish: false, changed: false, report: { workspaces: 0, sessions: 0, changed: false } }
    }
    const localText = localDoc ? `${JSON.stringify(localDoc, null, 2)}\n` : ''
    const remoteText = remoteDoc ? `${JSON.stringify(remoteDoc, null, 2)}\n` : ''
    const merged = mergeRegistry(localDoc, remoteDoc)
    const text = `${JSON.stringify(merged, null, 2)}\n`
    const changed = text !== localText
    if (changed) await writeAtomic(localFile, text)
    const workspaces = Object.keys((merged && merged.tables && merged.tables.workspaces) ?? {})
    return {
      text,
      publish: text !== remoteText,
      changed,
      report: {
        workspaces: workspaces.length,
        sessions: workspaces.reduce(
          (sum, id) => sum + ((merged.tables.workspaces[id] ?? {}).sessionIds ?? []).length,
          0,
        ),
        changed,
        merged: text !== remoteText,
      },
    }
  }
}

/**
 * 规划一次同步：谁需要拉取、谁需要推送、谁冲突。
 * 会话/附件按追加写判定，工作区文件按三方基线判定。
 */
function planSync(cfg, local, remote, base) {
  const pushes = new Set()
  const pulls = []
  const pullWins = []
  const prefix = []
  const conflicts = []
  const publishedExtras = new Map()

  for (const [rel, localEntry] of local) {
    if (rel === WORKSPACE_REL) continue
    const remoteEntry = remote.get(rel)
    if (!remoteEntry) {
      pushes.add(rel)
      continue
    }
    if (remoteEntry.sha1 === localEntry.sha1) continue
    if (localEntry.kind === 'file') {
      const baseSha = base[rel]
      if (baseSha === localEntry.sha1) pullWins.push(rel)
      else if (baseSha === remoteEntry.sha1) pushes.add(rel)
      else conflicts.push(rel)
      continue
    }
    prefix.push(rel)
  }

  for (const [rel, remoteEntry] of remote) {
    if (rel === WORKSPACE_REL) continue
    if (local.has(rel)) continue
    if (remoteEntry.kind === undefined && rel.startsWith('workspaces/')) {
      // 远端独有的工作区文件
      pulls.push(rel)
      continue
    }
    const baseSha = base[rel]
    if (baseSha !== undefined && !cfg.propagateDeletions) {
      // 本机删除过：保留远端，下次同步会重新取回
      pulls.push(rel)
      continue
    }
    pulls.push(rel)
  }

  return { pushes, pulls, pullWins, prefix, conflicts, publishedExtras }
}

function isRestorable(name) {
  return (
    name.startsWith(`${SESSIONS_DIR}/`) ||
    name.startsWith('workspaces/') ||
    name.startsWith('attachments/') ||
    name === 'settings.yaml'
  )
}

function compactReport(report) {
  return {
    mode: report.mode,
    scope: report.scope,
    at: report.at,
    pulled: report.pulled,
    pushed: report.pushed,
    conflicts: report.conflicts.length,
    skipped: report.skipped.length,
    workspace: report.workspace,
    remote: report.remote,
    durationMs: report.durationMs,
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new Error('同步已取消')
}
