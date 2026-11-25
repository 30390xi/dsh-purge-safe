/* 提示词增强引擎 —— B 版。
   输入：草稿框 + 模式（红队/官方）+ 上下文块（红队=演练台快照 / 官方=最近任务摘要）。
   不读聊天历史做改写素材；官方摘要只取最近几条 user 文本做连续性参考。
   输出协议：ENHANCED / UNCHANGED 标签行 + 改写正文。 */

import { isRedteamPresetId } from "./identity.js";
import { peSystemPrompt } from "./pe-rules.mjs";
import { RedteamStore } from "./redteam/store-core.js";
import { redteamDataDir } from "./redteam/index.js";
import { clipText } from "./text-utils.js";

const TIMEOUT_MS = 60_000;
const MAX_DRAFT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_TOKENS = 4096;
const MAX_CONTEXT_CHARS = 6_000;      // 上下文块（快照/摘要）进 prompt 的上限
const OFFICIAL_DIGEST_TURNS = 3;      // 官方模式：最近 N 条 user 消息做任务摘要

export class EnhanceFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, code, message };
}

/* ── 模型路由：会话当前模型 → 全局默认。投影读取失败不阻塞增强。 ── */

function resolveRoute(scope, sessionId) {
  try {
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const sessions = scope.get?.("sessions");
      const projections = scope.get?.("sessionProjections");
      const session = sessions?.get?.(sessionId);
      if (session !== undefined && session !== null && projections !== undefined) {
        const selection = projections.snapshot(session, ["modelSelection"]).values.modelSelection;
        const picked = selection?.next ?? selection?.lastUsed;
        if (picked !== null && picked !== undefined && typeof picked.provider === "string") return picked;
      }
    }
    const fallback = scope.get?.("agentDefaultModel")?.currentSelection?.();
    if (fallback !== null && fallback !== undefined && typeof fallback.provider === "string") return fallback;
  } catch { /* 投影读挂了就走无模型，不抛 */ }
  return undefined;
}

/* ── 会话读取：live session 优先，controller.inspect 兜底。 ── */

function service(ctx, name) {
  try { return ctx.get?.(name); } catch { return undefined; }
}

function liveSession(ctx, sessionId) {
  const store = service(ctx, "sessions");
  try { return store?.get?.(sessionId) || null; } catch { return null; }
}

async function readSessionHeader(ctx, sessionId) {
  const live = liveSession(ctx, sessionId);
  if (live?.header) return live.header;
  try {
    const controller = service(ctx, "sessionController");
    if (typeof controller?.inspect === "function") {
      const inspected = await controller.inspect(sessionId);
      return inspected?.meta || inspected?.header || null;
    }
  } catch { /* ignore */ }
  return null;
}

/* 模式判定，四路信号，后者只能把结果“提升”到红队，不能降级：
   1. agentPreset 是红队预设（权威，但宿主曾把它写回 standard）
   2. 会话绑定了靶标（强信号）
   3. client 上报的当前 UI 模式（用户眼睛看到的模式，读的也是 agentPreset）
   4. 草稿本身就是渗透指令（打穿/拿下 + 目标）—— 用户实际心智是“我说拿下就是拿下” */
const REDTEAM_INTENT = /打穿|拿下|攻破|拿站|渗透测试|渗透|getshell|get\s*shell|webshell|提权|横移|横向|脱库|拖库|控站|打点|拿数据/i;
const STRONG_REDTEAM_INTENT = /渗透测试|内网|横移|横向|提权|脱库|拖库|getshell|webshell|控站|打点/i;
const BARE_DOMAIN = /(?:^|[\s(（:：,，、])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=[\s/)?？。，,）)]|$)/i;
const FILE_TAIL = /\.(?:js|mjs|ts|tsx|jsx|json|py|go|rs|cpp|cs|php|sh|ps1|md|txt|ya?ml|toml|ini|cfg|conf|log|csv|tsv|xml|html?|css|scss|sql|db|exe|dll|so|bin|zip|tar|gz|7z|rar|png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|pptx?)$/i;

