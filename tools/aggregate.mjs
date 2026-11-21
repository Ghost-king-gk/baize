// @ts-check
/**
 * 兼容层：聚合逻辑已移到 src/web/aggregate.mjs（服务端要看板，得能在 src 里引用）。
 * 这里保留 re-export，避免测试与外部脚本的 import 路径失效。
 */
export * from '../src/web/aggregate.mjs';
