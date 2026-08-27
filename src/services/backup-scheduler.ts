import type { ConfigStore } from "./config-store.js";
import type { BackupService } from "./backup-service.js";

let timer: NodeJS.Timeout | null = null;
let stopped = false;
/** 上次启动调度器时的备份配置签名，用于去重避免重复重置 timer */
let lastSig: string | null = null;
/** 上次备份时间戳（ms），用于判断是否到达间隔 */
let lastBackupTs = 0;
/** 防止并发备份 */
let running = false;

/** 检查间隔：每 10 分钟检查一次是否该备份，避免 setTimeout 32-bit 溢出 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function stopBackupScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  lastSig = null;
}

export function startBackupScheduler(store: ConfigStore, svc: BackupService, cfg: any) {
  const b = cfg?.backups;
  if (!b?.autoEnabled) {
    if (lastSig !== null) stopBackupScheduler();
    return;
  }
  const hours = b.intervalHours ?? 24;
  if (!hours || hours < 1) {
    if (lastSig !== null) stopBackupScheduler();
    return;
  }
  // 配置未变则跳过，避免 chokidar onChange 重复触发导致 timer 重置
  const sig = `${b.autoEnabled}|${hours}|${b.retentionDays ?? ""}|${b.maxCount ?? ""}`;
  if (sig === lastSig) return;
  stopBackupScheduler();
  stopped = false;
  lastSig = sig;
  const intervalMs = hours * 3600 * 1000;
  console.error("[backup-scheduler] starting auto backup every", hours, "hour(s)");

  const doBackup = async () => {
    if (stopped || running) return;
    running = true;
    try {
      console.error("[backup-scheduler] auto snapshot start");
      await svc.snapshot();
      const latest: any = await store.load();
      await svc.prune(latest?.backups?.retentionDays, latest?.backups?.maxCount);
      console.error("[backup-scheduler] auto snapshot done");
      lastBackupTs = Date.now();
    } catch (e) {
      console.error("[backup-scheduler] auto snapshot failed:", e);
    } finally {
      running = false;
    }
  };

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastBackupTs >= intervalMs) {
      // 时间到了，执行备份（不 await，避免阻塞 tick 调度）
      doBackup();
    }
    timer = setTimeout(tick, CHECK_INTERVAL_MS);
    timer.unref?.();
  };

  // 首次启动时，如果从未备份过，立即执行一次
  if (lastBackupTs === 0) {
    lastBackupTs = Date.now();
    // 延迟一个 tick 再执行，避免阻塞启动
    timer = setTimeout(async () => {
      if (stopped) return;
      await doBackup();
      tick();
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
  } else {
    tick();
  }
}

export function rescheduleBackupScheduler(store: ConfigStore, svc: BackupService, cfg: any) {
  startBackupScheduler(store, svc, cfg);
}
