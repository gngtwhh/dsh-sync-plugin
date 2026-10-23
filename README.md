# dsh-sync

DeepSeek Harness 插件：把**会话历史**、**工作区登记**（可选：**工作区目录文件**、附件、设置）备份并同步到 Git 远端或共享目录，用于多台电脑之间接续工作。

- **侧栏底部同步栏**：状态点 + 「同步」入口，点击打开同步面板。
- **同步面板**（侧栏图标 / 底部状态栏进入）：状态、层级、自动同步、目标、立即同步、导出/恢复。
- **设置 → 同步与备份**：同一个面板的表单版本。
- **模型工具**：`sync_status` / `sync_configure` / `sync_push` / `sync_pull` / `sync_backup` / `sync_restore`。

界面与工具调用的是同一套实现（`lib/engine.js`），行为一致。

## 同步层级

| 层级 | 内容 | 适用 |
| --- | --- | --- |
| `sessions` 仅会话历史 | 会话日志 + 工作区登记 | 默认。体积最小，只搬“聊过什么” |
| `workspace` 会话 + 工作区文件 | 上一级 + 工作区目录里的文件 | 换机器后代码和会话一起到位 |
| `full` 全部 | 上一级 + 上传附件 + `settings.yaml` | 整机迁移 |

工作区文件规则：

- **按工作区开关**：选 `workspace` / `full` 后，面板会列出全部工作区（标题、路径、文件数、体积），逐个开关。关闭的工作区**既不上传，也不会从远端拉回**；仓库里已有的文件保持原样，重新打开就恢复同步。
- 工作区本身是 Git 仓库时用 `git ls-files --cached --others --exclude-standard`，**自动遵守 .gitignore**，不会带 `.git`。
- 非 Git 目录退化为遍历 + 内置排除（`node_modules`、`.venv`、`__pycache__`、`dist`、`build`、`target`、`coverage` 等）。
- 额外 `ignore` 规则（如 `*.log`、`tmp/`、`**/dist/**`），单文件上限默认 4 MB，文件数上限默认 20000。
- 删除**不会**跨设备传播（默认保留远端副本），如需传播可设 `propagateDeletions: true`。

## 自动同步

| 模式 | 行为 |
| --- | --- |
| `off` | 只手动同步 |
| `interval` | 每 N 分钟执行一次「拉取 + 推送」 |
| `idle` | 会话安静 N 分钟后执行（每 30 秒探测一次，无活动不打扰） |
| `startup` | DSH 启动后执行一次 |

`sync_configure` 也可直接设置：

```json
{ "scope": "workspace", "autoMode": "idle", "autoMinutes": 15 }
```

## 冲突规则

- **会话日志**：单写者追加写，两个版本互为前缀时取更长的一份；真正分叉时保留本机，远端版本存到 `~/.dsh/sync/conflicts/<时间>/`。
- **工作区文件**：三方合并（本机 / 远端 / 上次同步基线）。只有两端都改了才判冲突：保留本机版本，另一版本写进仓库 `conflicts/<时间>/`，任何设备都能取回。
- **工作区登记**：语义合并——工作区/会话/归档/置顶取有序并集，标题按 `updatedAt` 取较新，路径保留本机。

## 两种目标

- **Git 仓库**（推荐）：每次同步产生一个快照提交，历史即备份。插件先把本地镜像 `reset` 到远端，再叠加本机内容提交，因此**永远快进推送、不会产生 Git 冲突文件**。
- **共享目录**：指向已被 Syncthing / OneDrive / 坚果云同步的目录。Syncthing 可用；它产生的 `*.sync-conflict-*` 不会被读取，建议关闭该目录的冲突副本。

## 安装（另一台设备）

在 Web 侧栏 **Plugins → Add plugin** 里填以下任一种：

- `git+ssh://git@github.com/you/dsh-sync-plugin.git`
- tarball 路径（`npm pack` 产物）
- 本地目录绝对路径

装完点 **Enable now**，再到 **设置 → 同步与备份** 填同一个仓库地址即可。

## 配置

界面里保存的配置写入 `~/.dsh/sync/settings.json`，优先级高于 `cordis.patch.yml` 的初始 `config`：

```yaml
- id: dsh-sync
  config:
    scope: workspace
    target:
      kind: git
      remote: git@github.com:you/dsh-sync.git
      branch: main
    autoSync:
      mode: idle
      minutes: 15
    ignore: ["*.log", "tmp/"]
    # 工作区级开关：default 为未单独设置时的默认值
    workspaceFiles:
      default: true
      include:
        4f1fa8ac-0faa-4a9c-badf-c982770b9130: false
```

模型侧也可以直接改：`sync_configure { workspaceId, workspaceFileSync }`。

## 仓库镜像布局

```
index.json                 上次发布的文件指纹
manifest.json              设备、时间、规模、层级
README.md                  自动生成
storages/workspace.json    工作区登记
sessions/...               会话日志
workspaces/<id>/...        工作区文件（按工作区 id 存放）
attachments/...            附件（full 层级）
conflicts/<时间>/...       冲突保留的对方版本
```

## 目录与路径逻辑

仓库里**按工作区 id 存放**，不按路径：

```
workspaces/<工作区id>/<工作区内的相对路径>
```

所以工作区改名、挪目录都不会导致重复或丢失——身份是 id，不是路径。落盘时用「本机登记里这个 id 的 path」+ 相对路径还原。

合并工作区登记时的规则：

- 本机已有这个工作区 → **保留本机 path**（两台设备可以各用各的路径）；
- 本机没有（从远端新拉来的工作区）→ 采用远端的 path；
- 命中目录映射规则 → 改写成本机前缀后再写入本机登记。

**目录映射**：面板里一行一条 `远端前缀 => 本机前缀`，例如

```
D:\Data\code => E:\code
\\nas\share\proj => D:\proj
```

- 最长前缀优先，Windows 上不区分大小写，POSIX 上保留大小写。
- 只在合并登记时改写本机这份 `workspace.json`，所以每台设备保留自己的路径，不会互相覆盖。
- 映射后的目录必须存在；不存在就跳过该工作区文件并计入 `skipped`，**不会替你在磁盘上创建整棵目录树**。
- 配在 `settings.json` 的 `pathMap`，或用 `sync_configure { pathMap: "D:\\Data\\code => E:\\code" }`。

**已知限制**：会话归属仍由日志里的 `header.cwd` 决定，这是写进日志、无法改写的历史；路径不同的设备之间，文件能映射到位，但**旧会话不会自动归到映射后的工作区**，只有映射后新建的会话才会。附件是内容寻址存储，不受路径影响。

## 已知限制

- **工作区路径需两端一致**：会话按 `header.cwd` 归入工作区，工作区文件也按登记里的路径还原。路径不同时文件会被跳过并计入 `skipped`。
- **拉取后可能需要重启 DSH**：工作区登记是磁盘文件，运行中的宿主进程有自己的内存副本。
- **运行中的会话会持续增长**：每次同步都会推送当前活动会话的增量。
- 只做文件级增量，不做内容级合并；冲突以「保留双方」为准，不静默丢弃。

## 自测

```powershell
node test/run.mjs        # 端到端：两台设备 + 裸仓库、追加、会话冲突、备份、恢复、目录目标
node test/workspace.mjs  # 工作区文件：层级、排除规则、三方合并、冲突保留、自动同步配置
node test/api.mjs        # 面板 RPC 契约
```
