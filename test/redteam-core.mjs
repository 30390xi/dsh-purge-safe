/* 红队核心回归测试：守住已修过的四类坑。
   跑法：node test/redteam-core.mjs（或 npm test）。
   每个用例一个空靶标库，跑完删除临时目录。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedteamStore } from "../lib/redteam/store-core.js";

const root = mkdtempSync(join(tmpdir(), "rt-test-"));
const store = new RedteamStore(root);
const { id } = store.openEngagement("test", ["10.0.0.0/24"]);
const ipInt = (ip) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log("ok " + passed + " - " + name);
}

test("干净库 finalize 放行，legacy 调试布局仍可渲染", () => {
  store.savePlan(id, { goal: "验证最终交付" });
  const rep = store.scoreReport(id, { finalize: true });
  assert.equal(rep.layout, "simple");
  assert.equal(rep.deliverable.ok, true);
  const legacy = store.scoreReport(id, { layout: "legacy" });
  assert.equal(legacy.layout, "legacy");
  assert.match(legacy.markdown, /## 7\. 交付前检查/);
});

test("多档得分点直接 score_hit 不填 points 被拒", () => {
  assert.throws(
    () => store.addScoreHit(id, { code: "server-host", target: "10.0.0.5", evidence: "普通用户" }),
    /多档得分点必须填 points/,
  );
  const hit = store.addScoreHit(id, { code: "server-host", target: "10.0.0.5", evidence: "普通用户", points: 10 });
  assert.equal(hit.base_points, 10);
});

test("chain_add 多档不填 points 不自动记分，填了才记", () => {
  const r1 = store.addChainStep(id, {
    stage: "exploit", title: "shell", tool: "id", result: "www", target: "10.0.0.6",
    point_code: "server-host", evidence: "普通用户",
  });
  assert.equal(r1.hit, null);
  assert.match(String(r1.score_hint), /points/);
  const r2 = store.addChainStep(id, {
    stage: "exploit", title: "shell2", tool: "id", result: "root", target: "10.0.0.7",
    point_code: "server-host", evidence: "管理员", points: 50,
  });
  assert.equal(r2.hit.base_points, 50);
});

test("plan 部分更新不清空其它字段", () => {
  store.savePlan(id, { goal: "G", timebox: "48h", deadline: "2026-12-01T00:00:00Z" });
  store.savePlan(id, { goal: undefined, timebox: undefined, deadline: undefined, noise_budget: "轻" });
  const plan = store.getPlan(id).plan;
  assert.equal(plan.goal, "G");
  assert.equal(plan.deadline, "2026-12-01T00:00:00Z");
  assert.equal(plan.noise_budget, "轻");
});

test("hypothesis 只标 status 不冲掉标题与入口", () => {
  const h = store.addHypothesis(id, { title: "打 VPN 入口", entry: "vpn.acme.tld" });
  const row = store.updateHypothesis(id, h.id, {
    status: "confirmed", note: undefined, title: undefined, entry: undefined,
    precondition: undefined, expected_evidence: undefined, failure_signal: undefined, alternative: undefined,
  });
  assert.equal(row.status, "confirmed");
  assert.equal(row.title, "打 VPN 入口");
  assert.equal(row.entry, "vpn.acme.tld");
});

test("nextActions.total 不被 limit 截断，计划类排在主机类之前", () => {
  store.savePlan(id, { goal: "" });          // 清掉目标，让 plan 动作重新出现
  const db = store.db(id);
  for (const ip of ["10.0.0.11", "10.0.0.12", "10.0.0.13", "10.0.0.14"]) {
    db.prepare("INSERT INTO asset(segment_cidr, ip, ip_int, state, scope) VALUES(?,?,?,?,?)")
      .run("10.0.0.0/24", ip, ipInt(ip), "live", "internal");
    const aid = db.prepare("SELECT id FROM asset WHERE ip = ?").get(ip).id;
    db.prepare("INSERT INTO port(asset_id, port, proto, state) VALUES(?,?,?,?)").run(aid, 80, "tcp", "open");
  }
  const na = store.nextActions(id, { limit: 1 });
  assert.equal(na.actions.length, 1);
  assert.ok(na.total > na.actions.length, "total 应大于展示条数");
  assert.equal(na.actions[0].kind, "plan");
  const all = store.nextActions(id, { limit: 40 }).actions;
  const hostAction = all.find((x) => x.stage === "internal");
  assert.ok(hostAction === undefined || hostAction.priority >= 2);
});

test("报告仍按 simple 布局生成，含数据节；finalize 未清理时阻断", () => {
  const rep = store.scoreReport(id, { limit: 500 });
  assert.match(rep.markdown, /## 四、取得的数据/);
  store.addCleanup(id, { kind: "webshell", target: "10.0.0.6", location: "/var/www/s.php" });
  assert.throws(() => store.scoreReport(id, { finalize: true }),
    (e) => e.code === "DELIVER_BLOCKED" && e.details.blockers.some((b) => b.code === "CLEANUP_OPEN"));
});

store.close();
rmSync(root, { recursive: true, force: true });
console.log("\n" + passed + " passed");