/** 草稿里有没有目标：URL、IP、或裸域名（裸域名要排除文件名，否则 "打穿 data.json" 会误判）。 */
function hasTarget(text) {
  if (/https?:\/\//i.test(text)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/.test(text)) return true;
  const domain = BARE_DOMAIN.exec(text);
  if (domain === null) return false;
  return !FILE_TAIL.test(domain[1]);
}

/** 草稿本身是不是一条渗透指令。宁可漏判：漏了只是走官方腔，误判会把官方任务写歪。 */
export function looksLikeRedteamDraft(draft) {
  const text = String(draft ?? "");
  if (!REDTEAM_INTENT.test(text)) return false;
  return hasTarget(text) || STRONG_REDTEAM_INTENT.test(text);
}

async function resolveMode(ctx, sessionId, draft, modeHint) {
  if (sessionId) {
    const header = await readSessionHeader(ctx, sessionId);
    try {
      if (isRedteamPresetId(header?.agentPreset)) return "redteam";
    } catch { /* 读失败继续往下判 */ }
    try {
      const store = redteamStore();
      if (store && store.sessionBinding(sessionId)) return "redteam";
    } catch { /* 无库或读失败：继续 */ }
  }
  if (modeHint === "redteam") return "redteam";
  if (looksLikeRedteamDraft(draft)) return "redteam";
  return "official";
}

/* ── 红队上下文：演练台快照投影（白名单字段，凭据类一律不进 prompt）。 ── */

let storeSingleton = null;
function redteamStore() {
  if (storeSingleton === null) {
    try { storeSingleton = new RedteamStore(redteamDataDir()); }
    catch { storeSingleton = false; }
  }
  return storeSingleton || null;
}

/** 演练台状态 → prompt 段落。这是快照格式的第一版投影，格式未知，先做出来再迭代。 */
function projectWorkbench(store, engagementId) {
  const lines = [];
  try {
    const stats = store.stats(engagementId);
    lines.push(
      `资产 ${stats.assets}（存活 ${stats.liveAssets}），开放端口 ${stats.openPorts}，` +
      `网段 ${stats.segments}，漏洞 ${stats.vulns ?? 0}，攻击步骤 ${stats.steps ?? 0}。`,
    );
  } catch { /* 无库或空库：跳过统计行 */ }
  try {
    const chain = (store.listChain(engagementId) || []).slice(-6);
    for (const step of chain) {
      const where = [step.asset_ip, step.vuln_title, step.action].filter(Boolean).join(" · ");
      lines.push(`· ${clipText(where, 160)}`);
    }
  } catch { /* ignore */ }
  try {
    const digest = store.consoleDigest(engagementId);
    if (digest && typeof digest === "object") {
      const parts = Object.entries(digest)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v}`);
      if (parts.length > 0) lines.push(`进展：${parts.join("，")}`);
    }
  } catch { /* ignore */ }
  return lines.join("\n");
}

function redteamContext(ctx, sessionId) {
  const store = redteamStore();
  if (!store || !sessionId) return "";
  let engagementId = "";
  try { engagementId = store.sessionBinding(sessionId) || ""; } catch { /* ignore */ }
  if (!engagementId) return "";
  const body = projectWorkbench(store, engagementId);
  if (!body) return "";
  return `靶标绑定：${engagementId}\n${body}`;
}

/* ── 官方上下文：最近 N 条 user 消息文本，只做连续性参考。 ── */

function messageText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function officialContext(ctx, sessionId) {
  if (!sessionId) return "";
  const session = liveSession(ctx, sessionId);
  if (!session || typeof session.deriveMessages !== "function") return "";
  let messages;
  try { messages = session.deriveMessages(); } catch { return ""; }
  if (!Array.isArray(messages)) return "";
  const userTexts = [];
  for (let i = messages.length - 1; i >= 0 && userTexts.length < OFFICIAL_DIGEST_TURNS; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = messageText(m);
    if (text) userTexts.push(text);
  }
  if (userTexts.length === 0) return "";
  return userTexts.reverse().map((text, i) => `${i + 1}. ${clipText(text, 400)}`).join("\n");
}

/* ── 输出清洗：标签解析 + 围栏剥离 + 问句守卫（一级：剥问句尾部，剥空报错）。 ── */

function stripReferencePlaceholders(text) {
  return String(text ?? "").replace(/[-￼]/gu, "");
}

function normalizeOutput(raw, maxChars) {
  let text = stripReferencePlaceholders(raw).replace(/\r\n/gu, "\n").trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/u.exec(text);
  if (fence !== null) text = fence[1].trim();
  const lines = text.split("\n");
  if (lines.length > 1) {
    const first = lines[0].trim();
    if (first.length <= 40 && ((/[：:]$/u.test(first) && !/[。.!?]$/u.test(first)) || /^(?:增强版|增强结果|优化版)$/u.test(first))) {
      text = lines.slice(1).join("\n").trim();
    }
  }
  return text.slice(0, maxChars).trim();
}

function classifyEnhancementOutput(raw, maxChars) {
  /* 裸标签（模型只回 UNCHANGED、后面什么都没有）也必须认出来，
     否则它会被当成正文写进草稿 —— 用户点到就是在输入框里看到 UNCHANGED。 */
  const normalized = normalizeOutput(raw, maxChars)
    .replace(/^(?:\*\*|__)(ENHANCED|UNCHANGED)(?:\*\*|__)(?=\s|\r?\n|:|：|,|，|$)/iu, "$1");
  const match = /^(ENHANCED|UNCHANGED)(?:\s*(?:\r?\n|:|：|,|，)\s*|[\t ]+|$)/iu.exec(normalized);
  if (!match) return { kind: "enhanced", text: normalized };
  const body = normalized.slice(match[0].length).trim();
  /* 正文剥空，或正文就是另一个标签词：都按无改写处理。 */
  if (body === "" || /^(ENHANCED|UNCHANGED)(?:\*\*|__)?$/iu.test(body)) {
    return { kind: "unchanged", text: "" };
  }
  return { kind: match[1].toLowerCase(), text: body };
}

/** 问句守卫：模型把改写写成了问题 → 剥掉问句行，留陈述部分。剥空则报错，绝不把问题塞给用户。 */
function salvageRewrite(text) {
  const lines = String(text ?? "").split("\n");
  const kept = lines.filter((line) => {
    const s = line.trim();
    if (!s) return true;
    return !/[?？]\s*$/.test(s) && !/^(请问|是否需要|要不要|需要我|shall i|should i|do you want)/iu.test(s);
  });
  const body = kept.join("\n").trim();
  return body || null;
}

/* ── 生成：prepareCall → stream 聚合。无翻倍梯子（按钮场景 maxTokens 4096 足够）。 ── */

/** 宿主的 message.content 必须是内容块数组（adapter 会调 content.some）。 */
function buildUserContent(draft) {
  const safeDraft = stripReferencePlaceholders(draft);
  return [{
    type: "text",
    text: `Rewrite this draft into an enhanced prompt. It is the user's own text, between the triple quotes:\n\n"""\n${safeDraft}\n"""`,
  }];
}

