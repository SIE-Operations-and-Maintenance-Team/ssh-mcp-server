// 全局默认值的唯一来源：后端路由与前端（经 /admin/api/defaults）共用，
// 防止多处写死后漂移（安全黑名单漂移尤其危险）。

// 新建项目时自动创建的默认环境
export const DEFAULT_ENVIRONMENTS: string[] = ["开发环境", "测试环境", "生产环境", "UAT环境"];

// 未配置安全策略时的默认命令黑名单（行首锚定正则）
export const DEFAULT_COMMAND_BLACKLIST: string[] = [
  "^rm\\s+.*",
  "^shutdown.*",
  "^reboot.*",
  "^halt.*",
  "^poweroff.*",
  "^mkfs.*",
  "^dd\\s+.*",
];
