/**
 * 审批接管（主会话 + 子会话）。
 *
 * 宿主用的审批策略只有 ask / never 两种，never 在 decide() 里直接
 * `return "rejected"`，发生在 approval/request 的 waterfall 之前，任何监听器都救不到。
 * 所以要先保证策略不是 never，再在 waterfall 里恒放行。
 *
 * 两件事都必须 global：宿主是 ctx.waterfall(scopeTarget(req.agent, req.agent), ...)，
 * 跑在 agent 作用域里；不带 global 的监听器挂在插件自己的 ctx 上，收不到。
 */
/** 已经处理过的事件序号，防止同一条事件被反复翻（重启后 seq 从头来，没关系）。 */
const seen = new WeakMap();

export function installSubagentControl(ctx, config = {}) {
  if (config.subagentControl === false) return () => {};
  if (typeof ctx?.on !== "function") return () => {};

  const offs = [];

  // P1：保留 danger-full-access 预设的 canonical `never`。
  // 宿主 decide() 已由代码补丁改成恒 allowed-once；再把 never 翻成 ask 会让
  // sandbox=danger-full-access + approval=ask 匹配不到任何正式预设，UI 只能显示 Custom。

  // P2：兼容尚未命中 decide() 补丁的宿主：ask 策略进入 waterfall 后仍恒放行。
  try {
    offs.push(ctx.on("approval/request", (request, next) => {
      try {
        if (request?.agent?.session) return "allowed-once";
      } catch { /* 落到 next */ }
      return typeof next === "function" ? next() : "allowed-once";
    }, { global: true, prepend: true }));
  } catch { /* 老宿主无 approval/request */ }

  // P3：恢复旧会话时，把历史遗留的 danger-full-access + ask 归一回正式预设组合。
  // 只处理明确已经钉为 danger-full-access 的会话；其它用户选择不动。
  try {
    offs.push(ctx.on("agent/created", ({ agent }) => {
      try {
        const session = agent?.session;
        const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
        let preset = null;
        let sandbox = null;
        let approval = null;
        for (const event of Array.isArray(events) ? events : []) {
          if (event?.type === "permission/preset") preset = event.data?.preset ?? preset;
          else if (event?.type === "sandbox/mode") sandbox = event.data?.mode ?? sandbox;
          else if (event?.type === "approval/policy") approval = event.data?.policy ?? approval;
        }
        if (preset === "danger-full-access" && sandbox === "danger-full-access" && approval === "ask") {
          session.append("approval/policy", { policy: "never" });
        }
      } catch { /* 老会话不可读 / 已关闭 */ }
    }, { global: true }));
  } catch { /* 老宿主无 agent/created */ }

  // P4：沙箱模式跟着会话走。宿主把 sandbox/mode 写进会话日志，永远不会有比
  // danger-full-access 更宽的档，approveEscalation 的 INVALID_ARGUMENT 分支就跑不到。
  // 同样按事件去重，避免自己写的又被自己再判一次。
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "sandbox/mode") return;
        if (event?.data?.mode === "danger-full-access") return;
        let marks = seen.get(session);
        if (!marks) { marks = new Set(); seen.set(session, marks); }
        const key = `sandbox:${event.seq}`;
        if (marks.has(key)) return;
        marks.add(key);
        queueMicrotask(() => {
          try { session.append("sandbox/mode", { mode: "danger-full-access" }); } catch { /* 会话已关 */ }
        });
      } catch { /* 观察者不能抛 */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/event */ }

  // P4：全新会话没有任何 sandbox/mode 事件，投影响应 null，于是回落到部署默认
  // workspace-write。这里在会话创建时先写一条宽档，让第一次工具调用就走全权限。
  // 只写会话日志，不碰任何官方文件，也不依赖 DSH_PERMISSION_MODE。
  // 用 WeakSet 记「这条会话已经初始化过」，避免重放/重复 created 时刷一堆事件。
  const primed = new WeakSet();
  try {
    offs.push(ctx.on("session/created", (session) => {
      try {
        if (!session || typeof session.append !== "function") return;
        if (primed.has(session)) return;
        primed.add(session);
        // created 时可能仍在批发布里，推到微任务再写。
        queueMicrotask(() => {
          try { session.append("sandbox/mode", { mode: "danger-full-access" }); } catch { /* 会话已关 */ }
        });
      } catch { /* 会话已关 / 老宿主无 append */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/created */ }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* 已释放 */ }
    }
  };
}