async function generate(llm, route, system, draft, signal, directive = "") {
  const providers = llm.listProviders();
  if (!providers.some((entry) => entry.id === route.provider)) {
    throw new EnhanceFailure("NO_ADAPTER", `模型提供商「${route.provider}」未启用，请重新选择模型。`);
  }
  let call;
  try {
    call = await llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens: MAX_TOKENS },
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new EnhanceFailure("PREPARE", `模型准备失败：${error?.message ?? "未知错误"}`);
  }
  const effectiveSystem = directive ? `${system}\n\n${directive}` : system;
  let text = "";
  let finish;
  for await (const chunk of call.stream({ ...call.config, system: effectiveSystem, messages: [{ role: "user", content: buildUserContent(draft) }], signal })) {
    signal.throwIfAborted();
    if (chunk.type === "text-delta") {
      text += chunk.text;
      if (text.length > MAX_OUTPUT_CHARS * 4) throw new EnhanceFailure("TOO_LARGE", "模型返回内容过长，已停止，草稿保持不变。");
    } else if (chunk.type === "finish") {
      finish = chunk.reason;
    }
  }
  signal.throwIfAborted();
  if (finish !== undefined && (finish.kind === "error" || finish.kind === "aborted")) {
    throw new EnhanceFailure("STREAM", `模型请求失败${finish.failure?.message === undefined ? "" : `：${finish.failure.message}`}`);
  }
  if (finish !== undefined && finish.kind === "max-tokens") {
    throw new EnhanceFailure("OUTPUT_TRUNCATED", "模型输出达到上限仍未完成，请缩短草稿后重试。");
  }
  return text;
}

