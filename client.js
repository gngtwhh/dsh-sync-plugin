/**
 * dsh-sync Client 半：设置 → 同步 页面。
 * 只通过 POST /api/dsh-sync 调用 Host 端同一套操作（与模型工具共用实现），
 * 样式全部使用主题 token，不依赖任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dshSync'
    const API = 'api/dsh-sync'

    const en = {
      nav: 'Sync & backup',
      title: 'Sync & backup',
      intro:
        'Back up workspace registrations and session logs to a Git remote or a shared folder, and merge another device’s sessions back in. Credentials and caches are never included.',
      configTitle: 'Sync target',
      kindGit: 'Git repository',
      kindDir: 'Shared folder',
      save: 'Save',
      saved: 'Target saved.',
      remotePlaceholder: 'git@github.com:you/dsh-sync.git',
      pathPlaceholder: 'D:\\OneDrive\\dsh-sync',
      branchPlaceholder: 'main',
      gitHint: 'Use a private repository. Each sync writes one snapshot commit and always fast-forwards.',
      dirHint: 'Point this at a folder already synced by Syncthing, OneDrive or similar.',
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
      conflicts: '{count} conflicting file(s) were kept locally; the remote copies are under the conflicts folder.',
      restart: 'Newly pulled workspaces may need a DSH restart before they appear in the sidebar.',
      error: 'Failed',
    }

    const zh = {
      nav: '同步与备份',
      title: '同步与备份',
      intro:
        '把工作区登记与会话日志备份到 Git 仓库或共享目录，并合并另一台设备的会话。凭据与缓存不会包含在内。',
      configTitle: '同步目标',
      kindGit: 'Git 仓库',
      kindDir: '共享文件夹',
      save: '保存',
      saved: '目标已保存。',
      remotePlaceholder: 'git@github.com:you/dsh-sync.git',
      pathPlaceholder: 'D:\\OneDrive\\dsh-sync',
      branchPlaceholder: 'main',
      gitHint: '建议使用私有仓库；每次同步提交一个快照，始终快进推送。',
      dirHint: '填写已由 Syncthing、OneDrive 等同步的本地目录。',
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
      conflicts: '有 {count} 个冲突文件保留了本机版本，远端版本已存到 conflicts 目录。',
      restart: '新拉取的工作区可能需要重启 DSH 才会出现在侧栏。',
      error: '失败',
    }

    const CSS = [
      '.dsy_section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dsy_title{margin:0;font-size:18px;font-weight:600}',
      '.dsy_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsy_card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:4px 16px}',
      '.dsy_row{display:flex;align-items:baseline;justify-content:space-between;gap:24px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px}',
      '.dsy_row:last-child{border-bottom:0}',
      '.dsy_label{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dsy_value{color:var(--dsw-alias-label-primary);text-align:right;min-width:0;overflow-wrap:anywhere}',
      '.dsy_mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
      '.dsy_actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.dsy_btn{font:inherit;font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}',
      '.dsy_btn:disabled{opacity:.5;cursor:default}',
      '.dsy_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsy_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.dsy_notice{font-size:12px;line-height:18px;margin:0}',
      '.dsy_ok{color:var(--dsw-alias-state-success-primary)}',
      '.dsy_err{color:var(--dsw-alias-state-error-primary)}',
      '.dsy_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.dsy_subtitle{margin:4px 0 0;font-size:14px;font-weight:600}',
      '.dsy_inline{display:flex;gap:8px}',
      '.dsy_input{flex:1;min-width:0;font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsy_input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsy_branch{flex:none;max-width:120px}',
      '.dsy_seg{display:inline-flex;gap:4px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;width:fit-content}',
      '.dsy_segbtn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsy_segbtn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsy_segbtn:disabled{opacity:.5;cursor:default}',
    ].join('\n')

    function injectCss() {
      const tagId = '@local/dsh-sync/section.css'
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
        body: JSON.stringify({ action: action, ...(payload || {}) }),
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

    function TargetValue(props) {
      const status = props.status
      const t = props.t
      if (!status) return h('span', { className: 'dsy_value' }, t('working'))
      if (!status.ready) return h('span', { className: 'dsy_value' }, t('none'))
      const text = status.target.description + (status.target.branch ? ' @ ' + status.target.branch : '')
      return h('span', { className: 'dsy_value dsy_mono' }, text)
    }

    function SyncSection(props) {
      const t = props.t
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [restorePath, setRestorePath] = useState('')
      const [draft, setDraft] = useState({ kind: 'git', remote: '', branch: 'main', path: '' })
      const hydrated = useRef(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const apply = useCallback((next) => {
        if (!alive.current) return
        setStatus(next)
        if (next && !hydrated.current) {
          hydrated.current = true
          setDraft({
            kind: next.target.kind,
            remote: next.target.kind === 'git' && next.ready ? next.target.description : '',
            branch: next.target.branch || 'main',
            path: next.target.kind === 'directory' && next.ready ? next.target.description : '',
          })
        }
      }, [])

      const refresh = useCallback(
        async (silent) => {
          if (!silent) setBusy('status')
          try {
            const next = await call('status')
            apply(next)
            if (!silent && next && next.lastError) setNotice({ tone: 'err', text: next.lastError })
          } catch (error) {
            if (!silent) setNotice({ tone: 'err', text: String(error.message || error) })
          } finally {
            if (!silent) setBusy(null)
          }
        },
        [apply],
      )

      useEffect(() => {
        refresh(true)
      }, [refresh])

      const run = useCallback(
        async (action, payload, successText) => {
          setBusy(action)
          setNotice(null)
          try {
            const data = await call(action, payload)
            setNotice({ tone: 'ok', text: successText(data) })
            const next = await call('status')
            apply(next)
          } catch (error) {
            setNotice({ tone: 'err', text: String(error.message || error) })
          } finally {
            setBusy(null)
          }
        },
        [apply],
      )

      const syncSummary = (data) => {
        const lines = [
          format(t(data.mode === 'pull' ? 'donePull' : 'doneSync'), {
            push: data.pushed ? data.pushed.files : 0,
            pull: data.pulled ? data.pulled.files : 0,
          }),
        ]
        if (data.conflicts && data.conflicts.length > 0) {
          lines.push(format(t('conflicts'), { count: data.conflicts.length }))
        }
        if (data.pulled && data.pulled.files > 0) lines.push(t('restart'))
        return lines.join(' ')
      }

      const pending = status && status.pending && status.pending.known ? status.pending : null
      const disabled = busy !== null

      return h(
        'div',
        { className: 'dsy_section' },
        h('h2', { className: 'dsy_title' }, t('title')),
        h('p', { className: 'dsy_intro' }, t('intro')),

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
              onClick: () => run('configure', draft, () => t('saved')),
            },
            busy === 'configure' ? t('working') : t('save'),
          ),
        ),
        h('p', { className: 'dsy_hint' }, draft.kind === 'git' ? t('gitHint') : t('dirHint')),

        h(
          'div',
          { className: 'dsy_card' },
          h(
            'div',
            { className: 'dsy_row' },
            h('span', { className: 'dsy_label' }, t('target')),
            h(TargetValue, { status: status, t: t }),
          ),
          h(
            'div',
            { className: 'dsy_row' },
            h('span', { className: 'dsy_label' }, t('local')),
            h(
              'span',
              { className: 'dsy_value' },
              status ? status.local.sessions + ' / ' + status.local.bytesText : t('working'),
            ),
          ),
          h(
            'div',
            { className: 'dsy_row' },
            h('span', { className: 'dsy_label' }, t('remote')),
            h(
              'span',
              { className: 'dsy_value' },
              status && status.remote
                ? (status.remote.sessions === undefined ? '?' : status.remote.sessions) +
                    ' / ' +
                    (status.remote.bytesText || '?') +
                    ' · ' +
                    (fmtTime(status.remote.updatedAt) || '?')
                : t('never'),
            ),
          ),
          h(
            'div',
            { className: 'dsy_row' },
            h('span', { className: 'dsy_label' }, t('pending')),
            h(
              'span',
              { className: 'dsy_value' },
              pending ? format(t('pendingValue'), { push: pending.toPush, pull: pending.toPull }) : '—',
            ),
          ),
          h(
            'div',
            { className: 'dsy_row' },
            h('span', { className: 'dsy_label' }, t('lastSync')),
            h('span', { className: 'dsy_value' }, (status && fmtTime(status.lastSyncAt)) || t('never')),
          ),
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
              onClick: () => run('push', undefined, syncSummary),
            },
            busy === 'push' ? t('working') : t('sync'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled || !(status && status.ready),
              onClick: () => run('pull', undefined, syncSummary),
            },
            busy === 'pull' ? t('working') : t('pull'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => run('backup', undefined, (data) => format(t('doneBackup'), { file: data.file })),
            },
            busy === 'backup' ? t('working') : t('backup'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsy_btn',
              disabled: disabled,
              onClick: () => refresh(false),
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
                run('restore', { file: restorePath.trim() }, (data) => format(t('doneRestore'), { files: data.files })),
            },
            busy === 'restore' ? t('working') : t('restore'),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-sync: locale')
        ctx.effect(() => injectCss(), 'dsh-sync: styles')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-sync',
              order: 42,
              label: () => t('nav'),
              locale: NS,
            },
            SyncSection,
          ),
        )
      },
    }
  },
})
