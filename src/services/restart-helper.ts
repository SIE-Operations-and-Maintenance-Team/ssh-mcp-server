import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 应用控制（重启）：移植自 MCP-DB-Tools 的 RestartHelper ——
// 起一个分离的隐藏 PowerShell 守候当前 PID 退出后再拉起新实例（避免端口占用冲突），
// 随后优雅关闭当前进程。新实例不带 --admin-port，从 config.json 读端口（端口修改由此生效）。
// 实现为临时 .ps1 文件执行：避免 -Command 的嵌套引号在含空格路径下被错误解析；
// 新实例 stdout/stderr 落盘到系统临时目录，启动失败时可查。
export function scheduleRestartAndExit(close: () => Promise<unknown>, timeoutMs = 15000): void {
  const exe = process.execPath;
  const script = process.argv[1] ? path.resolve(process.argv[1]) : "";

  if (process.platform === "win32" && script) {
    try {
      const dir = os.tmpdir();
      const ps1 = path.join(dir, `ssh-mcp-restart-${process.pid}.ps1`);
      const outLog = path.join(dir, "ssh-mcp-restart-out.log");
      const errLog = path.join(dir, "ssh-mcp-restart-err.log");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        `if (Get-Process -Id ${process.pid}) { Wait-Process -Id ${process.pid} -Timeout 30 }`,
        "Start-Sleep -Milliseconds 600",
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '"${script.replace(/'/g, "''")}"','--admin' -WorkingDirectory '${path.dirname(script).replace(/'/g, "''")}' -WindowStyle Hidden -RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'`,
      ].join("; ");
      fs.writeFileSync(ps1, ps, "utf-8");
      spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      // 守候脚本启动失败则仅退出（由外部进程管理器拉起）
    }
  }
  // 非 Windows：无注册表/PowerShell 机制，仅优雅退出，依赖 systemd/pm2 等外部拉起

  const timer = setTimeout(() => process.exit(0), timeoutMs);
  timer.unref();
  Promise.resolve(close())
    .catch(() => {})
    .finally(() => process.exit(0));
}
