/**
 * cache.js — 前端共享缓存守卫：带 TTL 的条目缓存 + 显式失效。
 * 配方 spec、skill 模板这类「用户会改掉内容」的拉取结果，只按 key 缓存不失效，
 * 就会在整页会话里一直用旧数据；统一走这里，TTL 兜底 + 保存事件显式清空。
 */

export const DEFAULT_TTL_MS = 120000;

export function ttlCache(ttlMs = DEFAULT_TTL_MS) {
    const entries = new Map();
    return {
        get(key) {
            const hit = entries.get(key);
            if (!hit) return undefined;
            if (Date.now() - hit.at > ttlMs) {
                entries.delete(key);
                return undefined;
            }
            return hit.value;
        },
        set(key, value) {
            entries.set(key, { value, at: Date.now() });
            return value;
        },
        clear() {
            entries.clear();
        },
        get size() {
            return entries.size;
        },
    };
}
