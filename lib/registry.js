/**
 * 工作区登记（storages/workspace.json）的合并规则。
 *
 * 两台设备都会独立修改这份文件：新建工作区、会话归属、归档/置顶、排序。
 * 会话日志本身是单写者追加写，几乎不冲突；登记文件才是唯一需要语义合并的地方。
 *
 * 规则（保守优先，宁可多留不可丢）：
 *  - 工作区 / 归档 / 置顶 / 排序：有序并集，本机顺序在前，远端新增的追加在后。
 *  - 同一工作区的 path：保留本机路径（跨设备路径可能不同，本机可用性优先）；
 *    本机没有该工作区时才采用远端路径。
 *  - title / updatedAt：按 updatedAt 取较新者。
 *  - sessionIds：有序并集。
 *  - 未知表：本机优先，远端独有的键补齐。
 * 代价：删除类操作不会跨设备传播（需要人工在另一端重做），这是备份场景下的安全取舍。
 */

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function orderedUnion(primary, secondary) {
  const out = []
  const seen = new Set()
  for (const id of [...asArray(primary), ...asArray(secondary)]) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function sortedUnion(primary, secondary) {
  return orderedUnion(primary, secondary).sort()
}

function timeOf(value) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

function earlierString(a, b) {
  const left = typeof a === 'string' ? a : undefined
  const right = typeof b === 'string' ? b : undefined
  if (left === undefined) return right
  if (right === undefined) return left
  return timeOf(left) <= timeOf(right) ? left : right
}

function laterString(a, b) {
  const left = typeof a === 'string' ? a : undefined
  const right = typeof b === 'string' ? b : undefined
  if (left === undefined) return right
  if (right === undefined) return left
  return timeOf(left) >= timeOf(right) ? left : right
}

function mergeWorkspace(local, remote) {
  if (local === undefined || local === null) return remote
  if (remote === undefined || remote === null) return local
  const localNewer = timeOf(local.updatedAt) >= timeOf(remote.updatedAt)
  const primary = localNewer ? local : remote
  const secondary = localNewer ? remote : local
  return {
    ...secondary,
    ...primary,
    path: typeof local.path === 'string' ? local.path : remote.path,
    title: typeof primary.title === 'string' ? primary.title : secondary.title,
    sessionIds: orderedUnion(local.sessionIds, remote.sessionIds),
    createdAt: earlierString(local.createdAt, remote.createdAt),
    updatedAt: laterString(local.updatedAt, remote.updatedAt),
  }
}

/**
 * 合并两份登记文档。
 * @param {unknown} local
 * @param {unknown} remote
 * @returns {any} 合并后的完整文档
 */
export function mergeRegistry(local, remote) {
  if (!local || typeof local !== 'object') return remote
  if (!remote || typeof remote !== 'object') return local

  const localGlobal = local.global && typeof local.global === 'object' ? local.global : {}
  const remoteGlobal = remote.global && typeof remote.global === 'object' ? remote.global : {}
  const localTables = local.tables && typeof local.tables === 'object' ? local.tables : {}
  const remoteTables = remote.tables && typeof remote.tables === 'object' ? remote.tables : {}

  const workspaceIds = orderedUnion(localGlobal.workspaceIds, remoteGlobal.workspaceIds)
  const pinned = orderedUnion(localGlobal.pinnedSessionIds, remoteGlobal.pinnedSessionIds)
  const archived = sortedUnion(localGlobal.archivedSessionIds, remoteGlobal.archivedSessionIds)

  const localWorkspaces = localTables.workspaces && typeof localTables.workspaces === 'object' ? localTables.workspaces : {}
  const remoteWorkspaces = remoteTables.workspaces && typeof remoteTables.workspaces === 'object' ? remoteTables.workspaces : {}
  const workspaces = {}
  for (const id of orderedUnion(Object.keys(localWorkspaces), Object.keys(remoteWorkspaces))) {
    workspaces[id] = mergeWorkspace(localWorkspaces[id], remoteWorkspaces[id])
  }

  const tables = { ...remoteTables, ...localTables, workspaces }
  for (const [name, table] of Object.entries(remoteTables)) {
    if (name === 'workspaces' || tables[name] !== undefined) continue
    tables[name] = table
  }

  const unit = {
    name:
      (local.unit && local.unit.name) ?? (remote.unit && remote.unit.name) ?? 'workspace',
    version: Math.max(
      Number(local.unit && local.unit.version) || 0,
      Number(remote.unit && remote.unit.version) || 0,
    ),
  }

  return {
    ...remote,
    ...local,
    unit,
    global: {
      ...remoteGlobal,
      ...localGlobal,
      initialized: Boolean(localGlobal.initialized || remoteGlobal.initialized),
      workspaceIds,
      archivedSessionIds: archived,
      pinnedSessionIds: pinned,
    },
    tables,
  }
}
