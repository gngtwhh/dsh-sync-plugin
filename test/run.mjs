/**
 * 端到端自测：两台「设备」+ 一个本地裸仓库，验证推送/拉取/合并/冲突/备份/恢复。
 * 运行：node test/run.mjs
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveConfig, SyncEngine } from '../lib/engine.js'
import { readZip, buildZip } from '../lib/zip.js'

const run = promisify(execFile)
const root = path.join(os.tmpdir(), `dsh-sync-test-${Date.now()}`)
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

function workspaceDoc(workspaceId, dirPath, sessionIds) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: dirPath,
          title: path.basename(dirPath),
          sessionIds,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
}

async function device(name) {
  const home = path.join(root, name, '.dsh')
  await fs.mkdir(home, { recursive: true })
  return home
}

function engineFor(home, target, extra = {}) {
  const config = resolveConfig(
    {
      name: 'test',
      target,
      workDir: path.join(home, 'sync', 'repo'),
      backupDir: path.join(home, 'backups'),
      ...extra,
    },
    { home, device: path.basename(path.dirname(home)) },
  )
  return new SyncEngine(config)
}

async function main() {
  await fs.mkdir(root, { recursive: true })
  const remote = path.join(root, 'remote.git')
  await run('git', ['init', '--bare', '-q', remote])

  console.log('准备设备 A')
  const homeA = await device('A')
  await write(path.join(homeA, 'storages/workspace.json'), JSON.stringify(workspaceDoc('w-a', 'D:/work/alpha', ['session-a1']), null, 2))
  const sessionA1 = Buffer.from('A'.repeat(400))
  await write(path.join(homeA, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'), sessionA1)
  const engineA = engineFor(homeA, { kind: 'git', remote, branch: 'main' })

  const first = await engineA.sync({ mode: 'push' })
  check('A 首次推送 1 个会话文件 + 登记', first.pushed.files === 2, first.pushed)
  check('A 首次推送已提交并推送', first.remote.committed === true && first.remote.pushed === true, first.remote)

  const statusA = await engineA.status()
  check('A 状态显示目标与本机会话数', statusA.ready === true && statusA.local.sessions === 1, {
    ready: statusA.ready,
    sessions: statusA.local.sessions,
  })

  const again = await engineA.sync({ mode: 'push' })
  const commits = (await run('git', ['-C', remote, 'rev-list', '--count', 'main'])).stdout.trim()
  check('无变化时不产生新提交', again.pushed.files === 0 && again.remote.committed === false, again.remote)
  check('仓库仍然只有一个快照提交', commits === '1', commits)

  console.log('准备设备 B 并拉取')
  const homeB = await device('B')
  await write(path.join(homeB, 'storages/workspace.json'), JSON.stringify(workspaceDoc('w-b', 'D:/work/beta', ['session-b1']), null, 2))
  await write(path.join(homeB, 'sessions/--D-work-beta--/session-b1/session.v3.jsonl.zstd'), Buffer.from('B'.repeat(120)))
  const engineB = engineFor(homeB, { kind: 'git', remote, branch: 'main' })

  const pullB = await engineB.sync({ mode: 'pull' })
  check('B 拉取到 A 的会话', pullB.pulled.files >= 1, pullB.pulled)
  const bSession = await fs.readFile(path.join(homeB, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'))
  check('B 的会话内容与 A 一致', bSession.equals(sessionA1))

  const bRegistry = JSON.parse(await fs.readFile(path.join(homeB, 'storages/workspace.json'), 'utf8'))
  const ids = bRegistry.global.workspaceIds
  check('B 的登记合并了两台设备的工作区', ids.includes('w-a') && ids.includes('w-b'), ids)
  check('B 的登记保留本机工作区路径', bRegistry.tables.workspaces['w-b'].path === 'D:/work/beta')

  console.log('A 追加日志后同步给 B')
  await fs.appendFile(path.join(homeA, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'), 'MORE')
  await engineA.sync({ mode: 'push' })
  const pullB2 = await engineB.sync({ mode: 'pull' })
  const bSession2 = await fs.readFile(path.join(homeB, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'))
  check('B 追平 A 的追加内容', bSession2.equals(Buffer.concat([sessionA1, Buffer.from('MORE')])), pullB2.pulled)

  console.log('冲突：两端各自写入不同内容')
  const aPath = path.join(homeA, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd')
  await fs.writeFile(aPath, Buffer.concat([sessionA1, Buffer.from('FROM-A')]))
  await fs.writeFile(path.join(homeB, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'), Buffer.concat([sessionA1, Buffer.from('FROM-B')]))
  const bPushConflict = await engineB.sync({ mode: 'push' })
  check('冲突被识别并旁路保存', bPushConflict.conflicts.length === 1, bPushConflict.conflicts)
  check('冲突时保留本机版本', (await fs.readFile(path.join(homeB, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'))).toString().endsWith('FROM-B'))

  console.log('备份与恢复')
  const backup = await engineA.backup()
  check('备份文件已生成', (await fs.stat(backup.file)).size > 0, backup)
  const zipEntries = readZip(await fs.readFile(backup.file))
  check('备份包含登记与会话', zipEntries.some((entry) => entry.name === 'storages/workspace.json') && zipEntries.some((entry) => entry.name.startsWith('sessions/')), zipEntries.map((e) => e.name))

  const homeC = await device('C')
  const engineC = engineFor(homeC, { kind: 'directory', path: path.join(root, 'shared') })
  const restoreC = await engineC.restore({ file: backup.file })
  check('恢复写入会话文件', restoreC.files >= 1, restoreC)
  check(
    '恢复的会话内容可用',
    (await fs.readFile(path.join(homeC, 'sessions/--D-work-alpha--/session-a1/session.v3.jsonl.zstd'))).length >= sessionA1.length,
  )
  const cRegistry = JSON.parse(await fs.readFile(path.join(homeC, 'storages/workspace.json'), 'utf8'))
  check('恢复得到工作区登记', Object.keys(cRegistry.tables.workspaces).length >= 1)

  console.log('共享目录目标（Syncthing/云盘）')
  const shared = path.join(root, 'shared')
  const engineA2 = engineFor(homeA, { kind: 'directory', path: shared })
  const dirPush = await engineA2.sync({ mode: 'push' })
  check('目录目标写入镜像文件', dirPush.pushed.files >= 2, dirPush.pushed)
  check('目录目标不涉及 Git 推送', dirPush.remote.pushed === false && dirPush.remote.committed === false)
  const homeD = await device('D')
  const engineD = engineFor(homeD, { kind: 'directory', path: shared })
  const dirPull = await engineD.sync({ mode: 'pull' })
  check('目录目标可被另一台设备拉取', dirPull.pulled.files >= 1 && dirPull.workspace.workspaces >= 1, dirPull)
  check('目录目标保留 index.json', await exists(path.join(shared, 'index.json')))

  console.log('长路径（Windows MAX_PATH）')
  const longRoot = path.join(root, 'longws')
  const deepRel = path.join('d'.repeat(60), 'e'.repeat(60), 'f'.repeat(90) + '.txt')
  await write(path.join(longRoot, deepRel), 'deep content')
  const homeL = await device('L')
  await write(path.join(homeL, 'storages/workspace.json'), JSON.stringify(workspaceDoc('wl', longRoot, []), null, 2))
  const remoteL = path.join(root, 'remoteL.git')
  await run('git', ['init', '--bare', '-q', remoteL])
  const engineL = engineFor(homeL, { kind: 'git', remote: remoteL, branch: 'main' }, { scope: 'workspace' })
  const pushL = await engineL.sync({ mode: 'push' })
  check('超长路径也能提交并推送', pushL.remote.pushed === true, pushL.remote)
  check('超长路径文件进入镜像', await exists(path.join(homeL, 'sync', 'repo', 'workspaces', 'wl', deepRel)))

  console.log('ZIP 读写')
  const zip = buildZip([{ name: 'a/b.txt', data: Buffer.from('hello') }, { name: 'c.bin', data: Buffer.from([0, 1, 2, 255]) }])
  const back = readZip(zip)
  check('ZIP 往返一致', back.length === 2 && back[0].data.toString() === 'hello' && back[1].data.length === 4)

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个用例失败`)
  process.exitCode = failures === 0 ? 0 : 1
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
