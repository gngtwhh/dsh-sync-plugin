/**
 * dsh-sync Host 半：把「会话日志 + 工作区登记」备份并同步到 Git 远端或共享目录。
 *
 * 三种入口共用同一份实现（见 lib/engine.js）：
 *  - 模型工具：sync_status / sync_push / sync_pull / sync_backup / sync_restore
 *  - Web 设置页：POST /api/dsh-sync（action: status|push|pull|backup|restore）
 *  - 可选定时同步：autosyncMinutes > 0 时后台执行「拉取 + 推送」
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AUTO_MODES, SCOPES, resolveConfig, SyncEngine } from './lib/engine.js'
import { writeAtomic } from './lib/store.js'

export const name = 'dsh-sync'
/** 工具注册需要 Tool 服务；连接与定时器按存在与否可选挂载。 */
export const inject = ['tools']

const API_PATH = '/api/dsh-sync'

const OUTPUT_SCHEMA = { type: 'object' }

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function asToolResult(value) {
  return value === undefined ? {} : value
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => text(value) },
    async execute(args, exec) {
      return asToolResult(await execute(args ?? {}, exec))
    },
  }
}

/** 同步前把会话写入器的缓冲落盘，避免快照拿到半截日志。 */
async function flushSessions(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if(!persistence || typeof persistence.flush !== 'function') return
  try {
    await persistence.flush()
  } catch {
    /* flush 失败不应阻断同步：日志读取端能容忍未落盘的尾部 */
  }
}

function statusText(status) {
  if (!status || typeof status !== 'object') return '（无同步状态）'
  const target = status.target ?? {}
  const local = status.local ?? {}
  const auto = status.autoSync ?? { mode: 'off' }
  const lines = []
  lines.push(`目标：${target.kind === 'git' ? 'Git 远端' : '共享目录'} ${target.description ?? '（未配置）'}`)
  if (target.branch) lines.push(`分支：${target.branch}`)
  lines.push(`层级：${status.scopeLabel ?? status.scope ?? '未知'}`)
  if (status.workspaceFileSummary && status.scope !== 'sessions') {
    lines.push(
      `工作区文件：${status.workspaceFileSummary.enabled}/${status.workspaceFileSummary.total} 个工作区已启用`,
    )
  }
  lines.push(`自动同步：${AUTO_TEXT[auto.mode] ?? auto.mode}${auto.mode === 'off' ? '' : `（${auto.minutes} 分钟）`}`)
  lines.push(
    `本机：${local.sessions ?? 0} 个会话，${local.workspaceFiles ?? 0} 个工作区文件，共 ${local.bytesText ?? '0 B'}`,
  )
  if (status.remote) {
    lines.push(
      `远端：${status.remote.sessions ?? '?'} 个会话，${status.remote.workspaceFiles ?? '?'} 个工作区文件，${status.remote.bytesText ?? '?'}` +
        (status.remote.updatedAt ? `，更新于 ${status.remote.updatedAt}` : ''),
    )
  }
  if (status.pending && status.pending.known) {
    lines.push(`待推送：${status.pending.toPush} 项；待拉取：${status.pending.toPull} 项`)
  }
  lines.push(`上次同步：${status.lastSyncAt ?? '从未'}`)
  if (status.lastError) lines.push(`上次错误：${status.lastError}`)
  for (const warning of status.warnings ?? []) lines.push(`提示：${warning}`)
  return lines.join('\n')
}

const AUTO_TEXT = {
  off: '关闭',
  interval: '定时',
  idle: '空闲后',
  startup: '启动时一次',
}

/** 设置页使用的 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * POST /api/dsh-sync 的处理器。抽成纯函数便于脱离运行时自测。
 * @param {{run: (action: string, payload: object) => Promise<any>, engine: {writeState: (patch: object) => Promise<void>}}} deps
 */
export function createApiHandler(deps) {
  return async function fetch(request, peer) {
    if (peer && peer.principal && peer.principal.kind !== 'owner') {
      return jsonResponse({ ok: false, error: 'forbidden' }, 403)
    }
    let payload = {}
    try {
      payload = await request.json()
    } catch {
      payload = {}
    }
    if (!payload || typeof payload !== 'object') payload = {}
    const action = typeof payload.action === 'string' ? payload.action : 'status'
    try {
      const data = await deps.run(action, payload)
      return jsonResponse({
        ok: true,
        data,
        summary: action === 'status' ? statusText(data) : undefined,
      })
    } catch (error) {
      const message = String((error && error.message) || error)
      await deps.engine.writeState({ lastError: message }).catch(() => {})
      return jsonResponse({ ok: false, error: message }, 500)
    }
  }
}

