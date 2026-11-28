/**
 * 能力选用协议：先读 skill / MCP 目录，再按当前任务选用。
 * 不改官方 skill 注册、不改 MCP 挂载、不 deny 任何工具。
 * 官方 DSH 已写工具用法，这里不另挂 Host tools 纪律。
 */

// [dsh-purge-safe] 不带 `dsh-purge-safe` 前缀:宿主 renderPrompt 内部有一步
// filter(s => s.name.startsWith("dsh-purge-safe")) 把这类段按插入序挪到最前。
// 旧名 "dsh-purge-safe:capabilities" 命中前缀,结果 cap 跑到 inject 前头(dump line 1),
// 反而制造出"cap 在前,inject 在后"的渲染反转。换名绕开这一步过滤。
export const CAPABILITY_SECTION = "dshpg-capabilities";

const OFFICIAL_PROTOCOL = `## 任务驱动的能力选择 / Capability selection by task (mandatory)

1. **先读目录 / Read first**：
   检查 \`<available_skills>\` / 能力目录和已安装的 MCP / host 工具。在行动前先知道什么存在。
   Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.

2. **精确匹配任务 / Match the task exactly**：
   从目录中只选择**精确适合这个任务**的 skill(s) 和 MCP/CLI 工具。
   **不匹配就不调用 / Skill or tool that does NOT match the task MUST NOT be called.**
   From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task exactly — no "always", no "never", no mismatches.

3. **调用匹配的 / Call what matches**：
   - 匹配的 **Skill** → 用 host \`skill\` 工具加载，然后遵循它（方法、前提、分支、反证据）。
     Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   
   - 匹配的 **MCP / CLI** → 用真实 schema 和 context 调用；按工具语义处理失败。
     Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool's semantics.

4. **才 DIY / Only then DIY**：
   如果目录中**没有**适合这个任务的工具，才用 shell / 临时步骤，并说明什么缺失了。
   If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.

5. **子代理继承 / Subagents inherit this rule**：
   任何 \`subagent\`、teammate 或子代理都必须也读目录、以同样方式调用**任务匹配**的 skill/MCP。
   在派活时把这个要求写进子任务简报里。
   Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.

6. **保持可用 / Host skills and MCP stay available**：
   这段提示词不移除任何能力。Host skills and MCP stay available; this prompt does not remove them.`;

const REDTEAM_LEAD_PROTOCOL = `## Capability selection by task (redteam lead)

1. You plan, dispatch with \`subagent\`, verify results, and report. Executors do hands-on work.
2. Before dispatch, know which skills/MCP fit the next stage (from \`<available_skills>\` / redteam skills / session MCP).
3. In every \`subagent\` brief: require the child to **read the skill/MCP catalog, then call only what the assigned task needs** (name concrete skill codes when you know them).
4. Do not ban skill or MCP for children. Leaf limits apply only to further delegation tools (\`subagent_fork\` / workflow / ralph), not to skill/MCP.
5. Vague "go investigate" briefs are wrong; task-matched skill/MCP instructions are right.`;

/**
 * @param {{ redteam?: boolean, redteamChild?: boolean, enabled?: boolean }} [opts]
 * @returns {string}
 */
export function capabilityProtocolText(opts = {}) {
  if (opts.enabled === false) return "";
  // 子智能体 / 子代理跟主会话同一条：读目录 → 按任务调 skill/MCP。
  // 红队 extras（角色 / 调度）另段挂上，这里不再换成另一套流程。
  if (opts.redteamChild) return OFFICIAL_PROTOCOL;
  if (opts.redteam) return REDTEAM_LEAD_PROTOCOL;
  return OFFICIAL_PROTOCOL;
}
