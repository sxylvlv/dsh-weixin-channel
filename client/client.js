/**
 * 「微信通道」设置页 —— 静态客户端模块。
 *
 * 加载契约（照 DSH 已安装的 dshmarket 抄的，无需打包器）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ... })
 *   factory 返回一个 Cordis 客户端插件 { name, inject, apply }。
 *
 * 与动态版的区别：静态模块拿不到 `host.call`（那是动态包专用），
 * 所以数据与动作都走宿主半注册的同源本机路由（`lib/ui-server.mjs`）。
 * 好处：二维码直接 `<img src="/dsh-weixin/qr.png">`，不经过 base64。
 */
window.__ModuleLoader__.load({
  id: 'dsh-weixin-channel',
  factory: (require) => {
    const React = require('react')

    const PREFIX = '/dsh-weixin'

    async function api(path, body) {
      const options = body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
      const res = await fetch(PREFIX + path, options)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }

    const C = {
      card: { border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      h: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
      grid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 },
      k: { opacity: 0.65 },
      btn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsh-border, #3a3a3a)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      btnPrimary: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsh-accent, #4c8dff)', background: 'var(--dsh-accent, #4c8dff)', color: '#fff', cursor: 'pointer', fontSize: 13 },
      input: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, #3a3a3a)', background: 'transparent', color: 'inherit', fontSize: 13, width: 140 },
      pre: { margin: 0, fontSize: 11, lineHeight: 1.5, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.85 },
      dim: { fontSize: 12, opacity: 0.6 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    }

    function tag(ok, text) {
      return React.createElement('span', { style: { color: ok ? '#4ec97a' : '#e06c6c', fontWeight: 600 } }, text)
    }

    function button(label, onClick, primary, disabled) {
      return React.createElement('button', {
        type: 'button',
        style: primary ? C.btnPrimary : C.btn,
        onClick: onClick,
        disabled: disabled,
      }, label)
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [code, setCode] = React.useState('')
      const [note, setNote] = React.useState('')
      const [tick, setTick] = React.useState(0)

      function refresh() {
        api('/status')
          .then((r) => { setState(r || null) })
          .catch((e) => { setNote('读取状态失败：' + String(e)) })
      }

      React.useEffect(function () {
        refresh()
        const timer = setInterval(function () {
          refresh()
          setTick(function (n) { return n + 1 })
        }, 3000)
        return function () { clearInterval(timer) }
      }, [])

      function run(label, path, body) {
        setBusy(label)
        setNote('')
        api(path, body || {})
          .then(function (r) {
            setBusy('')
            if (r && r.ok === false) setNote('失败：' + String(r.error || '未知错误'))
            else setNote(label + '：已提交')
            setTimeout(refresh, 900)
          })
          .catch(function (e) { setBusy(''); setNote(label + ' 失败：' + String(e)) })
      }

      if (state === null) return React.createElement('div', { style: C.dim }, '正在读取通道状态…')

      const mount = state.mount || {}
      const login = state.login || {}
      const accounts = state.accounts || []
      const running = mount.stage === 'running'

      const statusCard = React.createElement('div', { style: C.card },
        React.createElement('h3', { style: C.h }, '通道状态'),
        React.createElement('div', { style: C.grid },
          React.createElement('div', { style: C.k }, '运行'),
          React.createElement('div', null, running ? tag(true, 'running') : tag(false, String(mount.stage || '未知'))),
          React.createElement('div', { style: C.k }, '构建'),
          React.createElement('div', null, String(mount.build || '—')),
          React.createElement('div', { style: C.k }, '宿主 pid'),
          React.createElement('div', null, String(mount.pid || '—')),
          React.createElement('div', { style: C.k }, '当前账号'),
          React.createElement('div', null, String(mount.accountId || '—')),
          React.createElement('div', { style: C.k }, '看门狗'),
          React.createElement('div', null, state.watchdog && state.watchdog.alive ? '运行中' : '未运行'),
          React.createElement('div', { style: C.k }, '状态时间'),
          React.createElement('div', null, String(mount.at || '—'))),
        React.createElement('div', { style: { ...C.row, marginTop: 10 } },
          button('刷新', refresh, false, busy !== ''),
          button(busy === '重载通道' ? '重载中…' : '重载通道', function () { run('重载通道', '/reload') }, false, busy !== ''),
          React.createElement('span', { style: C.dim }, '换号后才需要重载')),
        note ? React.createElement('div', { style: { marginTop: 8, fontSize: 12, color: '#e0a36c' } }, note) : null)

      const loginCard = React.createElement('div', { style: C.card },
        React.createElement('h3', { style: C.h }, '扫码登录 / 换一个微信'),
        login.hasQr
          ? React.createElement('div', null,
              React.createElement('img', {
                src: PREFIX + '/qr.png?t=' + tick,
                alt: '登录二维码',
                width: 240,
                height: 240,
                style: { background: '#fff', borderRadius: 8, padding: 8, display: 'block' },
              }),
              React.createElement('div', { style: { ...C.dim, marginTop: 6 } },
                login.running ? '手机微信扫码；过期会自动换新码，图每 3 秒刷新' : '以上是上一次登录留下的二维码（可能已过期），重新点「开始扫码登录」拿新码'),
              login.qrUrl ? React.createElement('div', { style: { ...C.dim, marginTop: 4, wordBreak: 'break-all' } }, '原始链接：' + login.qrUrl) : null)
          : React.createElement('div', { style: C.dim }, login.running ? '正在取二维码…' : '当前没有进行中的登录'),
        React.createElement('div', { style: { ...C.row, marginTop: 10 } },
          button(login.running ? '登录进行中…' : '开始扫码登录', function () { run('开始扫码登录', '/login-start') }, true, busy !== '' || login.running),
          login.running ? button('停止登录', function () { run('停止登录', '/login-stop') }, false, busy !== '') : null,
          React.createElement('span', { style: C.dim }, login.running ? '不换号就点「停止登录」' : '')),
        login.running
          ? React.createElement('div', { style: { ...C.row, marginTop: 10 } },
              React.createElement('input', {
                style: C.input,
                value: code,
                placeholder: '手机上的数字',
                onChange: function (e) { setCode(e.target.value) },
              }),
              button('提交确认码', function () { run('提交确认码', '/login-verify', { code: code }); setCode('') }, false, busy !== '' || code === ''),
              React.createElement('span', { style: C.dim }, '微信要求数字时填这里'))
          : null,
        (login.progressLines && login.progressLines.length > 0)
          ? React.createElement('pre', { style: { ...C.pre, marginTop: 10, maxHeight: 140 } }, login.progressLines.join('\n'))
          : null)

      const accountsCard = React.createElement('div', { style: C.card },
        React.createElement('h3', { style: C.h }, '已登录账号（' + accounts.length + '）'),
        accounts.length === 0
          ? React.createElement('div', { style: C.dim }, '还没有账号，点上面的「开始扫码登录」')
          : React.createElement('div', { style: C.grid }, accounts.flatMap(function (a) {
              return [
                React.createElement('div', { key: a.id + '-k', style: C.k }, a.id),
                React.createElement('div', { key: a.id + '-v' }, (a.userId || '未知扫码者') + (a.savedAt ? ' · ' + a.savedAt : '')),
              ]
            })))

      const logCard = React.createElement('div', { style: C.card },
        React.createElement('h3', { style: C.h }, '最近日志'),
        React.createElement('pre', { style: C.pre }, (state.logLines || []).join('\n')))

      return React.createElement('div', { style: { padding: '4px 2px 24px' } }, statusCard, loginCard, accountsCard, logCard)
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'weixin-channel', order: 30, label: '微信通道' },
          Panel,
        )
      })
    }

    return {
      name: 'dsh-weixin-channel',
      inject: ['slots'],
      apply: apply,
    }
  },
})
