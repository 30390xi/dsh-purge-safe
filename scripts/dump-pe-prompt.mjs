/**
 * 导出提示词增强按钮实际下发的完整 system prompt。
 * 用法：
 *   node scripts/dump-pe-prompt.mjs redteam
 *   node scripts/dump-pe-prompt.mjs official
 *   node scripts/dump-pe-prompt.mjs redteam --no-context
 *   node scripts/dump-pe-prompt.mjs --both        # 两模式一起，含示例上下文
 */
import { peSystemPrompt } from "../lib/pe-rules.mjs";

const SAMPLE_CONTEXT = {
  redteam: [
    "靶标绑定：shop-example",
    "资产 12（存活 7），开放端口 9，网段 2，漏洞 3，攻击步骤 5。",
    "· 10.0.0.5 · Tomcat 弱口令 · 爆破成功",
    "· 10.0.0.7 · /upload 任意文件上传 · 已取得 webshell",
    "进展：web:3，shell:1",
  ].join("\n"),
  official: [
    "1. 写个爬虫抓这个站的文章",
    "2. 加个断点续抓，失败要重试",
    "3. 输出改成 jsonl，不要 csv",
  ].join("\n"),
};

const args = process.argv.slice(2);
const both = args.includes("--both");
const noContext = args.includes("--no-context");
const modes = both ? ["redteam", "official"] : [args.find((a) => a === "redteam" || a === "official") || "redteam"];

for (const mode of modes) {
  const context = noContext ? "" : SAMPLE_CONTEXT[mode];
  const prompt = peSystemPrompt(mode, context);
  console.log("=".repeat(78));
  console.log(`MODE: ${mode}   上下文块: ${context ? "有" : "无"}   字符数: ${prompt.length}`);
  console.log("=".repeat(78));
  console.log(prompt);
  console.log("");
}
