// 共享缓存守卫：TTL 过期、显式清空、命中不刷新时间戳。
import test from "node:test";
import assert from "node:assert/strict";
import { ttlCache, DEFAULT_TTL_MS } from "../../web/js/core/cache.js";

test("ttlCache 命中 / 过期 / 清空", () => {
    const clock = { now: 1000 };
    const realNow = Date.now;
    Date.now = () => clock.now;
    try {
        const cache = ttlCache(500);
        cache.set("recipe-a", { segments: 3 });
        assert.equal(cache.get("recipe-a").segments, 3);

        clock.now += 400;
        assert.equal(cache.get("recipe-a").segments, 3, "TTL 内应命中");

        clock.now += 200;
        assert.equal(cache.get("recipe-a"), undefined, "超过 TTL 应失效");
        assert.equal(cache.size, 0, "过期条目应被移除");

        cache.set("recipe-b", 1);
        assert.equal(cache.size, 1);
        cache.clear();
        assert.equal(cache.size, 0);
        assert.equal(cache.get("recipe-b"), undefined);
    } finally {
        Date.now = realNow;
    }
});

test("默认 TTL 存在且为正数", () => {
    assert.ok(Number.isFinite(DEFAULT_TTL_MS) && DEFAULT_TTL_MS > 0);
    const cache = ttlCache();
    cache.set("k", "v");
    assert.equal(cache.get("k"), "v");
});
