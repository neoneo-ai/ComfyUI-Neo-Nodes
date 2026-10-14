/**
 * object-info.js — 节点定义 / 模型目录的会话级缓存。
 * 全量 /object_info 十几 MB、服务端逐节点构建近 1 秒；技能详情每开一次图、每点一次内嵌编辑都
 * 重拉一遍，点击就被拖成秒级。这里只按工作流用到的 class 拉 /object_info/{class}（十几 KB），
 * TTL 兜底 + 在途去重。
 * 取值约定：已注册 → 定义对象；未注册 → {}；拉取失败 → null（调用方按「跳过检查」处理，
 * 不把网络失败当成缺节点）。只有非空结果进缓存，{} / null / 空目录都不缓存，节点装好、模型下好
 * 或服务恢复后下一次就生效。
 */
import { ttlCache } from "./cache.js";

const _defs = ttlCache();
const _modelLists = ttlCache();
const _inflight = new Map();

function cached(cache, key, load) {
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = _inflight.get(key);
    if (pending) return pending;
    const p = load()
        // 只缓存真正取到的内容：未注册（{}）与空目录（[]）不缓存，节点装好 / 模型下好下一次就生效
        .then((v) => { if (v && Object.keys(v).length) cache.set(key, v); return v; })
        .catch(() => null)
        .finally(() => _inflight.delete(key));
    _inflight.set(key, p);
    return p;
}

/** 单个节点类定义（见文件头取值约定）。 */
export function getNodeDef(classType) {
    return cached(_defs, classType, async () => {
        const res = await fetch(`/object_info/${encodeURIComponent(classType)}`);
        if (!res.ok) return null;   // 拉取失败 ≠ 未注册，交给调用方按「跳过检查」处理
        const data = await res.json();
        return data[classType] || {};
    });
}

/** 批量取节点类定义：class → 定义 / {} / null。 */
export async function getNodeDefs(classTypes) {
    const uniq = [...new Set(classTypes.filter(Boolean))];
    const defs = {};
    await Promise.all(uniq.map(async (cls) => { defs[cls] = await getNodeDef(cls); }));
    return defs;
}

/** 某模型目录的文件名列表；拉取失败返回 null。 */
export function getModelList(folder) {
    return cached(_modelLists, folder, () => fetch(`/models/${encodeURIComponent(folder)}`)
        .then((res) => (res.ok ? res.json() : null)));
}

export function clearObjectInfoCache() {
    _defs.clear();
    _modelLists.clear();
    _inflight.clear();
}
