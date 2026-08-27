import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 桌面壳重构为 Tauri 2 单体架构（对齐 SmomPublish）后的发布配置验证：
// - 内嵌前端 dist；NSIS 单包；updater 签名（pubkey + createUpdaterArtifacts）
// - main.rs 为 Rust 原生 + 托盘 + 单例 + updater 插件，无 Node sidecar
// - 纯托盘模式：无 WebView 主窗口，管理页一律经系统浏览器打开（对齐 MCP-DB-Tools TrayHost）
describe("tauri (2.x single-binary)", () => {
  it("tauri.conf.json 版本与 package.json 一致（发版一致性）", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    assert.equal(conf.version, pkg.version);
  });

  it("updater 双重保障：pubkey + createUpdaterArtifacts（在线更新闭环）", () => {
    const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    assert.ok(conf.plugins?.updater?.pubkey?.length > 50, "updater pubkey 缺失");
    assert.ok(conf.plugins?.updater?.endpoints?.length > 0, "updater endpoints 缺失");
    assert.equal(conf.bundle?.createUpdaterArtifacts, true);
  });

  it("打包 target 为 NSIS 单安装包，无 externalBin/resources 散落；纯托盘无主窗口", () => {
    const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
    assert.ok(conf.bundle?.targets?.includes("nsis"));
    assert.equal(conf.bundle?.externalBin, undefined);
    assert.equal(conf.bundle?.resources, undefined);
    assert.equal(conf.app?.windows, undefined, "应为纯托盘模式（无 WebView 主窗口配置）");
  });

  it("main.rs 使用 Tauri 2 builder + updater 插件 + 托盘 + 单例，无 sidecar spawn、无窗口逻辑", () => {
    const rs = fs.readFileSync("src-tauri/src/main.rs", "utf8");
    assert.match(rs, /tauri_plugin_updater/);
    assert.match(rs, /tauri_plugin_single_instance/);
    assert.match(rs, /mcp::manager::init/);
    assert.match(rs, /tray::ssh_menu/, "托盘入口缺失");
    assert.match(rs, /tray::open_admin/, "二次启动打开管理页缺失");
    assert.doesNotMatch(rs, /get_webview_window/, "不应残留 WebView 窗口逻辑");
    assert.doesNotMatch(rs, /ssh-mcp-server-node/);
    assert.doesNotMatch(rs, /sidecar/);
  });

  it("前端 dist 存在（include_dir 编译所需，缺失则 tauri build 失败）", () => {
    assert.ok(
      fs.existsSync(path.join("admin-web", "dist", "index.html")),
      "admin-web/dist/index.html 缺失——请先 npm --prefix admin-web run build",
    );
  });
});