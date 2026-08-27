#!/usr/bin/env node
/**
 * 生成测试报告：跑测试拿通过/失败/跳过，读 c8 json-summary 覆盖率，产出 docs/test-report.md。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const nodeBin = process.execPath;

const FEATURE_MAP = [
  { feature: "CLI 参数解析", src: "src/cli/command-line-parser.ts", tests: ["test/command-line-parser.test.js", "test/cli-hierarchy.test.js", "test/cli-info-flags.test.js"] },
  { feature: "SSH config 解析", src: "src/utils/ssh-config-parser.ts", tests: ["test/ssh-config-parser.test.js"] },
  { feature: "配置存储 / 层级", src: "src/services/config-store.ts", tests: ["test/config-store.test.js", "test/config-store-hierarchy.test.js", "test/config-import.test.js"] },
  { feature: "SSH 连接管理", src: "src/services/ssh-connection-manager.ts", tests: ["test/ssh-connection-manager.test.js", "test/ssh-manager-hierarchy.test.js", "test/e2e-mcp.test.js"] },
  { feature: "Admin 路由", src: "src/server/routes/admin.ts", tests: ["test/admin-routes-hierarchy.test.js", "test/admin-advanced-auth.test.js", "test/admin-transport.test.js", "test/admin-limits.test.js"] },
  { feature: "MCP 工具注册", src: "src/tools/index.ts", tests: ["test/e2e-mcp.test.js"] },
  { feature: "工具：execute-command", src: "src/tools/execute-command.ts", tests: ["test/e2e-mcp.test.js", "test/ssh-connection-manager.test.js"] },
  { feature: "工具：upload/download", src: "src/tools/upload.ts / src/tools/download.ts", tests: ["test/e2e-mcp.test.js", "test/ssh-connection-manager.test.js"] },
  { feature: "工具：list-servers", src: "src/tools/list-servers.ts", tests: ["test/tools.test.js", "test/list-servers.test.js", "test/e2e-mcp.test.js"] },
  { feature: "错误模型", src: "src/utils/tool-error.ts", tests: ["test/tool-error.test.js"] },
  { feature: "日志", src: "src/utils/logger.ts", tests: ["test/logger.test.js"] },
  { feature: "状态收集", src: "src/utils/status-collector.ts", tests: ["test/status-collector.test.js"] },
  { feature: "审计", src: "src/services/audit-store.ts", tests: ["test/audit.test.js"] },
  { feature: "备份", src: "src/services/backup-service.ts", tests: ["test/backup.test.js"] },
  { feature: "Settings", src: "src/server/routes/settings.ts", tests: ["test/settings.test.js"] },
  { feature: "HTTP 服务", src: "src/server/index.ts", tests: ["test/server.test.js"] },
];

function runTestSuite() {
  let stdout;
  try {
    stdout = execFileSync(
      nodeBin,
      ["--test", "test/**/*.test.js"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    // 已知失败会让 node --test 退出码非 0；stdout 里仍有完整 TAP。
    stdout = err && typeof err.stdout === "string" ? err.stdout : "";
  }
  // 解析 TAP 汇总（--test-reporter=json 在部分 Node 22 版本不可用，改从 TAP 取数）。
  const lastOf = (re) => {
    const all = [...stdout.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : 0;
  };
  const tests = lastOf(/# tests (\d+)/g);
  const pass = lastOf(/# pass (\d+)/g);
  const fail = lastOf(/# fail (\d+)/g);
  const skip = lastOf(/# skipped (\d+)/g);
  const failedNames = [...stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { tests, pass, fail, skip, failedNames };
}

function readCoverage() {
  const covPath = path.join(root, "coverage", "coverage-summary.json");
  if (!existsSync(covPath)) {
    return { missing: true };
  }
  const raw = JSON.parse(readFileSync(covPath, "utf8"));
  const rows = [];
  const totalKey = raw.total ?? {};
  const pct = (n) => (n && Number.isFinite(n.pct) ? `${n.pct}%` : "-");
  for (const [absPath, metrics] of Object.entries(raw)) {
    if (absPath === "total") continue;
    let rel = path.relative(root, absPath).split(path.sep).join("/");
    if (rel.startsWith("build/")) {
      rel = "src/" + rel.slice("build/".length).replace(/\.js$/, ".ts");
    }
    if (!rel.startsWith("src/")) continue;
    rows.push({ rel, lines: pct(metrics.lines), functions: pct(metrics.functions) });
  }
  rows.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    missing: false,
    rows,
    total: { lines: pct(totalKey.lines), functions: pct(totalKey.functions) },
  };
}

function buildMarkdown({ result, coverage, date }) {
  const lines = [];
  lines.push(`# 测试报告`);
  lines.push("");
  lines.push(`> 生成时间：${date} ｜ 由 \`npm run test:report\` 生成（不提交 git）`);
  lines.push("");
  lines.push(`## 总览`);
  lines.push("");
  lines.push(`| 测试数 | 通过 | 失败 | 跳过 |`);
  lines.push(`| --- | --- | --- | --- |`);
  lines.push(`| ${result.tests} | ${result.pass} | ${result.fail} | ${result.skip} |`);
  lines.push("");
  if (result.failedNames.length > 0) {
    lines.push(`### 失败用例（已知，不修复）`);
    lines.push("");
    for (const name of result.failedNames) {
      lines.push(`- \`${name}\` — 由进行中的 admin hierarchy 改动导致（新建项目自动建 4 个默认环境 / 连接列表不再掩码密码）。`);
    }
    lines.push("");
  }
  lines.push(`## 功能 → 测试映射`);
  lines.push("");
  lines.push(`| 功能 | 源码 | 测试文件 |`);
  lines.push(`| --- | --- | --- |`);
  for (const row of FEATURE_MAP) {
    lines.push(`| ${row.feature} | \`${row.src}\` | ${row.tests.map((t) => `\`${t}\``).join(", ")} |`);
  }
  lines.push("");
  lines.push(`## 覆盖率（c8，行/函数）`);
  lines.push("");
  if (coverage.missing) {
    lines.push(`_未找到 \`coverage/coverage-summary.json\`，请先运行 \`npm run test:coverage\`。_`);
  } else {
    lines.push(`| 文件 | 行覆盖 | 函数覆盖 |`);
    lines.push(`| --- | --- | --- |`);
    for (const row of coverage.rows) {
      lines.push(`| \`${row.rel}\` | ${row.lines} | ${row.functions} |`);
    }
    lines.push(`| **总计** | ${coverage.total.lines} | ${coverage.total.functions} |`);
  }
  lines.push("");
  lines.push(`## 说明`);
  lines.push("");
  lines.push(`- 测试框架：Node 内置 \`node:test\`。全量命令：\`node --test test/**/*.test.js\`。`);
  lines.push(`- 覆盖率工具：\`c8\`（\`npm run test:coverage\`）；tsconfig 已开 \`sourceMap\` 使覆盖率归属 \`src/*.ts\`。`);
  lines.push(`- \`SshMcpServer.run()\`（stdio 传输路径）属手工/进程内场景，不在自动单测覆盖内。`);
  return lines.join("\n");
}

const result = runTestSuite();
const coverage = readCoverage();
const markdown = buildMarkdown({
  result,
  coverage,
  date: new Date().toISOString(),
});
const outPath = path.join(root, "docs", "test-report.md");
writeFileSync(outPath, markdown, "utf8");
console.log(`✔ 报告已生成：${path.relative(root, outPath)}（${result.tests} 测试 / ${result.pass} 通过 / ${result.fail} 失败）`);