/**
 * dsh-sync Client 半：
 *  - 侧栏底部的「同步」状态栏（显示状态点，点击打开同步面板）
 *  - 主区域同步面板（main: sync）
 *  - 设置 → 同步与备份（settings.section: dsh-sync）
 *
 * 三者共用同一份状态逻辑，只通过 POST /api/dsh-sync 与 Host 通信，
 * 与模型工具调用的是同一套实现。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dshSync'
    const API = 'api/dsh-sync'
    const PANEL_ID = 'sync'

    const en = {
      nav: 'Sync & backup',
      panel: 'Sync',
      title: 'Sync & backup',
      intro:
        'Back up session logs, workspace registrations and (optionally) workspace files to a Git remote or a shared folder, then merge them across devices.',
      configTitle: 'Sync target',
      kindGit: 'Git repository',
      kindDir: 'Shared folder',
      save: 'Save',
      saved: 'Saved.',
      remotePlaceholder: 'git@github.com:you/dsh-sync.git',
      pathPlaceholder: 'D:\\OneDrive\\dsh-sync',
      branchPlaceholder: 'main',
      gitHint: 'Use a private repository. Each sync writes one snapshot commit and always fast-forwards.',
      dirHint: 'Point this at a folder already synced by Syncthing, OneDrive or similar.',
      mapTitle: 'Directory mapping',
      mapHint:
        'One rule per line: “remote prefix => local prefix”. The prefix is rewritten when the workspace registry is merged, so this device stores files under its own path. Leave empty to require identical paths on both devices.',
      mapPlaceholder: 'D:\\Data\\code => E:\\code',
      scopeTitle: 'What to sync',
      scopeSessions: 'Session history only',
      scopeSessionsHint: 'Session logs and the workspace registry. Smallest and safest.',
      scopeWorkspace: 'Sessions + workspace files',
      scopeWorkspaceHint:
        'Also copy files inside workspace folders (Git-aware: .gitignore is respected, node_modules and similar are skipped).',
      scopeFull: 'Everything',
      scopeFullHint: 'Adds uploaded attachments and settings.yaml on top of workspace files.',
      wsFilesTitle: 'Workspace files',
      wsFilesHint:
        'Choose which workspace folders take part in file sync. A workspace switched off is neither uploaded nor pulled back.',
      noWorkspaces: 'No workspaces are registered yet.',
      missingDir: 'folder missing',
      filesCount: '{files} files · {bytes}',
      off: 'Off',
      autoTitle: 'Automatic sync',
      autoOff: 'Off',
      autoInterval: 'Every N minutes',
      autoIdle: 'After N minutes idle',
      autoStartup: 'Once at startup',
      autoMinutes: 'Minutes',
      autoHint:
        '“Idle” waits until no session has been written for N minutes. “Interval” runs on a fixed schedule. Manual sync is always available.',
      target: 'Target',
      none: 'Not configured',
      local: 'This device',
      remote: 'Remote',
      pending: 'Pending',
      pendingValue: 'to push {push} · to pull {pull}',
      lastSync: 'Last sync',
      never: 'never',
      sync: 'Sync now',
      pull: 'Pull only',
      backup: 'Export backup',
      refresh: 'Refresh',
      working: 'Working…',
      restoreTitle: 'Restore from a backup',
      restoreHint: 'Path to a dsh-backup-*.zip produced by “Export backup”. A safety backup is written first.',
      restore: 'Restore',
      placeholder: 'D:\\Backups\\dsh-backup-2026-01-01_12-00-00.zip',
      doneSync: 'Synced: pushed {push} file(s), pulled {pull} file(s).',
      donePull: 'Pulled {pull} file(s).',
      doneBackup: 'Backup written to {file}',
      doneRestore: 'Restored {files} file(s).',
      conflicts: '{count} conflicting file(s) were kept locally; the other version is preserved in the repository under conflicts/.',
      restart: 'Newly pulled workspaces may need a DSH restart before they appear in the sidebar.',
      skipped: '{count} file(s) were skipped because their workspace folder does not exist here.',
      localLine: '{sessions} sessions · {files} workspace files · {bytes}',
      remoteLine: '{sessions} sessions · {files} workspace files · {bytes}',
      openSettings: 'Open sync page',
      statusReady: 'Up to date',
      statusPending: '{count} pending',
      statusError: 'Last sync failed',
      statusUnconfigured: 'Not configured',
    }

    const zh = {
      nav: '同步与备份',
      panel: '同步',
      title: '同步与备份',
      intro:
        '把会话日志、工作区登记（可选：工作区目录文件）备份到 Git 仓库或共享目录，并在多台设备之间合并。',
      configTitle: '同步目标',
      kindGit: 'Git 仓库',
      kindDir: '共享文件夹',
      save: '保存',
      saved: '已保存。',
      remotePlaceholder: 'git@github.com:you/dsh-sync.git',
      pathPlaceholder: 'D:\\OneDrive\\dsh-sync',
      branchPlaceholder: 'main',
      gitHint: '建议使用私有仓库；每次同步提交一个快照，始终快进推送。',
      dirHint: '填写已由 Syncthing、OneDrive 等同步的本地目录。',
      mapTitle: '目录映射',
      mapHint:
        '一行一条，「远端前缀 => 本机前缀」。合并工作区登记时按前缀改写路径，本机就落到自己的目录；留空表示要求两端路径完全一致。',
      mapPlaceholder: 'D:\\Data\\code => E:\\code',
      scopeTitle: '同步层级',
      scopeSessions: '仅会话历史',
      scopeSessionsHint: '会话日志 + 工作区登记。体积最小、最安全。',
      scopeWorkspace: '会话 + 工作区文件',
      scopeWorkspaceHint: '再加上工作区目录里的文件；Git 仓库会遵守 .gitignore，并跳过 node_modules 等目录。',
      scopeFull: '全部',
      scopeFullHint: '在工作区文件基础上，再包含上传的附件与 settings.yaml。',
      wsFilesTitle: '工作区文件',
      wsFilesHint: '选择哪些工作区的目录文件参与同步；关闭的工作区既不上传，也不会从远端拉回。',
      noWorkspaces: '还没有登记任何工作区。',
      missingDir: '目录不存在',
      filesCount: '{files} 个文件 · {bytes}',
      off: '关闭',
      autoTitle: '自动同步',
      autoOff: '关闭',
      autoInterval: '每 N 分钟',
      autoIdle: '空闲 N 分钟后',
      autoStartup: '启动时一次',
      autoMinutes: '分钟',
      autoHint: '「空闲」指 N 分钟内没有新的会话写入；「定时」按固定间隔执行。手动同步始终可用。',
      target: '同步目标',
      none: '尚未配置',
      local: '本机',
      remote: '远端',
      pending: '待同步',
      pendingValue: '待推送 {push} · 待拉取 {pull}',
      lastSync: '上次同步',
      never: '从未',
      sync: '立即同步',
      pull: '仅拉取',
      backup: '导出备份',
      refresh: '刷新',
      working: '处理中…',
      restoreTitle: '从备份恢复',
      restoreHint: '填写「导出备份」生成的 dsh-backup-*.zip 路径；恢复前会先生成一份当前状态的备份。',
      restore: '恢复',
      placeholder: 'D:\\Backups\\dsh-backup-2026-01-01_12-00-00.zip',
      doneSync: '同步完成：推送 {push} 个文件，拉取 {pull} 个文件。',
      donePull: '拉取完成：{pull} 个文件。',
      doneBackup: '备份已写入 {file}',
      doneRestore: '恢复完成：{files} 个文件。',
      conflicts: '有 {count} 个冲突文件保留了本机版本，另一版本已保存在仓库 conflicts/ 目录。',
      restart: '新拉取的工作区可能需要重启 DSH 才会出现在侧栏。',
      skipped: '有 {count} 个文件因本机没有对应工作区目录而跳过。',
      localLine: '{sessions} 个会话 · {files} 个工作区文件 · {bytes}',
      remoteLine: '{sessions} 个会话 · {files} 个工作区文件 · {bytes}',
      openSettings: '打开同步面板',
      statusReady: '已同步',
      statusPending: '{count} 项待同步',
      statusError: '上次同步失败',
      statusUnconfigured: '未配置',
    }

    const CSS = [
      '.dsy_page{width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.dsy_scroll{scrollbar-gutter:stable;flex:1;min-height:0;overflow:auto}',
      '.dsy_content{max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px;display:flex;flex-direction:column;gap:14px}',
      '.dsy_section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dsy_heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px}',
      '.dsy_h1{margin:0;font-size:20px;font-weight:500;line-height:28px}',
      '.dsy_sub{margin:0;font-size:18px;font-weight:600}',
      '.dsy_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);max-width:760px}',
      '.dsy_card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:4px 16px}',
      '.dsy_row{display:flex;align-items:baseline;justify-content:space-between;gap:24px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px}',
      '.dsy_row:last-child{border-bottom:0}',
      '.dsy_label{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dsy_value{color:var(--dsw-alias-label-primary);text-align:right;min-width:0;overflow-wrap:anywhere}',
      '.dsy_mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
      '.dsy_actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dsy_btn{font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}',
      '.dsy_btn:disabled{opacity:.5;cursor:default}',
      '.dsy_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsy_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.dsy_notice{font-size:12px;line-height:18px;margin:0}',
      '.dsy_ok{color:var(--dsw-alias-state-success-primary)}',
      '.dsy_err{color:var(--dsw-alias-state-error-primary)}',
      '.dsy_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.dsy_subtitle{margin:6px 0 0;font-size:14px;font-weight:600}',
      '.dsy_inline{display:flex;gap:8px}',
      '.dsy_inlineTop{display:flex;gap:8px;align-items:flex-start}',
      '.dsy_textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;min-height:46px;resize:vertical;flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsy_input{flex:1;min-width:0;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsy_branch{flex:none;max-width:120px}',
      '.dsy_seg{display:inline-flex;gap:4px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;width:fit-content;flex-wrap:wrap}',
      '.dsy_segbtn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsy_segbtn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsy_segbtn:disabled{opacity:.5;cursor:default}',
      '.dsy_options{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;max-width:760px}',
      '.dsy_option{text-align:left;font:inherit;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_option[data-active="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
      '.dsy_option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsy_optionTitle{font-size:13px;line-height:20px;font-weight:600}',
      '.dsy_optionHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.dsy_wsrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsy_wsrow:last-child{border-bottom:0}',
      '.dsy_wsMain{flex:1;min-width:0}',
      '.dsy_wsTitle{font-size:13px;line-height:20px;font-weight:500}',
      '.dsy_wsPath{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsy_wsMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsy_switch{position:relative;flex:none;width:34px;height:20px;border-radius:10px;border:0;padding:0;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .12s}',
      '.dsy_switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsy_switch:disabled{opacity:.5;cursor:default}',
      '.dsy_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsy_switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .12s}',
      '.dsy_switch[data-on="true"] .dsy_switchKnob{left:16px}',
      '.dsy_dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}',
      '.dsy_badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsy_footer{display:flex;align-items:center;gap:8px;font:inherit;font-size:13px;line-height:20px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;max-width:100%;text-align:left}',
      '.dsy_footer:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsy_footer[data-wide="false"]{justify-content:center;padding:6px 0}',
      '.dsy_footer[data-active="true"]{color:var(--dsw-alias-label-primary)}',
      '.dsy_footerLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsy_iconbtn{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;cursor:pointer;padding:0;width:100%;height:100%}',
      '.dsy_iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:8px}',
    ].join('\n')

    function injectCss() {
      const tagId = '@local/dsh-sync/panel.css'
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-sync'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (match, key) {
        return values[key] === undefined || values[key] === null ? match : String(values[key])
      })
    }

    async function call(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + response.status)
      return body.data
    }

    function fmtTime(value) {
      if (!value) return null
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    }

    /** 同步状态与操作；面板、设置页、底栏共用。 */
    function useSyncState() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const refresh = useCallback(async (silent) => {
        if (!silent) setBusy('status')
        try {
          const next = await call('status')
          if (!alive.current) return
          setStatus(next)
          if (!silent && next && next.lastError) setNotice({ tone: 'err', text: next.lastError })
        } catch (error) {
          if (!silent) setNotice({ tone: 'err', text: String(error.message || error) })
        } finally {
          if (!silent) setBusy(null)
        }
      }, [])

      useEffect(() => {
        refresh(true)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh(true)
        }, 60000)
        return () => clearInterval(timer)
      }, [refresh])

      const run = useCallback(
        async (action, payload, successText) => {
          setBusy(action)
          setNotice(null)
          try {
            const data = await call(action, payload)
            if (successText) setNotice({ tone: 'ok', text: successText(data) })
            const next = await call('status')
            if (!alive.current) return
            setStatus(next)
          } catch (error) {
            setNotice({ tone: 'err', text: String(error.message || error) })
          } finally {
            setBusy(null)
          }
        },
        [],
      )

      return { status, busy, notice, refresh, run, setNotice }
    }

    /** 状态点颜色。 */
    function toneOf(status) {
      if (!status) return 'idle'
      if (!status.ready) return 'idle'
      if (status.lastError) return 'error'
      if (status.pending && status.pending.known && status.pending.toPush + status.pending.toPull > 0) return 'warn'
      return 'ok'
    }

    function dotColor(tone) {
      switch (tone) {
        case 'ok':
          return 'var(--dsw-alias-state-success-primary)'
        case 'warn':
          return 'var(--dsw-alias-state-warn-primary)'
        case 'error':
          return 'var(--dsw-alias-state-error-primary)'
        default:
          return 'var(--dsw-alias-state-idle-primary)'
      }
    }

    function statusLabel(status, t) {
      if (!status) return t('working')
      if (!status.ready) return t('statusUnconfigured')
      if (status.lastError) return t('statusError')
      if (status.pending && status.pending.known) {
        const count = status.pending.toPush + status.pending.toPull
        if (count > 0) return format(t('statusPending'), { count })
      }
      return t('statusReady')
    }

    function SyncIcon(props) {
      const size = props.size || 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M7 18a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18.3 9.6 4.2 4.2 0 0 1 17.8 18H7z' }),
        h('path', { d: 'M9.5 13.2 12 10.7l2.5 2.5' }),
        h('path', { d: 'M12 10.9v5.4' }),
      )
    }

    /** 侧栏底部的状态栏：状态点 + 标签，点击打开同步面板。 */
    function FooterAction(props) {
      const t = props.t
      const wide = props.wide !== false
      const openPanel = props.openPanel
      const { status } = useSyncState()
      const tone = toneOf(status)
      const label = statusLabel(status, t)
      return h(
        'button',
        {
          type: 'button',
          className: 'dsy_footer',
          'data-wide': wide ? 'true' : 'false',
          title: t('panel') + ' · ' + label,
          'aria-label': t('panel'),
          onClick: openPanel,
        },
        h('span', { className: 'dsy_dot', style: { background: dotColor(tone) } }),
        wide ? h('span', { className: 'dsy_footerLabel' }, t('panel')) : null,
      )
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsy_row' },
        h('span', { className: 'dsy_label' }, props.label),
        h('span', { className: 'dsy_value' + (props.mono ? ' dsy_mono' : '') }, props.children),
      )
    }

    function SyncBody(props) {
      const t = props.t
      const state = useSyncState()
      const status = state.status
      const busy = state.busy
      const notice = state.notice
      const [restorePath, setRestorePath] = useState('')
      const [draft, setDraft] = useState({ kind: 'git', remote: '', branch: 'main', path: '' })
      const [minutesDraft, setMinutesDraft] = useState('15')
      const [mapDraft, setMapDraft] = useState('')
      const hydrated = useRef(false)

      useEffect(() => {
        if (!status || hydrated.current) return
        hydrated.current = true
        setDraft({
          kind: status.target.kind,
          remote: status.target.kind === 'git' && status.ready ? status.target.description : '',
          branch: status.target.branch || 'main',
          path: status.target.kind === 'directory' && status.ready ? status.target.description : '',
        })
        setMapDraft((status.pathMap || []).join('\n'))
      }, [status])

      const auto = (status && status.autoSync) || { mode: 'off', minutes: 15 }
      useEffect(() => {
        setMinutesDraft(String(auto.minutes))
      }, [auto.minutes])

      const pending = status && status.pending && status.pending.known ? status.pending : null
      const workspaces = (status && status.workspaces) || []
      const disabled = busy !== null
      const scope = (status && status.scope) || 'sessions'

      const commitMinutes = () => {
        const minutes = Number(minutesDraft)
        if (!Number.isFinite(minutes) || minutes < 1) {
          setMinutesDraft(String(auto.minutes))
          return
        }
        const clamped = Math.min(1440, Math.round(minutes))
        setMinutesDraft(String(clamped))
        if (clamped === auto.minutes) return
        state.run('configure', { autoMode: auto.mode, autoMinutes: clamped }, () => t('saved'))
      }

      const syncSummary = (data) => {
        const lines = [
          format(t(data.mode === 'pull' ? 'donePull' : 'doneSync'), {
            push: data.pushed ? data.pushed.files : 0,
            pull: data.pulled ? data.pulled.files : 0,
          }),
        ]
        if (data.conflicts && data.conflicts.length > 0) lines.push(format(t('conflicts'), { count: data.conflicts.length }))
        if (data.skipped && data.skipped.length > 0) lines.push(format(t('skipped'), { count: data.skipped.length }))
        if (data.pulled && data.pulled.files > 0) lines.push(t('restart'))
        return lines.join(' ')
      }

      const scopeOptions = [
        { id: 'sessions', title: t('scopeSessions'), hint: t('scopeSessionsHint') },
        { id: 'workspace', title: t('scopeWorkspace'), hint: t('scopeWorkspaceHint') },
        { id: 'full', title: t('scopeFull'), hint: t('scopeFullHint') },
      ]
      const autoOptions = [
        { id: 'off', title: t('autoOff') },
        { id: 'interval', title: t('autoInterval') },
        { id: 'idle', title: t('autoIdle') },
        { id: 'startup', title: t('autoStartup') },
      ]

      return h(
        'div',
        { className: props.variant === 'page' ? 'dsy_content' : 'dsy_section' },
        props.variant === 'page'
          ? h(
              'div',
              { className: 'dsy_heading' },
              h('h1', { className: 'dsy_h1' }, t('title')),
              h(
                'span',
                { className: 'dsy_badge' },
                h('span', { className: 'dsy_dot', style: { background: dotColor(toneOf(status)) } }),
                statusLabel(status, t),
              ),
            )
          : h('h2', { className: 'dsy_sub' }, t('title')),
        h('p', { className: 'dsy_intro' }, t('intro')),

        h('h3', { className: 'dsy_subtitle' }, t('scopeTitle')),
        h(
          'div',
          { className: 'dsy_options', role: 'radiogroup' },
          scopeOptions.map((option) =>
            h(
              'button',
              {
                key: option.id,
                type: 'button',
                role: 'radio',
                'aria-checked': scope === option.id,
                className: 'dsy_option',
                'data-active': scope === option.id ? 'true' : undefined,
                disabled: disabled,
                onClick: () => state.run('configure', { scope: option.id }, () => t('saved')),
              },
              h('div', { className: 'dsy_optionTitle' }, option.title),
              h('div', { className: 'dsy_optionHint' }, option.hint),
            ),
          ),
        ),

        scope !== 'sessions'
          ? h(
              React.Fragment,
              null,
              h('h3', { className: 'dsy_subtitle' }, t('wsFilesTitle')),
              h('p', { className: 'dsy_hint' }, t('wsFilesHint')),
              workspaces.length === 0
                ? h('p', { className: 'dsy_hint' }, t('noWorkspaces'))
                : h(
                    'div',
                    { className: 'dsy_card' },
                    workspaces.map((workspace) =>
                      h(
                        'div',
                        { className: 'dsy_wsrow', key: workspace.id },
                        h(
                          'div',
                          { className: 'dsy_wsMain' },
                          h('div', { className: 'dsy_wsTitle' }, workspace.title),
                          h(
                            'div',
                            { className: 'dsy_wsPath', title: workspace.path },
                            workspace.path + (workspace.exists ? '' : ' · ' + t('missingDir')),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'dsy_wsMeta' },
                          workspace.syncFiles
                            ? format(t('filesCount'), { files: workspace.files, bytes: workspace.bytesText })
                            : t('off'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            role: 'switch',
                            className: 'dsy_switch',
                            'data-on': workspace.syncFiles ? 'true' : undefined,
                            'aria-checked': workspace.syncFiles,
                            'aria-label': workspace.title,
                            disabled: disabled,
                            onClick: () =>
                              state.run(
                                'configure',
                                { workspaceFiles: { include: { [workspace.id]: !workspace.syncFiles } } },
                                () => t('saved'),
                              ),
                          },
                          h('span', { className: 'dsy_switchKnob' }),
                        ),
                      ),
                    ),
                  ),
            )
          : null,

        h('h3', { className: 'dsy_subtitle' }, t('autoTitle')),
        h(
          'div',
          { className: 'dsy_actions' },
          h(
            'div',
            { className: 'dsy_seg', role: 'radiogroup' },
            autoOptions.map((option) =>
              h(
                'button',
                {
                  key: option.id,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': auto.mode === option.id,
                  className: 'dsy_segbtn',
                  'data-active': auto.mode === option.id ? 'true' : undefined,
                  disabled: disabled,
                  onClick: () =>
                    state.run('configure', { autoMode: option.id, autoMinutes: auto.minutes }, () => t('saved')),
                },
                option.title,
              ),
            ),
          ),
          auto.mode === 'interval' || auto.mode === 'idle'
            ? h('input', {
                className: 'dsy_input dsy_branch',
                type: 'number',
                min: 1,
                max: 1440,
                value: minutesDraft,
                'aria-label': t('autoMinutes'),
                onChange: (event) => setMinutesDraft(event.target.value),
                onBlur: commitMinutes,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitMinutes()
                  }
                },
              })
            : null,
        ),
        h('p', { className: 'dsy_hint' }, t('autoHint')),

        h('h3', { className: 'dsy_subtitle' }, t('configTitle')),
        h(
          'div',
          { className: 'dsy_seg', role: 'group' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_segbtn',
              'data-active': draft.kind === 'git' ? 'true' : undefined,
              onClick: () => setDraft(Object.assign({}, draft, { kind: 'git' })),
            },
            t('kindGit'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_segbtn',
              'data-active': draft.kind === 'directory' ? 'true' : undefined,
              onClick: () => setDraft(Object.assign({}, draft, { kind: 'directory' })),
            },
            t('kindDir'),
          ),
        ),
        h(
          'div',
          { className: 'dsy_inline' },
          h('input', {
            className: 'dsy_input',
            type: 'text',
            spellCheck: false,
            value: draft.kind === 'git' ? draft.remote : draft.path,
            placeholder: draft.kind === 'git' ? t('remotePlaceholder') : t('pathPlaceholder'),
            onChange: (event) => {
              const patch = {}
              patch[draft.kind === 'git' ? 'remote' : 'path'] = event.target.value
              setDraft(Object.assign({}, draft, patch))
            },
          }),
          draft.kind === 'git'
            ? h('input', {
                className: 'dsy_input dsy_branch',
                type: 'text',
                spellCheck: false,
                value: draft.branch,
                placeholder: t('branchPlaceholder'),
                onChange: (event) => setDraft(Object.assign({}, draft, { branch: event.target.value })),
              })
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => state.run('configure', draft, () => t('saved')),
            },
            busy === 'configure' ? t('working') : t('save'),
          ),
        ),
        h('p', { className: 'dsy_hint' }, draft.kind === 'git' ? t('gitHint') : t('dirHint')),

        h('h3', { className: 'dsy_subtitle' }, t('mapTitle')),
        h('p', { className: 'dsy_hint' }, t('mapHint')),
        h(
          'div',
          { className: 'dsy_inlineTop' },
          h('textarea', {
            className: 'dsy_textarea',
            rows: 2,
            spellCheck: false,
            placeholder: t('mapPlaceholder'),
            value: mapDraft,
            onChange: (event) => setMapDraft(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => state.run('configure', { pathMap: mapDraft }, () => t('saved')),
            },
            busy === 'configure' ? t('working') : t('save'),
          ),
        ),

        h(
          'div',
          { className: 'dsy_card' },
          h(Row, { label: t('target'), mono: true }, status && status.ready ? status.target.description + (status.target.branch ? ' @ ' + status.target.branch : '') : t('none')),
          h(
            Row,
            { label: t('local') },
            status
              ? format(t('localLine'), {
                  sessions: status.local.sessions,
                  files: status.local.workspaceFiles,
                  bytes: status.local.bytesText,
                })
              : t('working'),
          ),
          h(
            Row,
            { label: t('remote') },
            status && status.remote
              ? format(t('remoteLine'), {
                  sessions: status.remote.sessions === undefined ? '?' : status.remote.sessions,
                  files: status.remote.workspaceFiles === undefined ? '?' : status.remote.workspaceFiles,
                  bytes: status.remote.bytesText || '?',
                }) + ' · ' + (fmtTime(status.remote.updatedAt) || '?')
              : t('never'),
          ),
          h(
            Row,
            { label: t('pending') },
            pending ? format(t('pendingValue'), { push: pending.toPush, pull: pending.toPull }) : '—',
          ),
          h(Row, { label: t('lastSync') }, (status && fmtTime(status.lastSyncAt)) || t('never')),
        ),

        h(
          'div',
          { className: 'dsy_actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn dsy_primary',
              disabled: disabled || !(status && status.ready),
              onClick: () => state.run('push', undefined, syncSummary),
            },
            busy === 'push' ? t('working') : t('sync'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled || !(status && status.ready),
              onClick: () => state.run('pull', undefined, syncSummary),
            },
            busy === 'pull' ? t('working') : t('pull'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => state.run('backup', undefined, (data) => format(t('doneBackup'), { file: data.file })),
            },
            busy === 'backup' ? t('working') : t('backup'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => state.refresh(false),
            },
            busy === 'status' ? t('working') : t('refresh'),
          ),
        ),

        notice
          ? h('p', { className: 'dsy_notice ' + (notice.tone === 'ok' ? 'dsy_ok' : 'dsy_err') }, notice.text)
          : null,

        h('h3', { className: 'dsy_subtitle' }, t('restoreTitle')),
        h('p', { className: 'dsy_hint' }, t('restoreHint')),
        h(
          'div',
          { className: 'dsy_inline' },
          h('input', {
            className: 'dsy_input',
            type: 'text',
            spellCheck: false,
            placeholder: t('placeholder'),
            value: restorePath,
            onChange: (event) => setRestorePath(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled || restorePath.trim().length === 0,
              onClick: () =>
                state.run('restore', { file: restorePath.trim() }, (data) =>
                  format(t('doneRestore'), { files: data.files }),
                ),
            },
            busy === 'restore' ? t('working') : t('restore'),
          ),
        ),
      )
    }

    function SyncPage(props) {
      return h(
        'div',
        { className: 'dsy_page' },
        h('div', { className: 'dsy_scroll' }, h(SyncBody, { t: props.t, variant: 'page' })),
      )
    }

    function SyncSection(props) {
      return h(SyncBody, { t: props.t, variant: 'section' })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-sync: locale')
        ctx.effect(() => injectCss(), 'dsh-sync: styles')

        const openPanel = () => {
          const layout = ctx.get('layout')
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, SyncPage),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') },
            SyncIcon,
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-sync-status', order: 20, locale: NS, inject: () => ({ openPanel }) },
            FooterAction,
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-sync', order: 42, label: () => t('nav'), locale: NS },
            SyncSection,
          ),
        )
      },
    }
  },
})