/* ── 硬校验：提示词是软约束，模型可以不听；这四道检查是程序说的话。 ── */

/* 结构检查认“行首标签 + 冒号”，不认“正文里出现过这个词”。
   理由：模型写「目的：」而不是「目标：」时，包含判断会误判为不合格并白烧一次重试；
   反过来，正文里碰巧出现“标准”两个字也不该算结构齐。同义词表按实际输出样本扩。 */
const DIMENSION_LABEL_PATTERN = /(?:^|\n)[ \t>*#-]*(目标|目的|输入|素材|来源|范围|边界|方法|步骤|流程|输出|产出|交付|验收|标准|评判)[ \t]*[：:]|(?:^|\n)[ \t>*#-]*(GOAL|INPUTS|SCOPE|METHOD|OUTPUT|QUALITY(?:\s*BAR)?)[ \t]*[：:]/iu;

/** 粗略判定主要语言：中文一字≈英文三字母的信息量。 */
function dominantLanguage(text) {
  const cjk = (String(text ?? "").match(/[一-鿿]/gu) || []).length;
  const latin = (String(text ?? "").match(/[A-Za-z]/gu) || []).length;
  if (cjk === 0 && latin === 0) return "unknown";
  return cjk * 3 >= latin ? "zh" : "en";
}

/** 只抽明确的事实锚点（URL / IP / 反引号内容），不做模糊匹配以免误报。 */
const FACT_PATTERNS = [
  /https?:\/\/[^\s"'`）)，,。；;]+/gu,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/gu,
  /`[^`\n]+`/gu,
];

function extractFacts(draft) {
  const facts = new Set();
  for (const re of FACT_PATTERNS) {
    for (const match of String(draft ?? "").matchAll(re)) facts.add(match[0]);
  }
  return [...facts];
}

/**
 * 返回问题列表；空数组 = 通过。
 * 四道检查都只做保守判定：宁可漏判，不可把合格输出判死。
 */
export function validateRewrite(draft, text, mode = "official") {
  const problems = [];
  if (dominantLanguage(draft) === "zh" && dominantLanguage(text) !== "zh") {
    problems.push("语言必须与草稿一致（中文）");
  }
  /* 红队全链路扩展天然是原文的几十倍（22 字的「打穿」要展开成 5 阶段 + 报告契约），
     按官方 5 倍算会把正确输出判死、白烧一次重试。 */
  const cap = mode === "redteam"
    ? Math.min(Math.max(String(draft ?? "").length * 25, 2000), 4000)
    : Math.min(Math.max(String(draft ?? "").length * 5, 600), 4000);
  if (String(text ?? "").length > cap) problems.push(`总长度不得超过 ${cap} 字符`);
  const missing = extractFacts(draft).filter((fact) => !String(text ?? "").includes(fact));
  if (missing.length > 0) problems.push(`必须逐字保留原文里的：${missing.slice(0, 3).join("、")}`);
  /* 至少两行带维度标签，才算结构齐（一行可能只是巧合）。 */
  const labelLines = String(text ?? "").split("\n").filter((line) => DIMENSION_LABEL_PATTERN.test("\n" + line)).length;
  if (labelLines < 2) problems.push("必须用维度小标题（目标/输入/范围/方法/输出/验收）分节");
  return problems;
}

/* ── 请求编排 ── */

function toFailure(error, signal) {
  if (signal.aborted) {
    const timedOut = signal.reason?.name === "TimeoutError";
    return fail(timedOut ? "TIMEOUT" : "ABORTED", timedOut ? `增强超过 ${Math.round(TIMEOUT_MS / 1000)} 秒已停止，草稿保持不变。` : "增强已停止，草稿保持不变。");
  }
  if (error instanceof EnhanceFailure) return fail(error.code, error.message);
  return fail("INTERNAL", `增强失败：${error?.message ?? "未知错误"}。草稿保持不变。`);
}

/**
 * 处理一次增强 POST。
 * @param scope  llm 注入后的插件 scope（scope.llm 可用）。
 * @param ctx    插件根 ctx（读 sessions / sessionController / 演练台绑定）。
 * @param readJsonBody  (request) => body，由 lib/index.js 传入。
 */
export async function handle(scope, ctx, readJsonBody, request, response, sendJson) {
  const lifetime = new AbortController();
  /* Node 的 request close 在 body 读完就触发（≠客户端断开），不能用它。
     客户端 abort fetch 会 destroy socket → socket close；正常完成时响应已写完，
     writableEnded 拦住误杀。keep-alive 下 socket 不关，无副作用。 */
  const onClientGone = () => {
    if (!response.writableEnded) { try { lifetime.abort(); } catch { /* ignore */ } }
  };
  if (request.socket) request.socket.once("close", onClientGone);
  response.once("close", onClientGone);
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const body = await readJsonBody(request);
    const draft = body?.draft;
    if (typeof draft !== "string" || draft.trim().length === 0) {
      sendJson(response, 400, fail("DRAFT_EMPTY", "先输入需要增强的内容。"));
      return;
    }
    if (draft.length > MAX_DRAFT_CHARS) {
      sendJson(response, 400, fail("DRAFT_TOO_LONG", `草稿超过 ${MAX_DRAFT_CHARS} 字符，请精简后重试。`));
      return;
    }
    const sessionId = typeof body?.sessionId === "string" && body.sessionId.length <= 200 ? body.sessionId : "";
    const modeHint = body?.modeHint === "redteam" ? "redteam" : "";
    const llm = scope.llm;
    if (llm === undefined) {
      sendJson(response, 503, fail("UNAVAILABLE", "当前宿主未提供模型服务，无法增强提示词。"));
      return;
    }
    const route = resolveRoute(scope, sessionId);
    if (route === undefined) {
      sendJson(response, 409, fail("NO_MODEL", "当前没有可用的模型选择，请先在输入栏选择一个模型。"));
      return;
    }
    const mode = await resolveMode(ctx, sessionId, draft, modeHint);
    const contextBlock = clipText(mode === "redteam" ? redteamContext(ctx, sessionId) : officialContext(ctx, sessionId), MAX_CONTEXT_CHARS);
    const system = peSystemPrompt(mode, contextBlock);

    /* 一次生成 + 解析。失败抛 EnhanceFailure，由外层统一转失败信封。 */
    const produce = async (directive) => {
      const raw = await generate(llm, route, system, draft, signal, directive);
      const parsed = classifyEnhancementOutput(raw, MAX_OUTPUT_CHARS);
      if (parsed.kind === "unchanged") return { kind: "unchanged", text: "" };
      if (!parsed.text) throw new EnhanceFailure("EMPTY", "模型没有返回可用的提示词，草稿保持不变。");
      const salvaged = salvageRewrite(parsed.text);
      if (salvaged === null) throw new EnhanceFailure("ONLY_QUESTION", "模型只返回了问题，没有产出提示词，草稿保持不变。");
      return { kind: "enhanced", text: salvaged };
    };

    let result = await produce("");
    let warnings = [];
    /* 校验不过 → 带着失败原因重试一次；重试崩了不连累第一次的有效结果。 */
    if (result.kind === "enhanced") {
      const problems = validateRewrite(draft, result.text, mode);
      if (problems.length > 0) {
        const directive = `Your previous rewrite failed these checks: ${problems.join("; ")}. Rewrite again and satisfy every one of them.`;
        try {
          const retry = await produce(directive);
          if (retry.kind === "enhanced") {
            result = retry;
            warnings = validateRewrite(draft, retry.text, mode);
          } else {
            warnings = problems;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          warnings = problems;
        }
      }
    }
    sendJson(response, 200, {
      ok: true,
      kind: result.kind,
      text: result.text,
      mode,
      provider: route.provider,
      model: route.model,
      hasContext: Boolean(contextBlock),
      warnings,
    });
  } catch (error) {
    try { sendJson(response, 500, toFailure(error, signal)); } catch { /* 连接已断 */ }
  }
}
