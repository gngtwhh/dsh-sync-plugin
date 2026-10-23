/**
 * 同步引擎：把本机 ~/.dsh 的「会话日志 + 工作区登记」与一个远端镜像双向对齐。
 *
 * 设计要点：
 *  - 会话日志是单写者追加写，所以按文件对比即可；两个版本互为前缀时直接取更长的一份。
 *  - 工作区登记是唯一需要语义合并的文件，交给 registry.js。
 *  - Git 目标只做线性快照提交（先 reset 到远端，再叠加本机内容），因此永远不会产生
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
  scanLocal,
  stableStringify,
  summarize,
  writeAtomic,
} from './store.js'
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
 * @param {any} raw cordis.patch.yml 中的 config
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

  const name = sanitizeName(raw && raw.name ? raw.name : kind === 'git' ? remote.split('/').pop() : path.basename(dir))
  const workDir = path.resolve(expandHome(raw && raw.workDir ? raw.workDir : path.join(home, 'sync', name)))
  const backupDir = path.resolve(expandHome(raw && raw.backupDir ? raw.backupDir : path.join(home, 'backups')))
  const autosyncMinutes = Number.isFinite(Number(raw && raw.autosyncMinutes))
    ? Math.max(0, Number(raw.autosyncMinutes))
    : 0

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
    includeAttachments: raw?.includeAttachments === true,
    includeSettings: raw?.includeSettings === true,
    autosyncMinutes,
    key: `${kind}|${kind === 'git' ? `${remote}#${branch}` : dir}`,
    target: { kind, remote, branch, dir, workDir },
  }
}

function countBytes(files) {
  return summarize(files)
}

function hashBuffer(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

/** 双端文件集合的差异，工作区登记单独处理。 */
function diffIndexes(local, remote) {
  const pull = []
  const push = []
  const both = []
  for (const [rel, info] of local) {
    if (rel === WORKSPACE_REL) continue
    const other = remote.get(rel)
    if (!other) push.push(rel)
    else if (other.sha1 !== info.sha1) both.push(rel)
  }
  for (const [rel] of remote) {
    if (rel === WORKSPACE_REL) continue
    if (!local.has(rel)) pull.push(rel)
  }
  return { pull, push, both }
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
   * 读取当前状态；refresh=true 时会访问一次远端。
   * @param {{refresh?: boolean}} [options]
   */
  async status(options = {}) {
    const cfg = this.config
    const local = await scanLocal(cfg)
    const localSummary = summarize(local)
    const state = await this.readState()
    const result = {
      target: {
        kind: cfg.kind,
        description: cfg.kind === 'git' ? `${cfg.remote || '（未配置远端）'}` : cfg.dir || '（未配置目录）',
        branch: cfg.kind === 'git' ? cfg.branch : undefined,
        workDir: cfg.workDir,
      },
      device: cfg.device,
      home: cfg.home,
      local: {
        sessions: countSessions(local),
        files: localSummary.files,
        bytes: localSummary.bytes,
        bytesText: humanBytes(localSummary.bytes),
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
      result.warnings.push('尚未配置同步目标，请在插件配置中填写 target.remote 或 target.path。')
      return result
    }
    try {
      await prepare(cfg.target)
      if (options.refresh) await refreshRemote(cfg.target)
      const remoteView = await readRemoteIndex(cfg.target)
      const remoteIndex = remoteView.files
      const { pull, push, both } = diffIndexes(local, remoteIndex)
      result.pending = {
        toPush: push.length + both.length + (await workspacePending(cfg, remoteIndex)),
        toPull: pull.length + both.length,
        conflicts: 0,
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
      const localIndex = await scanLocal(cfg)
      const { pull, push, both } = diffIndexes(localIndex, remoteIndex)

      const report = {
        mode,
        target: this.describeTarget(),
        pulled: { files: 0, bytes: 0 },
        pushed: { files: 0, bytes: 0 },
        conflicts: [],
        workspace: { workspaces: 0, sessions: 0, changed: false },
        remote: { fetched: refresh.fetched, committed: false, pushed: false },
        at: new Date().toISOString(),
        durationMs: 0,
      }

      // 1) 远端独有的文件 → 落到本机
      for (const rel of pull) {
        const data = await fs.readFile(assertInside(root, rel))
        await writeAtomic(assertInside(cfg.home, rel), data)
        report.pulled.files += 1
        report.pulled.bytes += data.length
      }
      throwIfAborted(signal)

      // 2) 两端都改过的文件：追加写前缀判定
      const toUpload = new Set(push)
      for (const rel of both) {
        const localBuf = await fs.readFile(assertInside(cfg.home, rel))
        const remoteBuf = await fs.readFile(assertInside(root, rel))
        if (isPrefix(localBuf, remoteBuf)) {
          await writeAtomic(assertInside(cfg.home, rel), remoteBuf)
          report.pulled.files += 1
          report.pulled.bytes += remoteBuf.length - localBuf.length
        } else if (isPrefix(remoteBuf, localBuf)) {
          toUpload.add(rel)
        } else {
          const saved = await this.#saveConflict(rel, remoteBuf)
          toUpload.add(rel)
          report.conflicts.push({ path: rel, savedTo: saved })
        }
      }
      throwIfAborted(signal)

      // 3) 工作区登记语义合并
      const workspace = await this.#mergeWorkspace(root)
      report.workspace = workspace.report

      // 4) 发布本机内容
      if (mode === 'push') {
        const published = new Map(remoteIndex)
        for (const rel of toUpload) {
          const data = await fs.readFile(assertInside(cfg.home, rel))
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
        // 没有内容变化时不写 index/manifest，也不产生空提交。
        if (report.pushed.files > 0) {
          const summary = { ...summarize(published), sessions: countSessions(published) }
          const result = await publishRemote(cfg.target, {
            files: published,
            device: cfg.device,
            summary,
            message: `sync(${cfg.device}): ${report.pushed.files} 个文件变更`,
          })
          report.remote.committed = result.committed
          report.remote.pushed = result.pushed
        }
      }

      report.durationMs = Date.now() - startedAt
      const patch = {
        lastSyncAt: report.at,
        lastError: null,
        lastReport: compactReport(report),
        device: cfg.device,
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
    const index = await scanLocal(cfg)
    const entries = []
    for (const rel of [...index.keys()].sort()) {
      const data = await fs.readFile(assertInside(cfg.home, rel))
      entries.push({ name: rel, data })
    }
    entries.push({
      name: 'sync-manifest.json',
      data: Buffer.from(
        JSON.stringify(
          {
            format: 1,
            generator: '@local/dsh-sync',
            device: cfg.device,
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
        const target = assertInside(cfg.home, name)
        if (await pathExists(target)) {
          const current = await fs.readFile(target)
          if (current.equals(entry.data)) continue
          if (isPrefix(current, entry.data)) {
            // 本机是备份内容的前缀（只多不少）→ 保留本机
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
      return {
        text: '',
        publish: false,
        changed: false,
        report: { workspaces: 0, sessions: 0, changed: false },
      }
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

function isRestorable(name) {
  return (
    name.startsWith(`${SESSIONS_DIR}/`) ||
    name.startsWith('attachments/') ||
    name === 'settings.yaml'
  )
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

async function workspacePending(cfg, remoteIndex) {
  const remote = remoteIndex.get(WORKSPACE_REL)
  const localFile = path.join(cfg.home, WORKSPACE_REL)
  if (!(await pathExists(localFile))) return 0
  if (!remote) return 1
  const info = await fs.stat(localFile)
  const data = await fs.readFile(localFile)
  return createHash('sha1').update(data).digest('hex') === remote.sha1 && info.size === remote.size ? 0 : 1
}

function compactReport(report) {
  return {
    mode: report.mode,
    at: report.at,
    pulled: report.pulled,
    pushed: report.pushed,
    conflicts: report.conflicts.length,
    workspace: report.workspace,
    remote: report.remote,
    durationMs: report.durationMs,
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new Error('同步已取消')
}