export function apply(ctx, config) {
  const baseConfig = config ?? {}
  const home = resolveConfig(baseConfig).home
  const settingsFile = path.join(home, 'sync', 'settings.json')

  /** 设置页写入的目标覆盖；YAML 只是初始默认值。 */
  const readOverrides = () => {
    try {
      const doc = JSON.parse(readFileSync(settingsFile, 'utf8'))
      return doc && typeof doc === 'object' ? doc : {}
    } catch {
      return {}
    }
  }

  const mergedConfig = () => {
    const overrides = readOverrides()
    return {
      ...baseConfig,
      ...overrides,
      target: { ...(baseConfig.target ?? {}), ...(overrides.target ?? {}) },
    }
  }

  const engine = new SyncEngine(resolveConfig(mergedConfig()))
  /** 每次操作前重读配置，设置页的修改立刻生效，无需重启。 */
  const syncConfig = () => {
    engine.config = resolveConfig(mergedConfig())
    return engine.config
  }
  const log = (...args) => ctx.logger?.info?.('[dsh-sync]', ...args)

  const configure = async (payload) => {
    const current = readOverrides()
    const target = { ...(current.target ?? {}) }
    if (payload.kind !== undefined) {
      const kind = payload.kind === 'directory' ? 'directory' : 'git'
      if (kind === 'git') {
        const remote = typeof payload.remote === 'string' ? payload.remote.trim() : ''
        if (!remote) throw new Error('请填写 Git 远端地址，例如 git@github.com:you/dsh-sync.git')
        target.kind = 'git'
        target.remote = remote
        target.branch = typeof payload.branch === 'string' && payload.branch.trim() ? payload.branch.trim() : 'main'
        target.path = ''
      } else {
        const dir = typeof payload.path === 'string' ? payload.path.trim() : ''
        if (!dir) throw new Error('请填写共享目录路径，例如 C:\\Users\\you\\OneDrive\\dsh-sync')
        target.kind = 'directory'
        target.path = dir
      }
    }
    const next = { ...current, target }
    if (payload.scope !== undefined) {
      if (!SCOPES.includes(payload.scope)) throw new Error(`未知同步层级：${payload.scope}`)
      next.scope = payload.scope
    }
    if (payload.autoMode !== undefined || payload.autoMinutes !== undefined) {
      const auto = current.autoSync ?? {}
      const mode = payload.autoMode !== undefined ? payload.autoMode : (auto.mode ?? 'off')
      if (!AUTO_MODES.includes(mode)) throw new Error(`未知自动同步策略：${mode}`)
      const minutes = Number(payload.autoMinutes ?? auto.minutes ?? 15)
      next.autoSync = {
        mode,
        minutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 15,
      }
    }
    if (Array.isArray(payload.ignore)) next.ignore = payload.ignore
    if (payload.workspaceFiles && typeof payload.workspaceFiles === 'object') {
      const currentFiles = next.workspaceFiles ?? current.workspaceFiles ?? {}
      const include = { ...(currentFiles.include ?? {}) }
      if (payload.workspaceFiles.include && typeof payload.workspaceFiles.include === 'object') {
        for (const [id, value] of Object.entries(payload.workspaceFiles.include)) {
          if (typeof value === 'boolean') include[id] = value
        }
      }
      next.workspaceFiles = { ...currentFiles, include }
      if (typeof payload.workspaceFiles.default === 'boolean') {
        next.workspaceFiles.default = payload.workspaceFiles.default
      }
    }
    if (typeof payload.workspaceId === 'string' && payload.workspaceId.length > 0) {
      const currentFiles = next.workspaceFiles ?? current.workspaceFiles ?? {}
      next.workspaceFiles = {
        ...currentFiles,
        include: { ...(currentFiles.include ?? {}), [payload.workspaceId]: payload.workspaceFileSync !== false },
      }
    }
    await writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`)
    syncConfig()
    return engine.status()
  }

  /** 唯一的操作入口：工具、HTTP、定时器都走这里。 */
  const run = async (action, payload = {}) => {
    if (action !== 'configure') syncConfig()
    switch (action) {
      case 'status':
        return engine.status({ refresh: payload.refresh === true })
      case 'configure':
        return configure(payload)
      case 'pull':
        await flushSessions(ctx)
        return engine.sync({ mode: 'pull' })
      case 'push':
      case 'sync':
        await flushSessions(ctx)
        return engine.sync({ mode: 'push' })
      case 'backup':
        return engine.backup()
      case 'restore':
        return engine.restore({ file: payload.file })
      default:
        throw new Error(`未知操作：${action}`)
    }
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_status',
          '查看工作区与会话备份/同步状态：目标地址、本机与远端的会话数、待推送/待拉取变更、上次同步时间与错误。',
          { type: 'object', properties: {}, required: [] },
          async () => {
            const status = await run('status')
            return { ...status, summary: statusText(status) }
          },
        ),
      ),
    'dsh-sync: sync_status',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_push',
          '把本机的会话日志与工作区登记合并到同步目标并发布（Git 目标会提交并推送）。会先拉取远端已有内容，按追加写规则合并，不会覆盖另一台设备的日志。',
          { type: 'object', properties: {}, required: [] },
          async () => run('push'),
        ),
      ),
    'dsh-sync: sync_push',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_pull',
          '从同步目标拉取另一台设备的会话日志与工作区登记并合并到本机。只读取远端，不发布本机改动。新拉取的工作区可能需要重启 DSH 才会出现在侧栏。',
          { type: 'object', properties: {}, required: [] },
          async () => run('pull'),
        ),
      ),
    'dsh-sync: sync_pull',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_backup',
          '把本机的会话日志与工作区登记打包成一个可搬运的 zip 备份，返回文件路径。不依赖远端，可作为离线快照。',
          { type: 'object', properties: {}, required: [] },
          async () => run('backup'),
        ),
      ),
    'dsh-sync: sync_backup',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_restore',
          '从指定的备份 zip 恢复会话日志与工作区登记。恢复前会自动生成一份当前状态备份；重复或更旧的日志不会覆盖本机更长的日志。',
          {
            type: 'object',
            properties: {
              file: { type: 'string', description: '备份 zip 的绝对路径（sync_backup 返回的路径）' },
            },
            required: ['file'],
          },
          async (args) => run('restore', { file: args.file }),
        ),
      ),
    'dsh-sync: sync_restore',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        tool(
          'sync_configure',
          '配置同步：kind=git|directory 设目标；scope 设同步层级（sessions 仅会话历史、workspace 会话+工作区文件、full 全部）；autoMode 设自动同步策略（off/interval/idle/startup），autoMinutes 设间隔。只传需要修改的字段，保存后立即生效。',
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['git', 'directory'], description: '目标类型' },
              remote: { type: 'string', description: 'Git 远端地址（kind=git 时必填）' },
              branch: { type: 'string', description: 'Git 分支，默认 main' },
              path: { type: 'string', description: '共享目录绝对路径（kind=directory 时必填）' },
              scope: {
                type: 'string',
                enum: ['sessions', 'workspace', 'full'],
                description: '同步层级：sessions=仅会话历史（含工作区登记）；workspace=再加工作区目录文件；full=再加附件与设置',
              },
              autoMode: {
                type: 'string',
                enum: ['off', 'interval', 'idle', 'startup'],
                description: '自动同步：off 关闭；interval 每 N 分钟；idle 会话安静 N 分钟后；startup 启动时一次',
              },
              autoMinutes: { type: 'number', description: '自动同步的分钟数（1–1440，默认 15）' },
              workspaceId: {
                type: 'string',
                description: '要单独开关文件同步的工作区 id（取自 sync_status 的 workspaces[].id）',
              },
              workspaceFileSync: {
                type: 'boolean',
                description: '配合 workspaceId：该工作区的目录文件是否参与同步',
              },
            },
            required: [],
          },
          async (args) => {
            const data = await run('configure', args)
            return { ...data, summary: statusText(data) }
          },
        ),
      ),
    'dsh-sync: sync_configure',
  )

  // Web 设置页的调用入口：与工具完全相同的实现。
  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () =>
        scope.connection.fetch.register({
          path: API_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: createApiHandler({ run, engine }),
        }),
      'dsh-sync: /api/dsh-sync route',
    )
  })

  // 自动同步策略：off / interval / idle / startup。
  // 每 30 秒检查一次策略，规则变化立即生效，不需要重启。
  ctx.inject(['timer'], (scope) => {
    scope.effect(() => {
      let running = false
      let lastAttempt = 0
      let lastFingerprint = ''
      let activeAt = Date.now()
      let startupDone = false

      const autoRun = async (reason) => {
        if (running) return
        running = true
        lastAttempt = Date.now()
        try {
          await flushSessions(ctx)
          const result = await engine.sync({ mode: 'push' })
          log('autosync', reason, result.pushed.files, 'pushed,', result.pulled.files, 'pulled')
        } catch (error) {
          const message = String((error && error.message) || error)
          log('autosync failed:', message)
          await engine.writeState({ lastError: message }).catch(() => {})
        } finally {
          running = false
          lastAttempt = Date.now()
        }
      }

      const tick = async () => {
        const cfg = syncConfig()
        const auto = cfg.autoSync
        if (auto.mode === 'off') return
        const now = Date.now()
        if (auto.mode === 'startup') {
          if (startupDone) return
          startupDone = true
          await autoRun('startup')
          return
        }
        if (auto.mode === 'interval') {
          if (now - lastAttempt < Math.max(60_000, auto.minutes * 60_000)) return
          await autoRun('interval')
          return
        }
        // idle：会话目录没有新活动，且安静了 N 分钟才同步
        const fingerprint = await engine.activityFingerprint()
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint
          activeAt = now
          return
        }
        if (now - activeAt < auto.minutes * 60_000) return
        if (now - lastAttempt < 5 * 60_000) return
        await autoRun('idle')
      }

      const interval = scope.interval(tick, 30_000)
      const kickoff = scope.timeout(tick, 20_000)
      return () => {
        interval()
        kickoff()
      }
    }, 'dsh-sync: autosync')
  })

  const initial = syncConfig()
  ctx.logger?.info?.(`[dsh-sync] target=${engine.describeTarget()} home=${initial.home}`)
}
