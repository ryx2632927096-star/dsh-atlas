window.__ModuleLoader__.load({
  id: "dsh-atlas",
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")
    const h = react.createElement
    const useState = react.useState
    const useEffect = react.useEffect
    const useCallback = react.useCallback

    const PANEL_ID = "dsh-atlas-panel"
    const API = "/dsh-atlas-api"
    const NS = "dsh-atlas"

    const LAYOUT_ATTR = "data-dsh-atlas-sidebar-layout"
    const LAYOUT_LS = "dsh-atlas-sidebar-layout-v1"

    const LAYOUT_MODES = [
      { key: "normal", label: "标准", hint: "一列，拉多宽都不变" },
      { key: "grid", label: "多栏", hint: "按侧栏实际宽度自动排列，拉宽就多一栏" },
      { key: "icons", label: "只留图标", hint: "隐藏文字，图标放大，鼠标放上去显示名字" },
    ]

    const LEGACY_MODE_MAP = { grid2: "grid", grid3: "grid", collapsed: "normal" }

    function layoutCss(cfg) {
      const mode = cfg.mode || "normal"
      const rules = []
      const maxList = Number.isFinite(cfg.maxListHeight) ? cfg.maxListHeight : 420

      rules.push(`[class*="_panelList"] { max-height: ${maxList}px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }`)

      if (mode === "grid" || mode === "icons") {
        const minW = mode === "icons" ? 52 : 84
        rules.push(`[class*="_panelList"] {
          display: grid !important;
          flex-direction: row !important;
          grid-template-columns: repeat(auto-fit, minmax(${minW}px, 1fr)) !important;
          gap: 4px !important;
          align-content: start !important;
          align-items: stretch !important;
        }`)
        rules.push(`[class*="_panelList"] > * { min-width: 0 !important; }`)
      }

      if (mode === "icons") {
        rules.push(`[class*="_panelList"] [class*="_panelTitle"] { display: none !important; }`)

        rules.push(`[class*="_panelList"] > * {
          justify-content: center !important;
          padding-inline: 0 !important;
          min-height: 42px !important;
          border-radius: 8px !important;
        }`)

        rules.push(`[class*="_panelList"] [class*="_panelGlyph"] {
          margin-inline: auto !important;
          font-size: 20px !important;
          line-height: 1 !important;
          width: 32px !important;
          height: 32px !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
        }`)

        rules.push(`[class*="_panelList"] > * { position: relative; }`)
        rules.push(`[class*="_panelList"] > *:hover [class*="_panelTitle"] {
          display: block !important;
          position: fixed !important;
          z-index: 99999 !important;
          margin: 0 !important;
          padding: 4px 9px !important;
          border-radius: 6px !important;
          background: var(--dsw-alias-bg-elevated, #2b2b2b) !important;
          color: var(--dsw-alias-label-primary, #fff) !important;
          font-size: 12px !important;
          line-height: 1.4 !important;
          white-space: nowrap !important;
          pointer-events: none !important;
          box-shadow: 0 2px 10px rgba(0,0,0,.35) !important;
          transform: translateX(46px) translateY(2px) !important;
        }`)
      }

      return "/* dsh-atlas 侧栏布局，随时可在设置里恢复默认 */\n" + rules.join("\n")
    }

    function loadLayout() {
      try {
        const raw = localStorage.getItem(LAYOUT_LS)
        if (!raw) return { mode: "normal", maxListHeight: 420 }
        const j = JSON.parse(raw)
        const stored = typeof j.mode === "string" ? j.mode : "normal"
        const mode = LEGACY_MODE_MAP[stored] || stored
        return {
          mode: mode === "icons" ? "icons" : "normal",
          maxListHeight: Number.isFinite(j.maxListHeight) ? j.maxListHeight : 420,
        }
      } catch {
        return { mode: "normal", maxListHeight: 420 }
      }
    }

    function applyLayout(cfg) {
      try {
        let tag = document.head.querySelector("style[" + LAYOUT_ATTR + "]")
        if (!tag) {
          tag = document.createElement("style")
          tag.setAttribute(LAYOUT_ATTR, "1")
          document.head.appendChild(tag)
        }
        tag.textContent = layoutCss(cfg)
        try { localStorage.setItem(LAYOUT_LS, JSON.stringify(cfg)) } catch {   }
        return true
      } catch {
        return false
      }
    }

    function removeLayout() {
      try {
        const tag = document.head.querySelector("style[" + LAYOUT_ATTR + "]")
        if (tag) tag.remove()
        localStorage.removeItem(LAYOUT_LS)
        return true
      } catch {
        return false
      }
    }

    const C = {
      fg: "var(--dsw-alias-label-primary, #17171a)",
      sub: "var(--dsw-alias-label-secondary, #6b6b73)",
      faint: "var(--dsw-alias-label-tertiary, #9a9aa2)",
      line: "var(--dsw-alias-border-base, #e6e6e9)",
      lineSoft: "var(--dsw-alias-border-subtle, #f0f0f2)",
      card: "var(--dsw-alias-bg-elevated, #fafafb)",
      bg: "var(--dsw-alias-bg-base, #ffffff)",
      ok: "var(--dsw-alias-status-success, #2f9e5b)",
      warn: "var(--dsw-alias-status-warning, #c07f10)",
      err: "var(--dsw-alias-status-danger, #d24545)",
      accent: "var(--dsw-alias-brand-primary, #4a5fa8)",
      accentSoft: "rgba(74,95,168,.10)",
      okSoft: "rgba(47,158,91,.10)",
      warnSoft: "rgba(192,127,16,.10)",
      errSoft: "rgba(210,69,69,.08)",
    }

    const MONO = "ui-monospace, 'SF Mono', Consolas, monospace"

    const S = {
      page: { padding: "20px 24px 32px", color: C.fg, fontSize: "13px", lineHeight: 1.6, overflowY: "auto", height: "100%", boxSizing: "border-box" },
      h1: { fontSize: "18px", fontWeight: 650, margin: 0, letterSpacing: "-0.01em" },
      sub: { color: C.sub, fontSize: "12.5px", margin: "4px 0 0" },

      tabs: { display: "flex", gap: "2px", borderBottom: "1px solid " + C.line, margin: "16px 0" },
      tab: { padding: "7px 12px", fontSize: "13px", cursor: "pointer", border: "none", background: "transparent", color: C.sub, borderBottom: "2px solid transparent", marginBottom: "-1px", borderRadius: 0 },
      tabOn: { color: C.fg, borderBottom: "2px solid " + C.accent, fontWeight: 600 },

      section: { paddingTop: "20px", marginTop: "20px", borderTop: "1px solid " + C.lineSoft },
      sectionFirst: { paddingTop: 0, marginTop: 0, borderTop: "none" },
      card: { border: "1px solid " + C.line, borderRadius: "10px", padding: "16px", marginBottom: "12px", background: C.bg },
      cardTight: { border: "1px solid " + C.line, borderRadius: "10px", padding: "12px 14px", marginBottom: "8px", background: C.bg },

      secTitle: { fontSize: "13px", fontWeight: 600, margin: "0 0 4px" },
      secHint: { fontSize: "12px", color: C.sub, margin: "0 0 12px" },

      row: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid " + C.lineSoft },

      grid: function (n) {
        const cols = Math.min(n || 6, 6)
        return {
          display: "grid",
          gridTemplateColumns: "repeat(" + cols + ", minmax(0, 1fr))",
          gap: "1px",
          background: C.line,
          border: "1px solid " + C.line,
          borderRadius: "10px",
          overflow: "hidden",
        }
      },
      stat: { background: C.bg, padding: "16px 16px 14px" },
      input: {
        flex: 1,
        minWidth: 0,
        fontFamily: "inherit",
        fontSize: "11.5px",
        padding: "5px 8px",
        borderRadius: "6px",
        border: "1px solid " + C.line,
        background: C.bg,
        color: C.fg,
        outline: "none",
      },
      btnPrimary: {
        fontFamily: "inherit",
        fontSize: "11.5px",
        padding: "5px 12px",
        borderRadius: "6px",
        border: "1px solid transparent",
        background: C.accent,
        color: "#fff",
        cursor: "pointer",
      },
      statNum: { fontSize: "22px", fontWeight: 650, lineHeight: "1.15", letterSpacing: "-0.02em", fontFamily: MONO },
      statLabel: { fontSize: "11.5px", color: C.sub, marginTop: "4px" },
      statHint: { fontSize: "11px", color: C.faint, marginTop: "2px" },

      mono: { fontFamily: MONO, fontSize: "11.5px" },
      meta: { fontSize: "11.5px", color: C.sub },
      empty: { color: C.faint, padding: "28px 0", textAlign: "center", fontSize: "12.5px" },
      err: { color: C.err, fontSize: "12px", padding: "10px 12px", background: C.errSoft, borderRadius: "8px", marginBottom: "12px" },

      table: { width: "100%", borderCollapse: "collapse", fontSize: "12.5px" },
      th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid " + C.line, color: C.sub, fontWeight: 500, fontSize: "11.5px" },
      td: { padding: "9px 10px", borderBottom: "1px solid " + C.lineSoft, verticalAlign: "top" },

      badge: function (color, soft) {
        return { display: "inline-flex", alignItems: "center", gap: "5px", padding: "1px 8px", borderRadius: "999px", fontSize: "11.5px", fontWeight: 500, color: color, background: soft || "rgba(128,128,128,.10)" }
      },
      dot: function (color) { return { display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: color, flex: "0 0 auto" } },
      tag: { display: "inline-flex", alignItems: "center", padding: "1px 7px", borderRadius: "4px", fontSize: "11px", background: "rgba(128,128,128,.10)", color: C.sub, marginLeft: "8px" },
      btn: { padding: "5px 12px", fontSize: "12.5px", borderRadius: "7px", border: "1px solid " + C.line, background: C.bg, color: C.fg, cursor: "pointer" },
      btnOn: { background: C.accentSoft, borderColor: C.accent, color: C.accent, fontWeight: 600 },
      kv: { display: "flex", justifyContent: "space-between", gap: "12px", padding: "7px 0", borderBottom: "1px solid " + C.lineSoft, fontSize: "12.5px" },
    }

    const CACHE = new Map()

    function fetchEndpoint(name) {
      if (CACHE.has(name)) return CACHE.get(name)
      const p = fetch(API + "/" + name, { headers: { accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status)
          return r.json()
        })
        .catch(function (e) {
          CACHE.delete(name)
          throw e
        })
      CACHE.set(name, p)
      return p
    }

    function prefetch(name) {
      try { fetchEndpoint(name).catch(function () {}) } catch {   }
    }

    function useEndpoint(name) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const load = useCallback(function (force) {
        setState(function (s) { return { loading: true, data: s.data, error: null } })
        if (force) CACHE.delete(name)
        fetchEndpoint(name)
          .then(function (d) { setState({ loading: false, data: d, error: null }) })
          .catch(function (e) { setState({ loading: false, data: null, error: String((e && e.message) || e) }) })
      }, [name])
      useEffect(function () { load(false) }, [load])
      return { state: state, reload: function () { load(true) } }
    }


    function Stat(props) {
      return h("div", { style: S.stat }, [
        h("div", { key: "n", style: S.statNum }, String(props.value)),
        h("div", { key: "l", style: S.statLabel }, props.label),
        props.hint ? h("div", { key: "h", style: S.statHint }, props.hint) : null,
      ])
    }

    function Sev(props) {
      const lv = props.level || "?"
      const color = lv === "high" ? C.err : lv === "medium" ? C.warn : C.sub
      const soft = lv === "high" ? C.errSoft : lv === "medium" ? C.warnSoft : "rgba(128,128,128,.10)"
      const text = lv === "high" ? "高" : lv === "medium" ? "中" : lv === "low" ? "低" : String(lv)
      return h("span", { style: S.badge(color, soft) }, [h("span", { key: "d", style: S.dot(color) }), text])
    }

    function Verdict(props) {
      const v = props.verdict
      const color = v === "keep-one" ? C.warn : v === "coexist" ? C.ok : C.sub
      const soft = v === "keep-one" ? C.warnSoft : v === "coexist" ? C.okSoft : "rgba(128,128,128,.10)"
      const text = v === "keep-one" ? "建议只留一个" : v === "coexist" ? "可以共存" : "判定不了"
      return h("span", { style: S.badge(color, soft) }, [h("span", { key: "d", style: S.dot(color) }), text])
    }

    function StatusDot(props) {
      const ok = props.status === "applied"
      return h("span", {
        style: S.badge(ok ? C.ok : C.err, ok ? C.okSoft : C.errSoft),
        title: props.status,
      }, [h("span", { key: "d", style: S.dot(ok ? C.ok : C.err) }), ok ? "生效中" : "已失效"])
    }

    function ErrBox(props) {
      if (!props.errors || !props.errors.length) return null
      return h("div", { style: S.err }, "部分数据读取失败：" + props.errors.join("；"))
    }

    function Loading(props) {
      const rows = (props && props.rows) || 4
      return h("div", { style: { padding: "20px 0" } },
        Array.from({ length: rows }, function (_, i) {
          return h("div", {
            key: i,
            style: { height: "14px", marginBottom: "12px", borderRadius: "4px", background: C.lineSoft, width: (90 - i * 12) + "%" },
          })
        }))
    }

    function SectionTitle(props) {
      return h("div", { style: { marginBottom: props.hint ? "12px" : "8px" } }, [
        h("div", { key: "t", style: S.secTitle }, props.title),
        props.hint ? h("div", { key: "h", style: { ...S.secHint, margin: "2px 0 0" } }, props.hint) : null,
      ])
    }

    function OverviewTab() {
      const ep = useEndpoint("overview")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) {
        return h("div", null, [
          h("div", { key: "e", style: S.err }, "接口不可用：" + ep.state.error),
          h("div", { key: "h", style: { color: C.sub, fontSize: "12px" } }, "宿主侧 /dsh-atlas-api/overview 没响应。可能插件刚更新还没热重载，按一次头部刷新按钮。"),
          h("button", { key: "b", onClick: ep.reload, style: S.btn }, "重试"),
        ])
      }
      const d = ep.state.data || {}
      const p = d.patches
      const idx = d.index || {}
      const sf = d.surface
      const ps = (p && p.summary) || {}
      const allApplied = ps.total > 0 && ps.applied === ps.total

      return h("div", null, [
        h(ErrBox, { key: "err", errors: d.errors }),

        h("div", {
          key: "sum",
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "8px",
            background: allApplied ? C.okSoft : C.errSoft,
            marginBottom: "16px",
          },
        }, [
          h("span", { key: "bar", style: { width: "3px", alignSelf: "stretch", borderRadius: "2px", background: allApplied ? C.ok : C.err, flex: "0 0 auto" } }),
          h("div", { key: "c", style: { minWidth: 0 } }, [
            h("div", { key: "t", style: { fontSize: "13px", fontWeight: 600, color: allApplied ? C.ok : C.err } },
              allApplied
                ? `一切正常：${ps.total} 个补丁都在生效`
                : (ps.total ? `${ps.total - ps.applied} 个补丁失效了，需要处理` : "还没有补丁定义")),
            h("div", { key: "h", style: { fontSize: "12px", color: C.sub, marginTop: "2px" } },
              allApplied ? "下面这些数字是这台机器当前的状况。" : "看下面「补丁状态」，失效的那条会写明原因。"),
          ]),
        ]),

        h("div", { key: "s1", style: S.grid(6) }, [
          h(Stat, { key: "a", value: ps.applied || 0, label: "补丁生效", hint: ps.total ? "共 " + ps.total + " 个" : "" }),
          h(Stat, { key: "b", value: idx.sessions || 0, label: "已索引会话" }),
          h(Stat, { key: "c", value: idx.tool_calls || 0, label: "工具调用" }),
          h(Stat, { key: "d", value: idx.distinct_tools || 0, label: "用过的工具" }),
          h(Stat, { key: "e", value: sf ? sf.totals.surface : 0, label: "可用工具" }),
          h(Stat, { key: "f", value: sf ? sf.totals.unused : 0, label: "没用过的", hint: "知道有，但没调过" }),
        ]),

        d.pluginScopeNote ? h("div", { key: "scope", style: { ...S.meta, color: C.faint, marginTop: "8px", lineHeight: 1.5 } },
          d.pluginScopeNote) : null,

        h("div", { key: "p", style: S.section }, [
          h(SectionTitle, { key: "t", title: "补丁状态", hint: "补丁 = 你对插件源码做的小改动。作者更新后可能被覆盖，这里看它们还在不在。" }),
          p && p.items && p.items.length
            ? h("div", { key: "l" }, p.items.map(function (it, i) {
                return h("div", {
                  key: it.id,
                  style: i === p.items.length - 1
                    ? { padding: "12px 0" }
                    : { padding: "12px 0", borderBottom: "1px solid " + C.lineSoft },
                }, [
                  h("div", { key: "r1", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
                    h(StatusDot, { key: "s", status: it.status }),
                    h("span", { key: "n", style: { fontSize: "13px" } }, it.name || it.id),
                    it.manual ? h("span", { key: "m", style: { ...S.meta, color: C.warn } }, "需手工重放") : null,
                    h("span", { key: "sp", style: { flex: 1 } }),
                    h(Sev, { key: "v", level: it.severity }),
                  ]),
                  it.detail ? h("div", { key: "r2", style: { ...S.meta, color: C.faint, marginTop: "2px", paddingLeft: "2px" } }, it.detail) : null,
                ])
              }))
            : h("div", { key: "e", style: S.empty }, "还没有补丁定义"),
        ]),

        d.tools && d.tools.length ? h("div", { key: "tl", style: S.section }, [
          h(SectionTitle, { key: "t", title: "最常用工具", hint: "从你自己的会话记录里数出来的，不是猜的。" }),
          h("table", { key: "tb", style: S.table }, [
            h("thead", { key: "h" }, h("tr", null, [
              h("th", { key: "a", style: S.th }, "工具"),
              h("th", { key: "b", style: { ...S.th, textAlign: "right" } }, "调用次数"),
              h("th", { key: "c", style: { ...S.th, textAlign: "right" } }, "报错"),
            ])),
            h("tbody", { key: "b" }, d.tools.map(function (t) {
              return h("tr", { key: t.tool }, [
                h("td", { key: "a", style: { ...S.td, ...S.mono } }, t.tool),
                h("td", { key: "b", style: { ...S.td, textAlign: "right", ...S.mono } }, String(t.calls)),
                h("td", { key: "c", style: { ...S.td, textAlign: "right", ...S.mono, color: t.errors ? C.err : C.faint } }, String(t.errors)),
              ])
            })),
          ]),
        ]) : null,
      ])
    }

    function PluginsTab() {
      const [reportFor, setReportFor] = useState(null)
      const [reportUrl, setReportUrl] = useState("")
      const [reportMsg, setReportMsg] = useState("")
      const [toggles, setToggles] = useState({})
      const [toggleBusy, setToggleBusy] = useState(null)
      const [toggleConfirm, setToggleConfirm] = useState(null)
      const [toggleMsg, setToggleMsg] = useState("")
      function loadToggles() {
        fetch(API + "/toggle-plugin")
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (!j || !j.items) return
            const m = {}
            for (const it of j.items) m[it.id] = it
            setToggles(m)
          })
          .catch(function () {   })
      }
      if (typeof useEffect === "function") {
        useEffect(function () { loadToggles() }, [])
      }

      function doToggle(pluginId, disable) {
        setToggleBusy(pluginId)
        setToggleMsg("")
        fetch(API + "/toggle-plugin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pluginId: pluginId, disable: disable }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j } }) })
          .then(function (x) {
            setToggleBusy(null)
            if (x.ok) {
              setToggleMsg(x.j.note || "已写入")
              setToggleConfirm(null)
              loadToggles()
              if (ep.reload) ep.reload()
            } else {
              setToggleMsg("失败：" + (x.j.error || "未知"))
            }
          })
          .catch(function (e) { setToggleBusy(null); setToggleMsg("失败：" + e.message) })
      }
      function submitReport(pluginId, badUrl) {
        fetch(API + "/report-link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pluginId, url: badUrl, correctUrl: reportUrl.trim() || null }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j } }) })
          .then(function (x) {
            setReportMsg(x.ok ? "已记录，刷新后生效" : "失败：" + (x.j.error || "未知"))
            if (x.ok) setTimeout(function () { setReportFor(null); setReportMsg(""); setReportUrl("") }, 1200)
          })
          .catch(function (e) { setReportMsg("失败：" + e.message) })
      }

      const ep = useEndpoint("plugins")
      const [q, setQ] = useState("")
      const [onlyMod, setOnlyMod] = useState(false)
      const [mode, setMode] = useState("family")
      const [open, setOpen] = useState(null)
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const all = d.plugins || []
      const families = d.families || []
      const fs = d.familySummary

      const k = q.toLowerCase()
      const match = function (text) { return !k || String(text || "").toLowerCase().indexOf(k) >= 0 }

      const famList = families.filter(function (f) {
        if (onlyMod && (!f.modified || !f.modified.length)) return false
        if (!k) return true
        if (match(f.name) || match(f.repo)) return true
        if (f.members.some(function (m) { return match(m.id) })) return true
        return f.tools.some(function (t) { return match(t) })
      })

      const pkgList = all.filter(function (p) {
        if (onlyMod && (!p.modified || !p.modified.files || !p.modified.files.length)) return false
        if (!k) return true
        return match(p.id) || (p.tools || []).some(function (t) { return match(t) })
      })

      const seg = function (on) {
        return on
          ? { ...S.btn, ...S.btnOn, padding: "4px 11px", borderRadius: "6px" }
          : { ...S.btn, padding: "4px 11px", borderRadius: "6px", color: C.sub }
      }

      const bar = h("div", { key: "bar", style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" } }, [
        h("div", { key: "m", style: { display: "flex", gap: "4px" } }, [
          h("button", { key: "f", onClick: function () { setMode("family") }, style: seg(mode === "family") }, "按家族"),
          h("button", { key: "p", onClick: function () { setMode("package") }, style: seg(mode === "package") }, "按包"),
        ]),
        h("input", {
          key: "i", value: q, placeholder: "搜家族 / 包名 / 工具名…",
          onChange: function (e) { setQ(e.target.value) },
          style: { ...S.btn, width: "260px", paddingLeft: "10px" },
        }),
        h("label", { key: "l", style: { fontSize: "12.5px", color: C.sub, display: "flex", gap: "6px", alignItems: "center", cursor: "pointer" } }, [
          h("input", { key: "c", type: "checkbox", checked: onlyMod, onChange: function (e) { setOnlyMod(e.target.checked) } }),
          "只看本地改过的",
        ]),
        h("span", { key: "c", style: { ...S.meta, marginLeft: "auto" } },
          fs
            ? fs.families + " 个家族 · " + fs.packages + " 个包 · " + fs.enabled + " 个已启用"
            : (d.total || 0) + " 个包"),
      ])

      function renderFamily(f) {
        const isOpen = open === f.key
        const mods = f.modified || []
        const ver = f.versionConflict ? (f.versions || []).join(" · ") : (f.version || "?")
        const childCount = (f.children || []).length
        const expandable = f.packageCount > 1 || childCount > 0

        return h("div", { key: f.key, style: { borderBottom: "1px solid " + C.lineSoft } }, [
          h("div", {
            key: "h",
            onClick: expandable ? function () { setOpen(isOpen ? null : f.key) } : undefined,
            style: { display: "flex", alignItems: "flex-start", gap: "10px", padding: "11px 0", cursor: expandable ? "pointer" : "default" },
          }, [
            h("span", { key: "t", style: { ...S.mono, color: C.faint, width: "11px", flex: "0 0 auto", lineHeight: "19px" } },
              expandable ? (isOpen ? "▾" : "▸") : ""),
            h("div", { key: "n", style: { flex: 1, minWidth: 0 } }, [
              h("div", { key: "a", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
                h("span", { key: "name", style: { fontWeight: 600, fontSize: "13px" } }, f.name),
                h("span", { key: "ver", style: { ...S.mono, fontSize: "11px", color: C.faint } }, ver),
                f.versionConflict ? h("span", { key: "vc", style: { ...S.badge(C.warn, C.warnSoft) } }, "版本不一致") : null,
                f.aggregateRole === "aggregate"
                  ? h("span", { key: "agg", style: S.badge(C.accent, C.accentSoft) },
                      (f.children && f.children.length) ? "聚合 " + f.children.length + " 个子仓库" : "聚合仓库")
                  : null,
              ]),
              h("div", { key: "b", style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "3px", flexWrap: "wrap" } }, [
                !f.inBundles ? h("span", { key: "nb", style: { ...S.meta, color: C.faint } }, "未启用") : null,
                f.packageCount > 1 ? h("span", { key: "pc", style: S.meta }, f.packageCount + " 个包") : null,
                childCount ? h("span", { key: "cc", style: { ...S.meta, color: C.accent } }, "+" + childCount + " 子仓库") : null,
                f.tools && f.tools.length ? h("span", { key: "tl", style: S.meta }, f.tools.length + " 个工具") : null,
                f.patchIds && f.patchIds.length ? h("span", { key: "pt", style: S.meta, color: C.warn }, f.patchIds.length + " 个补丁") : null,
                f.sourceTypes && f.sourceTypes.length ? h("span", { key: "st", style: { ...S.meta, color: C.faint } }, f.sourceTypes.join(" / ")) : null,
                f.aggregateNote ? h("span", { key: "agn", style: { ...S.meta, color: C.faint, flexBasis: "100%" } }, f.aggregateNote) : null,
                (function () {
                  const head = (d.plugins || []).filter(function (p) { return p.id === f.headId })[0]
                  const up = head && head.upstream
                  if (!up || !up.url) return null
                  const isInferred = !up.verified
                  const key = head.id
                  return h("span", { key: "rp", style: { display: "inline-flex", alignItems: "center", gap: "4px" } }, [
                    h("a", {
                      key: "a",
                      href: up.url,
                      target: "_blank",
                      rel: "noreferrer noopener",
                      title: up.note,
                      onClick: function (e) { e.stopPropagation() },
                      style: { ...S.meta, color: C.accent, textDecoration: "none" },
                    }, isInferred ? "GitHub ↗（推断）" : "GitHub ↗"),
                    isInferred ? h("button", {
                      key: "r",
                      onClick: function (e) {
                        e.stopPropagation()
                        setReportFor(reportFor === key ? null : key)
                        setReportUrl("")
                        setReportMsg("")
                      },
                      style: { ...S.meta, background: "transparent", border: "none", padding: "0 2px", color: C.faint, cursor: "pointer" },
                    }, "不对？") : null,
                  ])
                })(),
              ]),
              (function () {
                const st = toggles[f.headId]
                if (!st || !st.known) return null
                return h("div", { key: "tg", style: { marginTop: "6px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
                  h("button", {
                    key: "b",
                    onClick: function (e) {
                      e.stopPropagation()
                      setToggleConfirm({ id: f.headId, name: f.name, disable: !st.disabled })
                      setToggleMsg("")
                    },
                    style: {
                      ...S.btn,
                      color: st.disabled ? C.ok : C.warn,
                      borderColor: st.disabled ? C.line : C.warn,
                    },
                  }, toggleBusy === f.headId ? "写入中…" : (st.disabled ? "已停用 · 点此启用" : "启用中 · 点此停用")),
                  toggleMsg ? h("span", { key: "m", style: { ...S.meta, color: toggleMsg.indexOf("失败") === 0 ? C.err : C.ok } }, toggleMsg) : null,
                ])
              })(),

              reportFor === f.headId ? h("div", {
                key: "rbox",
                onClick: function (e) { e.stopPropagation() },
                style: { marginTop: "6px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
              }, [
                h("span", { key: "l", style: { ...S.meta, color: C.faint } }, "正确地址："),
                h("input", {
                  key: "i",
                  value: reportUrl,
                  placeholder: "https://github.com/owner/repo（留空 = 删掉这个链接）",
                  onChange: function (e) { setReportUrl(e.target.value) },
                  style: { ...S.input, flex: "1 1 260px" },
                }),
                h("button", {
                  key: "s",
                  onClick: function () {
                    const head = (d.plugins || []).filter(function (p) { return p.id === f.headId })[0]
                    submitReport(f.headId, head && head.upstream ? head.upstream.url : null)
                  },
                  style: S.btnPrimary,
                }, "提交"),
                reportMsg ? h("span", { key: "m", style: { ...S.meta, color: reportMsg.indexOf("失败") === 0 ? C.err : C.ok } }, reportMsg) : null,
              ]) : null,

              mods.length ? h("div", { key: "mf", style: { marginTop: "5px", display: "flex", alignItems: "flex-start", gap: "6px" } }, [
                h("span", { key: "d", style: { ...S.dot(C.warn), marginTop: "6px" } }),
                h("span", { key: "tx", style: { ...S.mono, fontSize: "11px", color: C.warn, wordBreak: "break-all" } }, mods.join("　")),
              ]) : null,
            ]),
            f.isSelf ? h("span", { key: "self", style: S.badge(C.accent, C.accentSoft) }, "本插件") : null,
          ]),

          isOpen && childCount ? h("div", { key: "kids", style: { padding: "2px 0 10px 21px" } }, [
            h("div", { key: "h", style: { ...S.meta, color: C.faint, marginBottom: "4px" } },
              "这个仓库用子模块锁着 " + childCount + " 个下游仓库："),
            f.children.map(function (c) {
              return h("div", { key: c.key, style: { display: "flex", gap: "8px", alignItems: "center", padding: "4px 0", fontSize: "12px" } }, [
                h("span", { key: "a", style: { ...S.mono, color: C.faint } }, "└"),
                h("span", { key: "n", style: { ...S.mono, flex: 1, minWidth: 0 } }, c.name),
                h("span", { key: "v", style: { ...S.mono, fontSize: "11px", color: C.faint } }, c.version || "?"),
                c.tools && c.tools.length ? h("span", { key: "t", style: S.meta }, c.tools.length + " 工具") : null,
              ])
            }),
          ]) : null,

          isOpen ? h("div", { key: "mem", style: { padding: "0 0 12px 21px" } },
            f.members.map(function (m) {
              return h("div", { key: m.id, style: { display: "flex", gap: "10px", alignItems: "center", padding: "4px 0", fontSize: "12px" } }, [
                h("span", { key: "n", style: { ...S.mono, flex: 1, minWidth: 0, color: C.sub } }, m.id),
                h("span", { key: "v", style: { ...S.mono, fontSize: "11px", color: C.faint } }, m.version || "?"),
                m.inBundles ? null : h("span", { key: "b", style: { ...S.meta, color: C.faint } }, "未启用"),
                m.tools && m.tools.length ? h("span", { key: "t", style: S.meta }, m.tools.length + " 工具") : null,
                m.modified && m.modified.length ? h("span", { key: "m", style: S.badge(C.warn, C.warnSoft) }, "改过") : null,
              ])
            })) : null,
        ])
      }

      function renderPackage(p) {
        const mods = (p.modified && p.modified.files) || []
        return h("div", { key: p.id, style: { borderBottom: "1px solid " + C.lineSoft, padding: "11px 0" } }, [
          h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
            h("span", { key: "n", style: { fontWeight: 600, fontSize: "13px" } }, p.id),
            h("span", { key: "v", style: { ...S.mono, fontSize: "11px", color: C.faint } }, p.version || "?"),
            p.isSelf ? h("span", { key: "self", style: S.badge(C.accent, C.accentSoft) }, "本插件") : null,
          ]),
          h("div", { key: "b", style: { display: "flex", gap: "8px", marginTop: "3px", flexWrap: "wrap", alignItems: "center" } }, [
            p.inBundles ? null : h("span", { key: "nb", style: { ...S.meta, color: C.faint } }, "未启用"),
            h("span", { key: "s", style: { ...S.meta, color: C.faint } }, p.sourceType),
            p.patchIds && p.patchIds.length ? h("span", { key: "pt", style: { ...S.meta, color: C.warn } }, p.patchIds.length + " 个补丁") : null,
            p.tools && p.tools.length ? h("span", { key: "t", style: S.meta }, p.tools.length + " 个工具") : null,
            p.upstream && p.upstream.url
              ? h("a", {
                  key: "up",
                  href: p.upstream.url,
                  target: "_blank",
                  rel: "noreferrer noopener",
                  title: p.upstream.note,
                  style: { ...S.meta, color: C.accent, textDecoration: "none" },
                }, p.upstream.verified ? "GitHub ↗" : "GitHub ↗（推断）")
              : h("span", { key: "no", title: p.upstream ? p.upstream.note : "", style: { ...S.meta, color: C.faint } },
                  p.upstream && p.upstream.source === "本地安装" ? "本地源码" : "无上游"),
          ]),
          mods.length ? h("div", { key: "mf", style: { ...S.mono, fontSize: "11px", color: C.warn, marginTop: "4px", wordBreak: "break-all" } }, mods.join("　")) : null,
        ])
      }

      return h("div", null, [
        h(ErrBox, { key: "err", errors: d.errors }),

        toggleConfirm ? h("div", {
          key: "confirm",
          style: { ...S.card, background: C.warnSoft, borderColor: "transparent", marginBottom: "16px" },
        }, [
          h("div", { key: "t", style: { fontSize: "13px", fontWeight: 600, color: C.warn } },
            (toggleConfirm.disable ? "停用 " : "启用 ") + toggleConfirm.name + "？"),
          h("div", { key: "d", style: { ...S.meta, marginTop: "6px", lineHeight: 1.7 } }, [
            h("div", { key: "1" }, toggleConfirm.disable
              ? "停用后这个插件提供的工具和面板会消失，直到你重新启用。"
              : "启用后它的工具和面板会重新出现。"),
            h("div", { key: "2" }, "不用重启 DSH。刷新页面后生效。"),
            h("div", { key: "3" }, "只改 cordis.patch.yml 里的 disabled 标记，不动 package.json。写前会先自动备份。"),
          ]),
          h("div", { key: "b", style: { display: "flex", gap: "8px", marginTop: "10px" } }, [
            h("button", {
              key: "ok",
              onClick: function () { doToggle(toggleConfirm.id, toggleConfirm.disable) },
              style: { ...S.btnPrimary, background: C.warn },
            }, toggleBusy ? "写入中…" : (toggleConfirm.disable ? "确认停用" : "确认启用")),
            h("button", {
              key: "no",
              onClick: function () { setToggleConfirm(null) },
              style: S.btn,
            }, "取消"),
          ]),
        ]) : null,
        bar,
        d.attribution ? h("div", { key: "at", style: { fontSize: "12px", color: C.sub, marginBottom: "10px" } },
          "工具归属：已归属 " + d.attribution.owned + " 个｜多义 " + d.attribution.ambiguous + " 个｜未识别 " + d.attribution.unattributed + " 个｜扫描 " + d.attribution.scannedFiles + " 个文件") : null,
        h("div", { key: "list" }, mode === "family"
          ? (famList.length === 0
            ? h("div", { style: S.empty }, "没有匹配的家族")
            : famList.map(renderFamily))
          : (pkgList.length === 0
            ? h("div", { style: S.empty }, "没有匹配的包")
            : pkgList.map(renderPackage))),

        mode === "family" && (d.dependencies || []).length
          ? h("div", { key: "deps", style: { marginTop: "20px" } }, [
              h("div", {
                key: "h",
                onClick: function () { setOpen(open === "_deps" ? null : "_deps") },
                style: { cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", paddingTop: "16px", borderTop: "1px solid " + C.lineSoft },
              }, [
                h("span", { key: "t", style: { ...S.mono, color: C.faint } }, open === "_deps" ? "▾" : "▸"),
                h("span", { key: "n", style: { ...S.meta, fontWeight: 600 } }, "依赖包"),
                h("span", { key: "c", style: { ...S.meta, color: C.faint } }, (d.dependencies || []).length + " 个"),
                h("span", { key: "d", style: { ...S.meta, color: C.faint } }, "· 别人用的零件，不是你装的插件"),
              ]),
              open === "_deps" ? h("div", { key: "l", style: { paddingTop: "6px" } },
                (d.dependencies || []).map(function (x, i) {
                  return h("div", { key: x.id, style: i === d.dependencies.length - 1 ? { padding: "7px 0 0 21px" } : { padding: "7px 0 0 21px", borderBottom: "1px solid " + C.lineSoft } }, [
                    h("div", { key: "n", style: { ...S.mono, fontSize: "11.5px" } }, x.id),
                    x.description ? h("div", { key: "d", style: { ...S.meta, color: C.faint, marginTop: "1px" } }, String(x.description).slice(0, 110)) : null,
                  ])
                })) : null,
            ]) : null,
      ])
    }

    const LAYER_META = {
      memory: {
        title: "记忆层",
        plain: "AI 记得你的方式。可能有多个地方各自存一点（短期对话、长期档案、项目文档、角色记忆）。",
        question: "它们是不是在抢同一件事？抢了就是重复，没抢就能共存。",
      },
      persona: {
        title: "人格层",
        plain: "AI 说话做事的样子。包括人设、协作规矩、角色卡。",
        question: "两份人设是不是同一个东西？内容一模一样就该留一个。",
      },
      tool: {
        title: "工具层",
        plain: "AI 会用的能力。每个插件都会往这里放几个工具。",
        question: "两个插件放的工具是不是重名？重名会互相顶掉。",
      },
    }

    function LayersTab() {
      const ep = useEndpoint("layers")
      const [openLayer, setOpenLayer] = useState(null)
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const items = d.items || []
      const ovs = d.overlaps || []
      const rm = d.remediation || { plans: [], withheld: [], notes: [] }
      const byLayer = { memory: [], persona: [], tool: [] }
      items.forEach(function (i) { if (byLayer[i.layer]) byLayer[i.layer].push(i) })
      const ovByLayer = { memory: [], persona: [], tool: [] }
      ovs.forEach(function (o) { if (ovByLayer[o.layer]) ovByLayer[o.layer].push(o) })

      const needAttention = (rm.plans || []).filter(function (p) { return p.action === "keep-one" })
      const keepBoth = (rm.plans || []).filter(function (p) { return p.action === "keep-both" }).length

      return h("div", null, [
        h(ErrBox, { key: "err", errors: d.errors }),

        h("div", { key: "intro", style: { marginBottom: "20px" } }, [
          h("div", { key: "t", style: { fontSize: "13.5px", fontWeight: 600 } }, "这页在回答：你装的东西里，有没有两个在干同一件事？"),
          h("div", { key: "d", style: { ...S.meta, marginTop: "4px" } },
            "把插件能力分成三层看。同一层里两个东西做同一件事，就值得留一个；各做各的就都留着。"),
        ]),

        needAttention.length
          ? h("div", { key: "attn", style: { ...S.card, background: C.warnSoft, borderColor: "transparent", marginBottom: "20px" } }, [
              h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" } }, [
                h("span", { key: "d", style: S.dot(C.warn) }),
                h("span", { key: "t", style: { fontWeight: 600, color: C.warn, fontSize: "13px" } },
                  "发现 " + needAttention.length + " 组重复，建议只留一个"),
              ]),
              needAttention.map(function (p, i) {
                return h("div", { key: "k" + i, style: i ? { marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(192,127,16,.2)" } : {} }, [
                  h("div", { key: "w", style: { fontSize: "13px", marginBottom: "6px" } }, p.why),
                  h("div", { key: "e", style: { ...S.kv } }, [
                    h("span", { key: "a", style: S.meta }, "建议保留"),
                    h("span", { key: "b", style: { ...S.mono, color: C.ok } }, p.suggestedKeep),
                  ]),
                  h("div", { key: "f", style: { ...S.kv, borderBottom: "none" } }, [
                    h("span", { key: "a", style: S.meta }, "另一个"),
                    h("span", { key: "b", style: { ...S.mono, color: C.faint } }, p.suggestedDisable),
                  ]),
                  (p.evidence || []).slice(0, 3).map(function (e, j) {
                    return h("div", { key: "ev" + j, style: { ...S.meta, marginTop: "3px", paddingLeft: "10px", position: "relative" } }, "· " + e)
                  }),
                  h("div", { key: "n", style: { ...S.meta, color: C.faint, marginTop: "6px" } },
                    "只是建议。停用要改 profile 配置、影响下次启动，本插件不会自己动手。"),
                ])
              }),
            ])
          : h("div", { key: "ok", style: { ...S.card, background: C.okSoft, borderColor: "transparent", marginBottom: "20px" } }, [
              h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "7px" } }, [
                h("span", { key: "d", style: S.dot(C.ok) }),
                h("span", { key: "t", style: { fontWeight: 600, color: C.ok, fontSize: "13px" } }, "没有发现需要处理的重复"),
              ]),
              h("div", { key: "d", style: { ...S.meta, marginTop: "5px", marginLeft: "13px" } },
                "各层的东西各干各的，都留着就好。" + (keepBoth ? "其中 " + keepBoth + " 组非常接近，但判为互补。" : "")),
            ]),

        ["memory", "persona", "tool"].map(function (layer, li) {
          const meta = LAYER_META[layer]
          const its = byLayer[layer]
          const ovl = ovByLayer[layer]
          const coexist = ovl.filter(function (o) { return o.verdict === "coexist" }).length
          const keep = ovl.filter(function (o) { return o.verdict === "keep-one" }).length
          const unv = ovl.filter(function (o) { return o.verdict === "unverified" }).length
          const isOpen = openLayer === layer
          return h("div", { key: layer, style: { borderBottom: "1px solid " + C.lineSoft } }, [
            h("div", {
              key: "h",
              onClick: function () { setOpenLayer(isOpen ? null : layer) },
              style: { cursor: "pointer", padding: "12px 0", display: "flex", alignItems: "flex-start", gap: "10px" },
            }, [
              h("span", { key: "t", style: { ...S.mono, color: C.faint, width: "11px", flex: "0 0 auto", lineHeight: "19px" } }, isOpen ? "▾" : "▸"),
              h("div", { key: "c", style: { flex: 1, minWidth: 0 } }, [
                h("div", { key: "a", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
                  h("span", { key: "n", style: { fontWeight: 600, fontSize: "13px" } }, meta.title),
                  h("span", { key: "q", style: S.meta }, its.length + " 个"),
                  keep ? h("span", { key: "k", style: S.badge(C.warn, C.warnSoft) }, [h("span", { key: "d", style: S.dot(C.warn) }), keep + " 组重复"])
                       : h("span", { key: "o", style: { ...S.meta, color: C.ok } }, "无重复"),
                ]),
                h("div", { key: "p", style: { ...S.meta, marginTop: "3px" } }, meta.plain),
              ]),
            ]),
            isOpen ? h("div", { key: "body", style: { padding: "0 0 14px 21px" } }, [
              h("div", { key: "q", style: { ...S.meta, color: C.faint, marginBottom: "8px" } }, "判断标准：" + meta.question),
              its.length === 0 ? h("div", { key: "e", style: S.empty }, "这一层没发现东西") : its.map(function (i, idx) {
                return h("div", { key: i.backendId, style: idx === its.length - 1 ? { padding: "7px 0" } : { padding: "7px 0", borderBottom: "1px solid " + C.lineSoft } }, [
                  h("div", { key: "n", style: { display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" } }, [
                    h("span", { key: "a", style: { ...S.mono, fontSize: "12px", fontWeight: 600 } }, i.backendId),
                    i.scope === "character" ? h("span", { key: "s", style: S.meta, color: C.faint }, "角色专用") : null,
                    i.active === false ? h("span", { key: "i", style: S.meta, color: C.faint }, "未生效") : null,
                  ]),
                  i.detail ? h("div", { key: "d", style: { ...S.meta, marginTop: "2px" } }, i.detail) : null,
                ])
              }),
              ovl.length ? h("div", { key: "ov", style: { ...S.meta, color: C.faint, marginTop: "10px" } },
                "两两比较 " + ovl.length + " 组：" +
                (coexist ? "共存 " + coexist : "") +
                (keep ? " · 重复 " + keep : "") +
                (unv ? " · 判不了 " + unv : "")) : null,
              ovl.filter(function (o) { return o.verdict !== "coexist" }).map(function (o, i) {
                return h("div", { key: "o" + i, style: { marginTop: "10px" } }, [
                  h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
                    h(Verdict, { key: "v", verdict: o.verdict }),
                    h("span", { key: "p", style: { ...S.mono, fontSize: "11px", color: C.sub } }, o.a + "  ↔  " + o.b),
                  ]),
                  o.evidence && o.evidence.length ? h("div", { key: "e", style: { ...S.meta, marginTop: "3px" } }, o.evidence.join("；")) : null,
                ])
              }),
            ]) : null,
          ])
        }),

        h("div", { key: "note", style: { ...S.meta, color: C.faint, marginTop: "16px" } },
          "证据不够的时候系统会直接说「判不了」，不会硬凑一个二选一。"),
      ])
    }

    function SurfaceTab() {
      const ep = useEndpoint("overview")
      const [view, setView] = useState("tools")
      const [mode, setMode] = useState("plugin")
      const [openGroup, setOpenGroup] = useState(null)
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const sf = d.surface
      const sk = d.skills
      if (!sf) return h("div", { style: S.empty }, "还没有工具面数据。先跑一次 atlas_scan（全量）才会有。")
      const tg = d.toolGroups

      return h("div", null, [
        h("div", { key: "intro", style: { marginBottom: "14px" } }, [
          h("div", { key: "t", style: { fontSize: "13.5px", fontWeight: 600 } },
            view === "tools"
              ? "这页在回答：AI 手上有哪些工具，哪些它其实从来没用过？"
              : "这页在回答：你装的技能里，哪些 AI 真的用过、哪些一次都没调过？"),
          h("div", { key: "d", style: { ...S.meta, marginTop: "4px" } },
            view === "tools"
              ? "数据来自每次对话里宿主真正发给 AI 的工具清单，和它实际调用的次数对照得出。"
              : "工具是注册后就能直接调；技能要先调 skill(name) 读到正文才会用，所以「没调过」比工具更能说明问题。"),
        ]),

        h("div", { key: "vbar", style: { display: "inline-flex", background: C.lineSoft, borderRadius: "7px", padding: "2px", marginBottom: "16px" } }, [
          [["tools", "工具"], ["skills", "技能"]].map(function (pair) {
            const on = view === pair[0]
            return h("button", {
              key: pair[0],
              onClick: function () { setView(pair[0]) },
              style: on
                ? { ...S.btn, background: C.bg, borderColor: C.line, fontWeight: 600 }
                : { ...S.btn, background: "transparent", borderColor: "transparent", color: C.sub },
            }, pair[1])
          }),
        ]),

        view === "skills" ? h(SkillsView, { key: "sv" }) : h("div", { key: "tv" }, [

        h("div", { key: "g", style: S.grid(4) }, [
          h(Stat, { key: "a", value: sf.totals.surface, label: "可用工具" }),
          h(Stat, { key: "b", value: sf.totals.hot, label: "常用", hint: "20 次以上" }),
          h(Stat, { key: "c", value: sf.totals.cold, label: "偶尔用" }),
          h(Stat, { key: "d", value: sf.totals.unused, label: "从没用过", hint: "见过，但一次没调" }),
        ]),

        h("div", { key: "bar", style: { display: "flex", alignItems: "center", gap: "8px", margin: "20px 0 4px" } }, [
          h("div", { key: "seg", style: { display: "inline-flex", background: C.lineSoft, borderRadius: "7px", padding: "2px" } }, [
            [["plugin", "按插件"], ["family", "按类型"]].map(function (pair) {
              const on = mode === pair[0]
              return h("button", {
                key: pair[0],
                onClick: function () { setMode(pair[0]); setOpenGroup(null) },
                style: on
                  ? { ...S.btn, background: C.bg, borderColor: C.line, fontWeight: 600 }
                  : { ...S.btn, background: "transparent", borderColor: "transparent", color: C.sub },
              }, pair[1])
            }),
          ]),
          h("span", { key: "h", style: { ...S.meta, color: C.faint } },
            mode === "plugin"
              ? (tg ? tg.summary.plugins + " 个插件 + 宿主自带" : "按贡献它的插件分组")
              : "按名字猜测的语义类型，仅供参考"),
        ]),

        mode === "plugin"
          ? (tg && tg.groups.length
            ? h("div", { key: "pg" }, tg.groups.map(function (grp, gi) {
                const open = openGroup === grp.key
                return h("div", { key: grp.key, style: { borderBottom: "1px solid " + C.lineSoft } }, [
                  h("div", {
                    key: "h",
                    onClick: function () { setOpenGroup(open ? null : grp.key) },
                    style: { cursor: "pointer", padding: "11px 0", display: "flex", alignItems: "center", gap: "9px" },
                  }, [
                    h("span", { key: "c", style: { ...S.mono, color: C.faint, width: "10px" } }, open ? "▾" : "▸"),
                    h("span", { key: "n", style: { ...S.mono, fontSize: "12px", fontWeight: 600, color: grp.isHost ? C.faint : C.fg } }, grp.name),
                    h("span", { key: "s", style: { flex: 1 } }),
                    h("span", { key: "t", style: S.meta }, grp.toolCount + " 个工具"),
                    grp.unused ? h("span", { key: "u", style: { ...S.meta, color: C.warn } }, grp.unused + " 个没用过") : null,
                    h("span", { key: "v", style: { ...S.mono, fontSize: "11px", color: C.faint, width: "72px", textAlign: "right" } }, grp.calls + " 次调用"),
                  ]),
                  open ? h("div", { key: "b", style: { padding: "0 0 12px 19px" } },
                    grp.tools.map(function (t, ti) {
                      return h("div", { key: t.name, style: { display: "flex", alignItems: "baseline", gap: "8px", padding: "5px 0" } }, [
                        h("span", { key: "d", style: S.dot(t.calls > 0 ? C.ok : C.faint) }),
                        h("span", { key: "n", style: { ...S.mono, fontSize: "11.5px", flex: 1, minWidth: 0 } }, t.name),
                        h("span", { key: "c", style: { ...S.meta, color: t.calls > 0 ? C.sub : C.faint } },
                          t.calls > 0 ? t.calls + " 次" : "没用过"),
                      ])
                    })) : null,
                ])
              }))
            : h("div", { key: "e", style: S.empty }, "没有分组数据"))
          : h("div", { key: "fg", style: S.section }, [
              h(SectionTitle, { key: "t", title: "按类型分布", hint: "按工具名的前缀猜的，不是事实来源。" }),
              (sf.families || []).map(function (f) {
                const pct = f.total ? Math.round((f.called / f.total) * 100) : 0
                return h("div", { key: f.family, style: { display: "flex", alignItems: "center", gap: "12px", padding: "8px 0" } }, [
                  h("span", { key: "n", style: { width: "88px", flex: "0 0 auto", fontSize: "12.5px" } }, f.family),
                  h("span", { key: "bar", style: { flex: 1, height: "4px", background: C.lineSoft, borderRadius: "2px", overflow: "hidden" } },
                    h("span", { style: { display: "block", height: "100%", width: pct + "%", background: C.accent, borderRadius: "2px" } })),
                  h("span", { key: "v", style: { ...S.mono, fontSize: "11px", color: C.sub, width: "110px", textAlign: "right", flex: "0 0 auto" } },
                    f.called + "/" + f.total + " 用过"),
                ])
              }),
            ]),

        h("div", { key: "u", style: S.section }, [
          h(SectionTitle, { key: "t", title: "从没用过的工具", hint: "AI 见过它们，但一次都没调用。可能是冗余，也可能是还没遇到场景。" }),
          (sf.unused || []).length === 0 ? h("div", { key: "e", style: S.empty }, "没有") : (sf.unused || []).map(function (u, i) {
            return h("div", { key: u.name, style: i === sf.unused.length - 1 ? { padding: "9px 0" } : { padding: "9px 0", borderBottom: "1px solid " + C.lineSoft } }, [
              h("div", { key: "n", style: { ...S.mono, fontSize: "12px", fontWeight: 600 } }, u.name),
              u.description ? h("div", { key: "d", style: { ...S.meta, marginTop: "2px" } }, String(u.description).slice(0, 130)) : null,
            ])
          }),
        ]),

        ]),
        ])
    }
    function SkillsView() {
      const ep = useEndpoint("overview")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const sk = d.skills
      if (!sk) {
        return h("div", { style: S.empty }, [
          h("div", { key: "a" }, "还没有技能面数据。"),
          h("div", { key: "b", style: { marginTop: "6px", ...S.meta } },
            "先跑一次 atlas_scan，或者确认 ~/.dsh/skills 下有技能。"),
        ])
      }

      const all = sk.items || []
      const localItems = all.filter(function (x) { return x.origin !== "builtin" })
      const builtinItems = all.filter(function (x) { return x.origin === "builtin" })
      const usedCount = all.filter(function (x) { return x.used }).length

      function Group(props) {
        const list = props.items
        if (!list.length) return null
        const u = list.filter(function (x) { return x.used }).length
        return h("div", { style: S.section }, [
          h(SectionTitle, { key: "t", title: props.title, hint: props.hint }),
          h("div", { key: "cnt", style: { ...S.meta, color: C.faint, marginBottom: "6px" } },
            list.length + " 个 · 用过 " + u + " · 没用过 " + (list.length - u)),
          list.map(function (x, i) {
            return h("div", {
              key: x.name,
              style: i === list.length - 1
                ? { padding: "9px 0" }
                : { padding: "9px 0", borderBottom: "1px solid " + C.lineSoft },
            }, [
              h("div", { key: "r", style: { display: "flex", alignItems: "baseline", gap: "10px" } }, [
                h("span", { key: "d", style: S.dot(x.used ? C.ok : C.faint) }),
                h("span", {
                  key: "n",
                  style: { ...S.mono, fontSize: "12px", fontWeight: x.used ? 600 : 400, flex: 1, minWidth: 0 },
                }, x.name),
                x.used
                  ? h("span", { key: "c", style: S.meta }, x.calls + " 次 / " + x.sessions + " 个会话")
                  : h("span", { key: "c", style: { ...S.meta, color: C.faint } }, "没用过"),
                x.hasSkillMd ? null : h("span", { key: "w", style: { ...S.meta, color: C.warn } }, "缺 SKILL.md"),
              ]),
              x.used && x.lastAt ? h("div", {
                key: "w",
                style: { ...S.meta, color: C.faint, marginTop: "2px", marginLeft: "15px" },
              }, "最后 " + new Date(x.lastAt).toLocaleString("zh-CN")) : null,
            ])
          }),
        ])
      }

      return h("div", null, [
        h("div", { key: "s", style: { marginBottom: "18px" } }, [
          h("div", { key: "g", style: S.grid(3) }, [
            h(Stat, { key: "a", value: all.length, label: "技能总数",
              hint: "本地 " + localItems.length + " + 内置 " + builtinItems.length }),
            h(Stat, { key: "b", value: usedCount, label: "用过" }),
            h(Stat, { key: "c", value: all.length - usedCount, label: "从没用过" }),
          ]),
          sk.summary.missingSkillMd ? h("div", {
            key: "w",
            style: { ...S.meta, color: C.warn, marginTop: "10px" },
          }, "⚠ 有 " + sk.summary.missingSkillMd + " 个技能目录缺 SKILL.md（可能装坏了）") : null,
        ]),

        h(Group, {
          key: "local",
          title: "本地技能（" + localItems.length + "）",
          hint: "放在 ~/.dsh/skills 下，你自己装的或别的插件装的。",
          items: localItems,
        }),

        h(Group, {
          key: "builtin",
          title: "内置技能（" + builtinItems.length + "）",
          hint: "DSH 安装包自带的（office 系列），不是你装的。",
          items: builtinItems,
        }),

        h("div", { key: "note", style: { ...S.meta, color: C.faint, marginTop: "16px", lineHeight: 1.7 } }, [
          h("div", { key: "1" }, "「没用过」不等于「该删」——有些技能是备用场景（做 PPT、导出 PDF），平时不用很正常。"),
          h("div", { key: "2" }, "这里只报事实，不给删除建议。"),
        ]),

        sk.orphanUsage && sk.orphanUsage.length ? h("div", { key: "o", style: S.section }, [
          h(SectionTitle, { key: "t", title: "调用过但本机找不到定义", hint: "可能装在别的 profile，或者已经删了。" }),
          sk.orphanUsage.map(function (x) {
            return h("div", { key: x.name, style: { padding: "9px 0" } }, [
              h("span", { key: "n", style: { ...S.mono, fontSize: "12px" } }, x.name),
              h("span", { key: "c", style: { ...S.meta, marginLeft: "10px" } }, x.calls + " 次"),
            ])
          }),
        ]) : null,
      ])
    }

    function LedgerTab() {
      const ep = useEndpoint("ops")
      const [view, setView] = useState("ledger")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const pt = d.patrol
      return h("div", null, [
        h("div", { key: "vbar", style: { display: "inline-flex", background: C.lineSoft, borderRadius: "7px", padding: "2px", marginBottom: "16px" } }, [
          [["ledger", "补丁流水"], ["update", "插件更新"]].map(function (pair) {
            const on = view === pair[0]
            return h("button", {
              key: pair[0],
              onClick: function () { setView(pair[0]) },
              style: on
                ? { ...S.btn, background: C.bg, borderColor: C.line, fontWeight: 600 }
                : { ...S.btn, background: "transparent", borderColor: "transparent", color: C.sub },
            }, pair[1])
          }),
        ]),

        view === "update" ? h(UpdateView, { key: "uv" }) : h("div", { key: "lv" }, [
        h("div", { key: "p", style: { marginBottom: "20px" } }, [
          h(SectionTitle, { key: "t", title: "每日巡检", hint: "每隔一段时间自动检查上游有没有更新、你的补丁会不会被冲掉。" }),
          pt ? h("div", { key: "l" }, [
            h("div", { key: "a", style: S.kv }, [
              h("span", { key: "k", style: S.meta }, "上次检查"),
              h("span", { key: "v", style: { ...S.mono, fontSize: "12px" } }, pt.lastRunAt ? new Date(pt.lastRunAt).toLocaleString("zh-CN") : "从未跑过"),
            ]),
            h("div", { key: "b", style: { ...S.kv, borderBottom: "none" } }, [
              h("span", { key: "k", style: S.meta }, "现在"),
              h("span", { key: "v", style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, [
                h("span", { key: "d", style: S.dot(pt.due ? C.warn : C.ok) }),
                h("span", { key: "t", style: { color: pt.due ? C.warn : C.ok, fontSize: "12.5px" } }, pt.due ? "该检查了" : "还不到时间"),
              ]),
            ]),
            h("div", { key: "c", style: { ...S.meta, color: C.faint, marginTop: "6px" } }, pt.reason || ""),
          ]) : h("div", { key: "e", style: S.empty }, "读不到巡检状态"),
        ]),

        h("div", { key: "l", style: S.section }, [
          h(SectionTitle, { key: "t", title: "补丁变更记录", hint: "只追加、不改写。每次检查或重放补丁都会留一条。" }),
          (d.ledger || []).length === 0 ? h("div", { key: "e", style: S.empty }, "还没有记录") : (d.ledger || []).map(function (x, i) {
            const ok = x.lastResult === "applied"
            return h("div", { key: x.patch, style: i === d.ledger.length - 1 ? { ...S.row, borderBottom: "none" } : S.row }, [
              h("span", { key: "d", style: S.dot(ok ? C.ok : C.faint) }),
              h("div", { key: "n", style: { flex: 1, minWidth: 0 } }, [
                h("div", { key: "a", style: { ...S.mono, fontSize: "12px" } }, x.patch),
                h("div", { key: "b", style: { ...S.meta, color: C.faint, marginTop: "1px" } },
                  (x.at ? new Date(x.at).toLocaleString("zh-CN") : "?") + " · 共 " + x.count + " 条"),
              ]),
              h("span", { key: "s", style: { ...S.meta, color: ok ? C.ok : C.sub } }, ok ? "生效中" : x.lastAction),
            ])
          }),
        ]),
        ]),
      ])
    }

    function SidebarTab() {
      const ep = useEndpoint("ops")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const list = d.sidebar || []
      const sum = d.sidebarSummary

      const clashes = list.filter(function (x) { return /撞车|同一.*两个入口|名字和/.test(x.overlaps) })

      return h("div", null, [
        h("div", { key: "intro", style: { marginBottom: "20px" } }, [
          h("div", { key: "t", style: { fontSize: "13.5px", fontWeight: 600 } }, "左边那 " + (sum ? sum.total : list.length) + " 个入口，各是干什么的"),
          h("div", { key: "d", style: { ...S.meta, marginTop: "4px" } },
            "有些名字很像但其实是两回事，有些确实重复。下面按「谁加的」逐条摊开，你自己判断留哪些。"),
        ]),

        clashes.length ? h("div", { key: "clash", style: { ...S.card, background: C.warnSoft, borderColor: "transparent", marginBottom: "20px" } }, [
          h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "7px", marginBottom: "8px" } }, [
            h("span", { key: "d", style: S.dot(C.warn) }),
            h("span", { key: "t", style: { fontWeight: 600, color: C.warn, fontSize: "13px" } }, clashes.length + " 个入口名字撞车"),
          ]),
          clashes.map(function (x, i) {
            return h("div", { key: x.label, style: i ? { marginTop: "10px" } : {} }, [
              h("div", { key: "a", style: { fontSize: "13px", fontWeight: 600 } }, x.label),
              h("div", { key: "b", style: { ...S.meta, marginTop: "2px" } }, x.overlaps),
              h("div", { key: "c", style: { ...S.meta, color: C.faint, marginTop: "2px" } }, "→ " + x.advice),
            ])
          }),
        ]) : null,

        list.map(function (x, i) {
          return h("div", { key: x.label, style: { borderBottom: i === list.length - 1 ? "none" : "1px solid " + C.lineSoft, padding: "12px 0" } }, [
            h("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
              h("span", { key: "n", style: { fontWeight: 600, fontSize: "13px" } }, x.label),
              h("span", { key: "s", style: { ...S.meta, color: C.faint } }, "← " + x.source),
              x.canClose ? h("span", { key: "c", style: S.badge(C.warn, C.warnSoft) }, "可考虑关掉") : null,
            ]),
            h("div", { key: "w", style: { ...S.meta, marginTop: "3px" } }, x.what),
            h("div", { key: "v", style: { ...S.meta, color: C.faint, marginTop: "2px" } }, "现状：" + x.content),
            h("div", { key: "o", style: { ...S.meta, color: C.faint, marginTop: "2px" } }, "关系：" + x.overlaps),
            h("div", { key: "a", style: { fontSize: "11.5px", color: x.canClose ? C.warn : C.sub, marginTop: "3px" } }, "建议：" + x.advice),
          ])
        }),

        h("div", { key: "note", style: { ...S.meta, color: C.faint, marginTop: "18px", paddingTop: "14px", borderTop: "1px solid " + C.lineSoft } }, [
          h("div", { key: "a" }, "为什么本插件不能直接帮你折叠左侧：左侧导航由宿主渲染，"),
          h("div", { key: "b" }, "插件只能往里加自己那一个，没有隐藏别人入口的接口。"),
          h("div", { key: "c", style: { marginTop: "6px" } }, "真要减少入口：去「插件」页关掉对应插件（会改变启动能力面，本插件不会替你动）。"),
        ]),
      ])
    }

    function UpdateView() {
      const ep = useEndpoint("ops")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const u = d.update
      if (!u) return h("div", { style: S.empty }, "读不到依赖清单")
      const up = u.updatable || []
      const lk = u.linked || []
      return h("div", null, [
        h("div", { key: "s", style: { ...S.cardTight, marginBottom: "18px" } }, [
          h("div", { key: "t", style: { fontSize: "12.5px", fontWeight: 600 } }, "更新怎么用"),
          h("div", { key: "1", style: { ...S.meta, color: C.sub, marginTop: "4px" } }, "· 这一页只列清单，不执行更新。"),
          h("div", { key: "2", style: { ...S.meta, color: C.sub } }, "· 真更新用 atlas_update，它会先备份、更新、校验，失败自动回滚。"),
          h("div", { key: "3", style: { ...S.meta, color: C.sub } }, "· 更新完会自动复查补丁，掉了会告诉你。"),
        ]),
        h("div", { key: "u", style: S.sectionFirst }, [
          h(SectionTitle, { key: "t", title: "可以更新（npm 装的）", hint: "共 " + up.length + " 个。当前 profile：" + (u.profileDir || "?") }),
          up.length === 0
            ? h("div", { key: "e", style: S.empty }, "没有 npm 装的插件")
            : up.map(function (x, i) {
              return h("div", { key: x.name, style: i === up.length - 1 ? { ...S.row, borderBottom: "none" } : S.row }, [
                h("span", { key: "d", style: S.dot(C.ok) }),
                h("span", { key: "n", style: { ...S.mono, fontSize: "12px", flex: 1, minWidth: 0 } }, x.name),
                h("span", { key: "s", style: { ...S.meta, color: C.faint } }, x.spec),
              ])
            }),
        ]),
        h("div", { key: "l", style: S.section }, [
          h(SectionTitle, { key: "t", title: "不需要更新（link 装的）", hint: "这些指向本地目录，没有「新版本」这个概念。改源码就直接生效。" }),
          lk.length === 0
            ? h("div", { key: "e", style: S.empty }, "没有 link 装的插件")
            : lk.map(function (x, i) {
              return h("div", { key: x.name, style: i === lk.length - 1 ? { ...S.row, borderBottom: "none" } : S.row }, [
                h("span", { key: "d", style: S.dot(C.faint) }),
                h("span", { key: "n", style: { ...S.mono, fontSize: "12px", flex: 1, minWidth: 0 } }, x.name),
                h("span", { key: "s", style: { ...S.meta, color: C.faint } }, "本地"),
              ])
            }),
        ]),
      ])
    }

    function ModelView() {
      const ep = useEndpoint("ops")
      if (ep.state.loading && !ep.state.data) return h(Loading)
      if (ep.state.error) return h("div", { style: S.err }, "接口不可用：" + ep.state.error)
      const d = ep.state.data || {}
      const svc = d.modelService
      const rows = d.models || []
      const ready = svc && svc.ready
      return h("div", null, [
        h("div", { key: "s", style: { ...S.cardTight, marginBottom: "18px", borderLeft: "3px solid " + (ready ? C.ok : C.err) } }, [
          h("div", { key: "t", style: { fontSize: "13px", fontWeight: 600, color: ready ? C.ok : C.err } },
            ready ? "✅ 模型服务已就绪" : "❌ 模型服务不可用"),
          h("div", { key: "b", style: { ...S.meta, color: C.sub, marginTop: "4px" } },
            ready
              ? "依赖模型的功能可以正常调用。想确认能真调通，跑 atlas_model_check。"
              : "依赖模型的功能会全部失效，纯规则的工具不受影响。可能是宿主版本太老没注入，或这个 profile 没配模型。"),
        ]),
        h("div", { key: "m", style: S.sectionFirst }, [
          h(SectionTitle, { key: "t", title: "各用途用哪个模型", hint: "留空 = 跟随宿主默认。改在 <当前 profile>/cordis.patch.yml 的 config.models 段。" }),
          rows.length === 0
            ? h("div", { key: "e", style: S.empty }, "没有模型配置")
            : rows.map(function (x, i) {
              return h("div", { key: x.key, style: i === rows.length - 1 ? { ...S.row, borderBottom: "none" } : S.row }, [
                h("div", { key: "n", style: { flex: 1, minWidth: 0 } }, [
                  h("div", { key: "a", style: { ...S.mono, fontSize: "12px" } }, x.key),
                  h("div", { key: "b", style: { ...S.meta, color: C.faint, marginTop: "1px" } }, x.desc),
                ]),
                h("span", { key: "v", style: { ...S.meta, color: x.followsDefault ? C.faint : C.accent } }, x.label),
              ])
            }),
        ]),
        (d.modelWarnings || []).length === 0 ? null : h("div", { key: "w", style: S.section }, [
          h(SectionTitle, { key: "t", title: "配置提示" }),
          (d.modelWarnings || []).map(function (w, i) { return h("div", { key: i, style: { ...S.meta, color: C.warn } }, "! " + w) }),
        ]),
      ])
    }

    const TABS = [
      { key: "overview", label: "概览", endpoint: "overview", Comp: OverviewTab },
      { key: "plugins", label: "插件", endpoint: "plugins", Comp: PluginsTab },
      { key: "layers", label: "三层", endpoint: "layers", Comp: LayersTab },
      { key: "surface", label: "工具面", endpoint: "overview", Comp: SurfaceTab },
      { key: "sidebar", label: "侧栏", endpoint: "ops", Comp: SidebarTab },
      { key: "ledger", label: "台账", endpoint: "ops", Comp: LedgerTab },
    ]

    function AtlasPanel() {
      const [tab, setTab] = useState("overview")
      const cur = TABS.filter(function (t) { return t.key === tab })[0] || TABS[0]
      return h("div", { style: S.page }, [
        h("div", { key: "h" }, [
          h("div", { key: "t", style: { display: "flex", alignItems: "baseline", gap: "10px" } }, [
            h("span", { key: "n", style: S.h1 }, "插件知枢"),
            h("span", { key: "v", style: { ...S.meta, color: C.faint } }, "管住你装的所有插件"),
          ]),
          h("div", { key: "s", style: S.sub }, "看清装了什么 · 找出重复 · 防止改动被覆盖 · 每天查上游"),
        ]),
        h("div", { key: "tabs", style: S.tabs }, TABS.map(function (t) {
          return h("button", {
            key: t.key,
            onClick: function () { setTab(t.key) },
            onMouseEnter: function () { prefetch(t.endpoint) },
            onFocus: function () { prefetch(t.endpoint) },
            style: tab === t.key ? { ...S.tab, ...S.tabOn } : S.tab,
          }, t.label)
        })),
        h(cur.Comp, { key: tab }),
      ])
    }

    function AtlasIcon() {
      const svg = h("svg", {
        width: "18",
        height: "18",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.6",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      }, [
        h("circle", { key: "c", cx: "12", cy: "12", r: "2.2" }),
        h("circle", { key: "a", cx: "12", cy: "3.2", r: "1.6" }),
        h("circle", { key: "b", cx: "4.2", cy: "18", r: "1.6" }),
        h("circle", { key: "d", cx: "19.8", cy: "18", r: "1.6" }),
        h("path", { key: "l1", d: "M12 5v4.8" }),
        h("path", { key: "l2", d: "M10.2 13.6 5.6 16.8" }),
        h("path", { key: "l3", d: "M13.8 13.6 18.4 16.8" }),
      ])
      return h("span", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          color: "inherit",
          lineHeight: 0,
        },
        title: "插件知枢",
      }, svg)
    }


    function SettingsGroup(props) {
      return h("div", { style: { padding: "14px 0", borderTop: props.first ? "none" : "1px solid " + C.lineSoft } }, [
        h("div", { key: "t", style: { fontSize: "12.5px", fontWeight: 600, marginBottom: props.hint ? "2px" : "8px" } }, props.title),
        props.hint ? h("div", { key: "h", style: { ...S.meta, color: C.faint, marginBottom: "8px" } }, props.hint) : null,
        h("div", { key: "c" }, props.children),
      ])
    }

    function SettingsSection() {
      const ep = useEndpoint("ops")
      const d = ep.state.data || {}
      const pd = d.patrol

      const [openModel, setOpenModel] = useState(null)
      const [modelEdits, setModelEdits] = useState({})
      const [modelSaving, setModelSaving] = useState(null)
      const [modelMsg, setModelMsg] = useState("")

      function setModelEdit(slot, patch) {
        setModelEdits(function (cur) {
          const next = { ...cur }
          next[slot] = { ...(next[slot] || {}), ...patch }
          return next
        })
        setModelMsg("")
      }

      function saveModel(slot, override) {
        const e = override || modelEdits[slot] || {}
        setModelSaving(slot)
        setModelMsg("")
        fetch(API + "/config/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slot,
            provider: e.provider || null,
            model: e.model || null,
            reasoningEffort: e.reasoningEffort || null,
          }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j } }) })
          .then(function (x) {
            setModelSaving(null)
            if (x.ok) {
              setModelMsg("已写入" + (x.j.backup ? "（备份 " + x.j.backup + "）" : ""))
              if (ep.reload) ep.reload()
            } else {
              setModelMsg("失败：" + (x.j.error || "未知原因"))
            }
          })
          .catch(function (err) { setModelSaving(null); setModelMsg("失败：" + err.message) })
      }

      const [layout, setLayout] = useState(loadLayout)
      const updateLayout = function (patch) {
        const next = { ...layout, ...patch }
        setLayout(next)
        applyLayout(next)
      }

      const lastAt = pd && pd.lastRunAt ? new Date(pd.lastRunAt).toLocaleString("zh-CN") : null

      return h("div", { style: { color: C.fg, fontSize: "12.5px", maxWidth: "720px" } }, [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "9px", paddingBottom: "12px" } }, [
          h("span", { key: "i", style: { width: "18px", height: "18px", color: C.accent, flex: "0 0 auto" } }, h(AtlasIcon)),
          h("div", { key: "t" }, [
            h("div", { key: "n", style: { fontSize: "13.5px", fontWeight: 600 } }, "插件知枢"),
            h("div", { key: "d", style: { ...S.meta, color: C.faint, marginTop: "1px" } }, "管住你装的所有插件"),
          ]),
        ]),

        h(SettingsGroup, {
          key: "layout",
          title: "侧栏布局",
          hint: "宽度直接拖侧栏右边缘就行，不用在这里选。这里只决定「要不要文字」。",
          first: true,
        }, [
          h("div", { key: "modes", style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" } },
            LAYOUT_MODES.map(function (m) {
              const on = (layout.mode || "normal") === m.key
              return h("button", {
                key: m.key,
                onClick: function () { updateLayout({ mode: m.key }) },
                style: on ? { ...S.btn, ...S.btnOn } : S.btn,
              }, m.label)
            })),

          h("div", { key: "h2", style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" } }, [
            h("span", { key: "l", style: { ...S.meta, width: "76px", flex: "0 0 auto" } }, "列表高度"),
            h("input", {
              key: "r",
              type: "range",
              min: "160",
              max: "800",
              step: "20",
              value: layout.maxListHeight || 420,
              onChange: function (e) { updateLayout({ maxListHeight: Number(e.target.value) }) },
              style: { flex: 1 },
            }),
            h("span", { key: "v", style: { ...S.mono, width: "52px", textAlign: "right" } }, (layout.maxListHeight || 420) + "px"),
          ]),

          h("div", { key: "row", style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "4px" } }, [
            h("button", {
              key: "reset",
              onClick: function () { updateLayout({ mode: "normal", maxListHeight: 420 }) },
              style: S.btn,
            }, "恢复默认"),
            h("span", { key: "h", style: { ...S.meta, color: C.faint } },
              (LAYOUT_MODES.filter(function (m) { return m.key === (layout.mode || "normal") })[0] || {}).hint || ""),
          ]),

          h("div", { key: "note", style: { ...S.meta, color: C.faint, marginTop: "10px", lineHeight: 1.6 } }, [
            h("div", { key: "a" }, "侧栏宽度不用在这里设：把鼠标移到侧栏右边缘直接拖就行（宿主自带）。"),
            h("div", { key: "b" }, "原理：注入一段 CSS 改导航列表的排列，不修改宿主任何文件；点「恢复默认」即刻撤掉。"),
          ]),
        ]),

        h(SettingsGroup, { key: "run", title: "运行状态" }, [
          h("div", { key: "a", style: S.kv }, [
            h("span", { key: "k", style: { color: C.sub } }, "自动巡检"),
            h("span", { key: "v", style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, [
              h("span", { key: "d", style: S.dot(pd && pd.due ? C.warn : C.ok) }),
              h("span", { key: "t" }, pd
                ? (pd.due ? "该检查了" : "运行中，距下次还早")
                : "读不到状态"),
            ]),
          ]),
          h("div", { key: "b", style: S.kv }, [
            h("span", { key: "k", style: { color: C.sub } }, "上次检查"),
            h("span", { key: "v", style: S.mono }, lastAt || "从未跑过"),
          ]),
          h("div", { key: "c", style: { ...S.kv, borderBottom: "none" } }, [
            h("span", { key: "k", style: { color: C.sub } }, "补丁变更记录"),
            h("span", { key: "v", style: S.mono }, String((d.ledgerTail && d.ledgerTail.total) || 0) + " 条"),
          ]),
          h("div", { key: "note", style: { ...S.meta, color: C.faint, marginTop: "4px" } },
            "频率改法：cordis.patch.yml 里 id: dsh-atlas 的 patrolTickMinutes（0 = 关闭自动巡检）。"),
        ]),

        h(SettingsGroup, { key: "modelSvc", title: "模型服务状态", hint: "配置写得再对，服务没就绪照样调不通。" }, [
          h(ModelView, { key: "mv" }),
        ]),

        h(SettingsGroup, {
          key: "models",
          title: "模型配置",
          hint: "需要模型判断的地方。留空 = 跟随当前会话的默认模型，一般不用动。",
        }, [
          (d.models && d.models.length)
            ? d.models.map(function (m) {
                const edit = modelEdits[m.key] || {}
                const expanded = openModel === m.key
                return h("div", { key: m.key, style: { padding: "10px 0", borderBottom: "1px solid " + C.lineSoft } }, [
                  h("div", {
                    key: "a",
                    onClick: function () { setOpenModel(expanded ? null : m.key) },
                    style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
                  }, [
                    h("span", { key: "c", style: { ...S.mono, color: C.faint, width: "10px" } }, expanded ? "▾" : "▸"),
                    h("span", { key: "n", style: { ...S.mono, fontSize: "11.5px" } }, m.key),
                    h("span", { key: "s", style: { flex: 1 } }),
                    h("span", {
                      key: "v",
                      style: {
                        fontSize: "11.5px",
                        color: m.followsDefault ? C.faint : C.accent,
                        fontWeight: m.followsDefault ? 400 : 600,
                      },
                    }, m.label),
                  ]),
                  h("div", { key: "d", style: { ...S.meta, color: C.faint, marginTop: "2px", marginLeft: "18px" } }, m.desc),

                  expanded ? h("div", { key: "e", style: { marginTop: "8px", marginLeft: "18px", display: "grid", gap: "6px" } }, [
                    h("div", { key: "p", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
                      h("span", { key: "l", style: { ...S.meta, width: "68px", flex: "0 0 auto" } }, "provider"),
                      h("input", {
                        key: "i",
                        value: edit.provider || "",
                        placeholder: "留空则用默认",
                        onChange: function (e) { setModelEdit(m.key, { provider: e.target.value }) },
                        style: S.input,
                      }),
                    ]),
                    h("div", { key: "m", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
                      h("span", { key: "l", style: { ...S.meta, width: "68px", flex: "0 0 auto" } }, "model"),
                      h("input", {
                        key: "i",
                        value: edit.model || "",
                        placeholder: "留空 = 跟随默认",
                        onChange: function (e) { setModelEdit(m.key, { model: e.target.value }) },
                        style: S.input,
                      }),
                    ]),
                    h("div", { key: "r", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
                      h("span", { key: "l", style: { ...S.meta, width: "68px", flex: "0 0 auto" } }, "推理强度"),
                      h("input", {
                        key: "i",
                        value: edit.reasoningEffort || "",
                        placeholder: "可选，如 max / high",
                        onChange: function (e) { setModelEdit(m.key, { reasoningEffort: e.target.value }) },
                        style: S.input,
                      }),
                    ]),
                    h("div", { key: "b", style: { display: "flex", gap: "8px", marginTop: "2px" } }, [
                      h("button", {
                        key: "save",
                        onClick: function () { saveModel(m.key) },
                        style: S.btnPrimary,
                      }, modelSaving === m.key ? "写入中…" : "保存"),
                      h("button", {
                        key: "clr",
                        onClick: function () {
                          setModelEdit(m.key, { provider: "", model: "", reasoningEffort: "" })
                          saveModel(m.key, { provider: "", model: "", reasoningEffort: "" })
                        },
                        style: S.btn,
                      }, "恢复默认"),
                      h("span", { key: "s", style: { ...S.meta, color: C.faint, alignSelf: "center" } }, modelMsg),
                    ]),
                  ]) : null,
                ])
              })
            : h("div", { key: "e", style: { ...S.meta, color: C.faint } }, "读不到模型配置"),

          d.modelConfigTarget ? h("div", { key: "tgt", style: { ...S.meta, color: C.faint, marginTop: "10px", lineHeight: 1.6 } }, [
            h("div", { key: "a" }, "写回文件：" + d.modelConfigTarget),
            h("div", { key: "b" }, "只改 models 段那几行，注释与其它配置一个字节不动；每次写入前自动备份，写后自检不合格会自动回滚。"),
          ]) : null,
        ]),

        h(SettingsGroup, { key: "bound", title: "这个插件不做什么" }, [
          h("div", { key: "a", style: { ...S.meta, lineHeight: 1.7 } }, [
            h("div", { key: "1" }, "· 不自动停用插件 —— 市场已经有启用/停用开关，且带启动失败自动恢复；这里重复实现只会多一条出错路径。"),
            h("div", { key: "2" }, "· 不自动改代码 —— 只生成「改哪个文件、怎么验证」的方案，动手前要你点头。"),
            h("div", { key: "3" }, "· 不上传任何本机内容 —— 只读 npm registry 与 GitHub 公开 API，只发包名与仓库名。"),
          ]),
        ]),
      ])
    }

    function apply(ctx) {
      try { applyLayout(loadLayout()) } catch {   }

      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        try { console.error("[dsh-atlas] ctx.slots 不可用，UI 未注册") } catch {   }
        return
      }
      const disposers = []

      try {
        const d1 = slots.inject("sidebar.panellist", function () {
          return slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: function () { return "插件知枢" } }, AtlasIcon)
        })
        if (typeof d1 === "function") disposers.push(d1)
      } catch (e) { try { console.error("[dsh-atlas] 侧栏入口注册失败", e) } catch {   } }

      try {
        const d2 = slots.inject("main", function () {
          return slots.register({ name: "main", key: PANEL_ID }, AtlasPanel)
        })
        if (typeof d2 === "function") disposers.push(d2)
      } catch (e) { try { console.error("[dsh-atlas] 主面板注册失败", e) } catch {   } }

      try {
        const d3 = slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "dsh-atlas-settings",
            order: 70,
            label: function () { return "插件知枢" },
          }, SettingsSection)
        })
        if (typeof d3 === "function") disposers.push(d3)
      } catch (e) {   }

      return function () {
        for (const d of disposers.splice(0)) { try { d() } catch {   } }
      }
    }

    exports.apply = apply
    exports.inject = ["slots"]
    return module.exports
  },
})
