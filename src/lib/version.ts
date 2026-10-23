// 各卡版本号(单一真源)。
//
// 原实现把版本号散在 5 个 JS 文件的文件头 + __init__.py 里共 6 处, 全靠手工同步,
// 历史上有漂移。这里集中成一个常量表; 迁移时保持与原值一致, 改版只改这一处。
// 注意: __init__.py 的 CARD_VERSION 等仍用于 `?v=` 缓存刷新, 两边需一致(S3 会加校验测试)。
export const CARD_VERSIONS = {
  map: "1.6.21",
  trips: "1.6.28",
  control: "1.9.77",
  energy: "1.4.16",
  lastweek: "1.1.22",
  metrics: "1.0.9",
} as const;
