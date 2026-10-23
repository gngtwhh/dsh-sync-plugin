/**
 * 工作区文件同步自测：层级过滤、排除规则、三方合并、冲突保留。
 * 运行：node test/workspace.mjs
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig, SyncEngine } from '../lib/engine.js'
import { compileIgnores } from '../lib/workspace-files.js'

const root = path.join(os.tmpdir(), `dsh-sync-ws-${Date.now()}`)
let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
}
async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const projectPath = path.join(root, 'proj')
const shared = path.join(root, 'shared')

function registry(id, dirPath) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [id]: {
          path: dirPath,
          title: 'proj',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
}

async function device(name, id) {
  const home = path.join(root, name, '.dsh')
  await fs.mkdir(home, { recursive: true })
  await write(path.join(home, 'storages/workspace.json'), JSON.stringify(registry(id, projectPath), null, 2))
  return home
}

function engineFor(home, deviceName, scope = 'workspace') {
  return new SyncEngine(
    resolveConfig(
      {
        name: 'ws',
        target: { kind: 'directory', path: shared },
        scope,
        maxFileBytes: 1024 * 1024,
        ignore: ['*.log', 'tmp/'],
      },
      { home, device: deviceName },
    ),
  )
}

async function main() {
  await fs.mkdir(projectPath, { recursive: true })
  await write(path.join(projectPath, 'src/a.js'), 'export const a = 1\n')
  await write(path.join(projectPath, 'README.md'), '# proj\n')
  await write(path.join(projectPath, 'node_modules/pkg/index.js'), 'should not sync\n')
  await write(path.join(projectPath, 'debug.log'), 'ignored by pattern\n')
  await write(path.join(projectPath, 'tmp/scratch.txt'), 'ignored by dir pattern\n')
  await write(path.join(projectPath, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1))

  console.log('层级：workspace')
  const homeA = await device('A', 'w1')
  const engineA = engineFor(homeA, 'A')
  const pushA = await engineA.sync({ mode: 'push' })
  check('推送工作区文件', pushA.pushed.files >= 3, pushA.pushed)
  check('仓库中存在 a.js', await exists(path.join(shared, 'workspaces/w1/src/a.js')))
  check('node_modules 未同步', !(await exists(path.join(shared, 'workspaces/w1/node_modules/pkg/index.js'))))
  check('ignore 规则生效（*.log）', !(await exists(path.join(shared, 'workspaces/w1/debug.log'))))
  check('ignore 规则生效（tmp/）', !(await exists(path.join(shared, 'workspaces/w1/tmp/scratch.txt'))))
  check('超过大小上限的文件被跳过', !(await exists(path.join(shared, 'workspaces/w1/big.bin'))))

  console.log('另一台设备拉取')
  const homeB = await device('B', 'w1')
  const engineB = engineFor(homeB, 'B')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.rm(path.join(projectPath, 'src/a.js'), { force: true })
  await fs.rm(path.join(projectPath, 'README.md'), { force: true })
  const pullB = await engineB.sync({ mode: 'pull' })
  check('B 拉取工作区文件', pullB.pulled.files >= 2, pullB.pulled)
  check('B 上恢复出 a.js', (await fs.readFile(path.join(projectPath, 'src/a.js'), 'utf8')).includes('export const a'))

  console.log('三方合并：只有一端修改')
  await write(path.join(projectPath, 'src/a.js'), 'export const a = 2\n')
  const pushA2 = await engineA.sync({ mode: 'push' })
  check('A 推送本机修改', pushA2.pushed.files >= 1, pushA2.pushed)
  const pullB2 = await engineB.sync({ mode: 'pull' })
  check('B 无需冲突即可拉取', pullB2.conflicts.length === 0, pullB2.conflicts)
  check('B 得到新内容', (await fs.readFile(path.join(projectPath, 'src/a.js'), 'utf8')).includes('= 2'))

  console.log('三方合并：两端同时修改')
  await write(path.join(projectPath, 'src/a.js'), 'export const a = "from-A"\n')
  await engineA.sync({ mode: 'push' })
  await write(path.join(projectPath, 'src/a.js'), 'export const a = "from-B"\n')
  const pushB3 = await engineB.sync({ mode: 'push' })
  check('冲突被识别', pushB3.conflicts.length === 1, pushB3.conflicts)
  check('冲突保留本机版本', (await fs.readFile(path.join(projectPath, 'src/a.js'), 'utf8')).includes('from-B'))
  const conflictEntry = pushB3.conflicts[0]
  const conflictFiles = await fs.readdir(path.join(shared, 'conflicts')).catch(() => [])
  check('远端 conflicts/ 保留了另一方版本', conflictFiles.length === 1, conflictFiles)
  const preserved = await fs.readdir(path.join(shared, 'conflicts', conflictFiles[0], 'workspaces/w1/src'))
  check('冲突文件名与来源一致', preserved.includes('a.js'), preserved)

  console.log('层级：sessions 不含工作区文件')
  const homeC = await device('C', 'w1')
  const engineC = engineFor(homeC, 'C', 'sessions')
  const pushC = await engineC.sync({ mode: 'push' })
  check('sessions 层级不推送工作区文件', pushC.pushed.files === 0, pushC.pushed)

  console.log('ignore 规则编译')
  const ignored = compileIgnores(['*.log', 'tmp/', '**/dist/**', 'exact.txt'])
  check('*.log 命中', ignored('debug.log'))
  check('tmp/ 命中子路径', ignored('tmp/a/b.txt'))
  check('**/dist/** 命中', ignored('packages/x/dist/index.js'))
  check('exact.txt 只命中自身', ignored('exact.txt') && !ignored('sub/exact.txt'))

  console.log('自动同步配置归一化')
  const auto = resolveConfig({ autoSync: { mode: 'idle', minutes: 7 } })
  check('idle/7 保留', auto.autoSync.mode === 'idle' && auto.autoSync.minutes === 7)
  const legacy = resolveConfig({ autosyncMinutes: 30 })
  check('旧的 autosyncMinutes 映射为 interval', legacy.autoSync.mode === 'interval' && legacy.autoSync.minutes === 30)
  const bad = resolveConfig({ autoSync: { mode: 'nope', minutes: 0 } })
  check('非法策略回落到 off', bad.autoSync.mode === 'off' && bad.autoSync.minutes === 15)

  console.log('活动指纹')
  const before = await engineA.activityFingerprint()
  await fs.appendFile(path.join(homeA, 'sessions/--x--/s1/session.v3.jsonl.zstd'), 'x').catch(async () => {
    await write(path.join(homeA, 'sessions/--x--/s1/session.v3.jsonl.zstd'), 'x')
  })
  const after = await engineA.activityFingerprint()
  check('会话写入改变指纹', before !== after, { before, after })

  console.log('按工作区开关文件同步')
  const shared2 = path.join(root, 'shared2')
  const proj1 = path.join(root, 'p1')
  const proj2 = path.join(root, 'p2')
  await write(path.join(proj1, 'a.js'), 'export const a = 1\n')
  await write(path.join(proj2, 'b.js'), 'export const b = 1\n')
  const homeE = path.join(root, 'E', '.dsh')
  await fs.mkdir(homeE, { recursive: true })
  await write(
    path.join(homeE, 'storages/workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: {
          workspaces: {
            w1: { path: proj1, title: 'p1', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
            w2: { path: proj2, title: 'p2', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
          },
        },
      },
      null,
      2,
    ),
  )
  const engineE = new SyncEngine(
    resolveConfig(
      { name: 'ws2', target: { kind: 'directory', path: shared2 }, scope: 'workspace', workspaceFiles: { include: { w2: false } } },
      { home: homeE, device: 'E' },
    ),
  )
  await engineE.sync({ mode: 'push' })
  check('启用的工作区被推送', await exists(path.join(shared2, 'workspaces/w1/a.js')))
  check('关闭的工作区不推送', !(await exists(path.join(shared2, 'workspaces/w2/b.js'))))

  const statusE = await engineE.status()
  const w1State = statusE.workspaces.find((workspace) => workspace.id === 'w1')
  const w2State = statusE.workspaces.find((workspace) => workspace.id === 'w2')
  check('状态里标记 w1 开', w1State && w1State.syncFiles === true, w1State)
  check('状态里标记 w2 关', w2State && w2State.syncFiles === false, w2State)
  check('状态统计启用的工作区数量', statusE.workspaceFileSummary.enabled === 1 && statusE.workspaceFileSummary.total === 2, statusE.workspaceFileSummary)

  const homeF = path.join(root, 'F', '.dsh')
  await fs.mkdir(homeF, { recursive: true })
  await write(
    path.join(homeF, 'storages/workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: {
          workspaces: {
            w1: { path: proj1, title: 'p1', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
            w2: { path: proj2, title: 'p2', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
          },
        },
      },
      null,
      2,
    ),
  )
  await fs.rm(path.join(proj1, 'a.js'), { force: true })
  const engineF = new SyncEngine(
    resolveConfig(
      { name: 'ws2', target: { kind: 'directory', path: shared2 }, scope: 'workspace', workspaceFiles: { include: { w1: false } } },
      { home: homeF, device: 'F' },
    ),
  )
  await engineF.sync({ mode: 'pull' })
  check('关闭的工作区不会被拉回本机', !(await exists(path.join(proj1, 'a.js'))))

  console.log('目录映射')
  const shared3 = path.join(root, 'shared3')
  const hproj = path.join(root, 'hproj')
  await write(path.join(hproj, 'x/a.js'), 'export const fromH = 1\n')
  const homeH = path.join(root, 'H', '.dsh')
  await fs.mkdir(homeH, { recursive: true })
  await write(path.join(homeH, 'storages/workspace.json'), JSON.stringify(registry('w9', hproj), null, 2))
  const engineH = new SyncEngine(
    resolveConfig({ name: 'ws3', target: { kind: 'directory', path: shared3 }, scope: 'workspace' }, { home: homeH, device: 'H' }),
  )
  await engineH.sync({ mode: 'push' })
  check('H 推送了 hproj 的文件', await exists(path.join(shared3, 'workspaces/w9/x/a.js')))

  const mappedRoot = path.join(root, 'mapped')
  await fs.mkdir(path.join(mappedRoot, 'proj'), { recursive: true })
  const homeG = path.join(root, 'G', '.dsh')
  await fs.mkdir(homeG, { recursive: true })
  await write(
    path.join(homeG, 'storages/workspace.json'),
    JSON.stringify(registry('w9', 'D:\\remote\\proj'), null, 2),
  )
  const engineG = new SyncEngine(
    resolveConfig(
      {
        name: 'ws3',
        target: { kind: 'directory', path: shared3 },
        scope: 'workspace',
        pathMap: ['D:\\remote => ' + mappedRoot],
      },
      { home: homeG, device: 'G' },
    ),
  )
  const pullG = await engineG.sync({ mode: 'pull' })
  check('映射后文件落到本机路径', await exists(path.join(mappedRoot, 'proj/x/a.js')))
  check('映射后没有跳过文件', pullG.skipped.length === 0, pullG.skipped)
  const registryG = JSON.parse(await fs.readFile(path.join(homeG, 'storages/workspace.json'), 'utf8'))
  check('工作区登记的路径被改写为本机路径', registryG.tables.workspaces.w9.path === path.join(mappedRoot, 'proj'), registryG.tables.workspaces.w9.path)

  const homeI = path.join(root, 'I', '.dsh')
  await fs.mkdir(homeI, { recursive: true })
  await write(path.join(homeI, 'storages/workspace.json'), JSON.stringify(registry('w9', path.join(root, 'missing-proj')), null, 2))
  const engineI = new SyncEngine(
    resolveConfig({ name: 'ws3', target: { kind: 'directory', path: shared3 }, scope: 'workspace' }, { home: homeI, device: 'I' }),
  )
  const pullI = await engineI.sync({ mode: 'pull' })
  check('目录不存在时不创建、只记跳过', pullI.skipped.length >= 1 && !(await exists(path.join(root, 'missing-proj'))), pullI.skipped)

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个用例失败`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
