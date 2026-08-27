#!/usr/bin/env node
/**
 * npm pack/publish 前置：构建 TypeScript 后端 + admin-web 前端。
 * admin-web/dist 是 --admin GUI 的静态资源，必须随 npm 包发布，
 * 否则 `npx ... --admin` 打不开 /admin/ 页面（server/index.ts 仅在 dist 存在时托管）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = path.join(__dirname, "..");

console.log("[prepack] Building TypeScript backend...");
execSync(`"${process.execPath}" scripts/build.js`, { stdio: "inherit", cwd: rootDir });

console.log("[prepack] Building admin-web frontend...");
const adminWeb = path.join(rootDir, "admin-web");
if (fs.existsSync(path.join(adminWeb, "node_modules", "vite", "bin", "vite.js"))) {
  execSync(`"${process.execPath}" node_modules/vite/bin/vite.js build`, { stdio: "inherit", cwd: adminWeb });
} else {
  console.warn("[prepack] admin-web/node_modules 不存在，跳过前端构建；若 dist 已存在则沿用");
}
const dist = path.join(adminWeb, "dist");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`[prepack] admin-web/dist/index.html 缺失，无法提供 Admin GUI。请先构建前端（npm --prefix admin-web run build）`);
  process.exit(1);
}
console.log("[prepack] OK — admin-web/dist 已就绪");
