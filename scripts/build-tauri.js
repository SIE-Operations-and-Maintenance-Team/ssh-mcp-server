#!/usr/bin/env node
/**
 * Tauri 桌面壳构建：
 *   1. 构建 Node 后端（tsc）与 Admin 前端（vite）
 *   2. 构建 sidecar（@yao-pkg/pkg 打零依赖启动器）并准备 bundle.resources
 *   3. 调用 tauri build 产出 NSIS/MSI 安装包
 *
 * 需 Rust 工具链（cargo/rustc）与 node_modules 里的 @tauri-apps/cli。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = path.join(__dirname, "..");

// 0. 校验 tauri.conf.json 关键项
const conf = JSON.parse(fs.readFileSync(path.join(rootDir, "src-tauri", "tauri.conf.json"), "utf-8"));
if (!conf.tauri.bundle.externalBin.includes("sidecars/ssh-mcp-server-node")) throw new Error("missing sidecar");
if (conf.tauri.updater?.active) throw new Error("updater 应禁用（桌面壳更新走 Node 侧 update-service）");

// 1. 后端 + 前端
console.log("[tauri] Building backend...");
execSync(`"${process.execPath}" scripts/build.js`, { stdio: "inherit", cwd: rootDir });
console.log("[tauri] Building admin frontend...");
execSync(`"${process.execPath}" node_modules/vite/bin/vite.js build`, { stdio: "inherit", cwd: path.join(rootDir, "admin-web") });

// 2. sidecar + resources
console.log("[tauri] Building sidecar + resources...");
execSync(`"${process.execPath}" scripts/build-sidecar.js`, { stdio: "inherit", cwd: rootDir });

// 3. tauri build
console.log("[tauri] Running tauri build...");
execSync(`"${process.execPath}" node_modules/@tauri-apps/cli/tauri.js build`, { stdio: "inherit", cwd: rootDir });
console.log("[tauri] Done — installer in src-tauri/target/release/bundle/");
