// Rollup: 把 src/ 下的 TS + Lit 打成**自包含 ESM** 卡片, 输出到集成的 www/ 目录。
//
// 关键约束(见重构方案):
//   * 产物必须零外部请求 —— lit 与所有依赖静态内联, 产物里不含任何 import / CDN 引用;
//   * 必须是 ESM(不是 IIFE)—— 控制卡用 `import.meta.url` 相对解析车模/座舱图的前缀,
//     这张卡从哪个前缀加载、图片就走哪个前缀; IIFE 拿不到模块 URL。
//   * 每张卡一个**完全自包含**的文件(六个入口各自单独构建)。
//
// 为什么要"每个入口单独构建一次": rollup 在多入口模式下会把 lit 抽成共享 chunk
// (lit-element-*.js)。而 Python 侧只把六个具名文件注册成 Lovelace 资源、不提供
// 那个 chunk —— 卡片会因 import 失败而"配置错误"。所以这里**逐入口独立打包**,
// 每次只保留该入口用到的代码, 天然内联全部依赖、绝不产生跨文件引用。
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const OUT_DIR = "custom_components/leapmotor/www";

// 入口名 = 产物文件名(leapmotor-<name>.js), 与 __init__.py 的 _CARDS 一一对应。
const ENTRIES = {
  "leapmotor-map": "src/entries/map.entry.ts",
  "leapmotor-trips": "src/entries/trips.entry.ts",
  "leapmotor-control": "src/entries/control.entry.ts",
  "leapmotor-energy": "src/entries/energy.entry.ts",
  "leapmotor-lastweek": "src/entries/lastweek.entry.ts",
  "leapmotor-metrics": "src/entries/metrics.entry.ts",
};

const plugins = () => [
  nodeResolve({ browser: true }),
  typescript({
    tsconfig: "./tsconfig.json",
    // 由 rollup 统一产出; tsc 只在 `npm run typecheck` 里做类型检查
    noEmit: false,
    declaration: false,
    sourceMap: false,
  }),
  terser({ format: { comments: false }, compress: { passes: 2 } }),
];

const CARD_BUILDS = Object.entries(ENTRIES).map(([name, src]) => ({
  input: src,
  output: {
    file: `${OUT_DIR}/${name}.js`,
    format: "es",
    sourcemap: false, // 产物要提交进仓库, 不留 map
    inlineDynamicImports: true, // 单文件: 不允许产生动态 import 的独立 chunk
  },
  plugins: plugins(),
}));

export default CARD_BUILDS;
