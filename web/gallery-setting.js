/**
 * Gallery Setting - directory management modal (custom dirs, OSS, Civitai sync)
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { showToast } from './gallery-utils.js';

export class GallerySetting {
    constructor(gallery) {
        this.gallery = gallery;
    }


    // ====== Directory Management Modal ======

    async buildDirModal(gallery) {
        // Remove existing modal and overlay if any
        const existingModal = document.querySelector('.neo-gallery-dir-modal');
        if (existingModal) existingModal.remove();
        const existingOverlay = document.querySelector('.neo-gallery-dir-modal-overlay');
        if (existingOverlay) existingOverlay.remove();

        let currentDirs = [];
        let hiddenDirs = new Set();
        let civitaiKeySet = false;
        let civitaiKeyHint = "";
        let civitaiProxy = "";
        let loraSyncDirs = [];
        let civitaiEnabled = false;
        let civitaiBookmarkEnabled = true;
        try {
            const resp = await api.fetchApi('/neo_gallery/get_settings');
            if (resp.ok) {
                const settings = await resp.json();
                const dirs = settings.custom_directories || [];
                if (Array.isArray(dirs)) {
                    currentDirs = [...dirs];
                } else if (settings.custom_directory) {
                    currentDirs = [settings.custom_directory];
                }
                civitaiKeySet = !!settings.civitai_api_key_set;
                civitaiKeyHint = settings.civitai_api_key_hint || "";
                civitaiProxy = settings.civitai_proxy || "";
                civitaiEnabled = !!settings.civitai_lora_enabled;
                civitaiBookmarkEnabled = settings.civitai_bookmark_enabled !== false;
                if (Array.isArray(settings.lora_sync_dirs)) loraSyncDirs = [...settings.lora_sync_dirs];
                if (Array.isArray(settings.hidden_directories)) hiddenDirs = new Set(settings.hidden_directories);
            }
        } catch (e) { }

        // Create modal overlay
        const modalOverlay = $el("div", {
            className: "neo-gallery-dir-modal-overlay",
            onclick: (e) => { if (e.target === modalOverlay) gallery.closeDirModal(); }
        });

        const modal = $el("div", { className: "neo-gallery-dir-modal" });

        // Title bar
        const titleBar = $el("div", { className: "neo-gallery-dir-modal-titlebar" }, [
            $el("span", { className: "neo-gallery-dir-modal-title", textContent: "\uD83D\uDCC1 Manage Directories" }),
            $el("span", {
                className: "neo-gallery-dir-modal-close",
                onclick: () => gallery.closeDirModal(),
                textContent: "\u00D7"
            })
        ]);

        // Directory list area (compact rows: reorder / hide / remove)
        const dirListContainer = $el("div", { className: "neo-gallery-dir-list-container" }, [
            $el("div", { className: "neo-gallery-dir-section-title", textContent: "素材目录" })
        ]);
        const dirItemsWrap = $el("div", { className: "neo-gallery-dir-items-wrap" });
        dirListContainer.appendChild(dirItemsWrap);

        const saveDirAction = async (payload) => {
            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return resp.json();
        };

        const refreshGallery = async () => {
            try { await gallery.loadGallery(); gallery.list.sortAndDisplayImages(); } catch (e) { }
        };

        const renderDirList = () => {
            dirItemsWrap.innerHTML = "";
            if (currentDirs.length === 0) {
                dirItemsWrap.appendChild($el("div", {
                    className: "neo-gallery-dir-empty",
                    textContent: "No directories configured yet."
                }));
                return;
            }
            const dirItems = $el("div", { className: "neo-gallery-dir-items" });
            currentDirs.forEach((dirPath, idx) => {
                const isHidden = hiddenDirs.has(dirPath);
                const children = [
                    $el("span", {
                        className: "neo-gallery-dir-path",
                        textContent: dirPath,
                        title: dirPath
                    })
                ];
                if (isHidden) {
                    children.push($el("span", { className: "neo-gallery-dir-hidden-badge", textContent: "已隐藏" }));
                }
                children.push($el("div", { className: "neo-gallery-dir-item-actions" }, [
                    $el("button", {
                        className: "neo-gallery-dir-ctl-btn",
                        title: "上移",
                        disabled: idx === 0,
                        onclick: () => moveDir(dirPath, "up"),
                        textContent: "\u2191"
                    }),
                    $el("button", {
                        className: "neo-gallery-dir-ctl-btn",
                        title: "下移",
                        disabled: idx === currentDirs.length - 1,
                        onclick: () => moveDir(dirPath, "down"),
                        textContent: "\u2193"
                    }),
                    $el("button", {
                        className: "neo-gallery-dir-ctl-btn",
                        title: isHidden ? "显示" : "隐藏（不在素材库中列出）",
                        onclick: () => toggleDirHidden(dirPath),
                        textContent: isHidden ? "\uD83D\uDC41" : "\uD83D\uDEAB"
                    }),
                    $el("button", {
                        className: "neo-gallery-dir-remove-btn",
                        title: "删除",
                        onclick: async (e) => {
                            e.stopPropagation();
                            await gallery.removeCustomDir(dirPath);
                            currentDirs = currentDirs.filter(p => p !== dirPath);
                            hiddenDirs.delete(dirPath);
                            renderDirList();
                            setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                            refreshGallery();
                        },
                        textContent: "\u2715"
                    })
                ]));
                dirItems.appendChild($el("div", {
                    className: "neo-gallery-dir-item" + (isHidden ? " is-hidden" : "")
                }, children));
            });
            dirItemsWrap.appendChild(dirItems);
        };

        const moveDir = async (dirPath, direction) => {
            try {
                const result = await saveDirAction({ action: "move", path: dirPath, direction });
                if (!result.success) return;
                const i = currentDirs.indexOf(dirPath);
                const j = direction === "up" ? i - 1 : i + 1;
                [currentDirs[i], currentDirs[j]] = [currentDirs[j], currentDirs[i]];
                renderDirList();
                refreshGallery();
            } catch (e) {
                console.error('[Neo Gallery] Error moving directory:', e);
            }
        };

        const toggleDirHidden = async (dirPath) => {
            try {
                const hidden = !hiddenDirs.has(dirPath);
                const result = await saveDirAction({ action: "set_hidden", path: dirPath, hidden });
                if (!result.success) return;
                if (hidden) hiddenDirs.add(dirPath); else hiddenDirs.delete(dirPath);
                renderDirList();
                refreshGallery();
            } catch (e) {
                console.error('[Neo Gallery] Error toggling directory visibility:', e);
            }
        };

        renderDirList();

        // Add new directory input area
        const addArea = $el("div", { className: "neo-gallery-dir-add-area" }, [
            $el("input", {
                type: "text",
                id: "neo-gallery-new-dir-input",
                className: "neo-gallery-dir-input",
                placeholder: "Enter directory path...",
                title: "Paste or type a full directory path here"
            }),
            $el("button", {
                className: "neo-gallery-dir-add-btn",
                onclick: async () => {
                    const input = document.getElementById('neo-gallery-new-dir-input');
                    const dirPath = input.value.trim();

                    if (!dirPath) return;

                    try {
                        const resp = await api.fetchApi('/neo_gallery/save_settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: "add", path: dirPath })
                        });
                        const result = await resp.json();

                        if (resp.ok && result.success) {
                            input.value = '';
                            if (!currentDirs.includes(dirPath)) currentDirs.push(dirPath);
                            renderDirList();
                            setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                            refreshGallery();
                        } else {
                            alert('Failed: ' + (result.error || 'Unknown error'));
                        }
                    } catch (e) {
                        console.error('[Neo Gallery] Error adding directory:', e);
                        alert('Error adding directory');
                    }
                },
                textContent: "\u27A4"
            })
        ]);


        // ====== Civitai LORA example sync ======
        const civitaiKeyInput = $el("input", {
            type: "password",
            className: "neo-gallery-dir-input",
            placeholder: civitaiKeySet ? `Civitai API KEY configured (${civitaiKeyHint}) \u2014 leave empty to keep` : "Civitai API KEY...",
            onkeydown: (e) => { if (e.key === "Enter") saveCivitaiKey(); },
        });

        const saveCivitaiKey = async () => {
            const value = civitaiKeyInput.value.trim();
            if (!value) {
                showToast(gallery.app, 'warning', 'Civitai API KEY', '请输入 API KEY');
                return;
            }
            try {
                const resp = await api.fetchApi('/neo_gallery/save_settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: "save_civitai", api_key: value })
                });
                const result = await resp.json();
                if (resp.ok && result.success && result.civitai_api_key_set) {
                    civitaiKeyInput.value = '';
                    civitaiKeySet = true;
                    civitaiKeyHint = result.civitai_api_key_hint || "";
                    civitaiKeyInput.placeholder = `Civitai API KEY configured (${civitaiKeyHint}) \u2014 leave empty to keep`;
                    showToast(gallery.app, 'success', '已保存', 'API KEY 已保存');
                    pollLoraSync();
                } else {
                    showToast(gallery.app, 'error', '保存失败', result.error || '后端未确认写入');
                }
            } catch (e) {
                showToast(gallery.app, 'error', '保存失败', String(e));
            }
        };

        // C 站代理：多数网络直连 civitai.com 不通，代理在这里统一配置，
        // 画廊同步 / C 站收藏 / 技能修复 LoRA 下载 / 模型库 C 站源共用。
        const civitaiProxyInput = $el("input", {
            type: "text",
            className: "neo-gallery-dir-input",
            placeholder: "C 站代理（如 http://127.0.0.1:7890，留空直连）",
            value: civitaiProxy,
            onkeydown: (e) => { if (e.key === "Enter") saveCivitaiProxy(); },
        });

        const saveCivitaiProxy = async () => {
            const value = civitaiProxyInput.value.trim();
            try {
                const resp = await api.fetchApi('/neo_gallery/save_settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: "save_civitai", proxy: value })
                });
                const result = await resp.json();
                if (resp.ok && result.success) {
                    civitaiProxy = value;
                    showToast(gallery.app, 'success', '已保存',
                        value ? `C 站代理已设为 ${value}` : 'C 站已改为直连');
                } else {
                    showToast(gallery.app, 'error', '保存失败', result.error || '后端未确认写入');
                }
            } catch (e) {
                showToast(gallery.app, 'error', '保存失败', String(e));
            }
        };

        modal.appendChild(titleBar);
        modal.appendChild(dirListContainer);

        // Civitai connectivity probe: the API is often unreachable without a proxy,
        // so let the user test it explicitly instead of guessing from failed fetches.
        const netResult = $el("div", { className: "neo-gallery-net-result", textContent: "" });
        const testNetBtn = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: "\uD83D\uDD0C 测试 C 站连通性",
            onclick: async () => {
                const label = testNetBtn.textContent;
                testNetBtn.disabled = true;
                testNetBtn.textContent = "\uD83D\uDD04 测试中...";
                netResult.className = "neo-gallery-net-result warn";
                netResult.textContent = "正在连接 civitai.com（最长 20 秒）...";
                try {
                    const resp = await api.fetchApi('/neo_gallery/civitai_test', { method: 'POST' });
                    const r = await resp.json();
                    if (!resp.ok || !r.success) {
                        netResult.className = "neo-gallery-net-result err";
                        netResult.textContent = "测试失败: " + (r.error || resp.status);
                        showToast(gallery.app, 'error', 'C 站连通性', '连通性测试请求失败。');
                        return;
                    }
                    const rejected = r.http_status === 401 || r.http_status === 403;
                    const cls = (!r.reachable || rejected) ? "err" : (r.key_ok ? "ok" : "warn");
                    netResult.className = `neo-gallery-net-result ${cls}`;
                    netResult.textContent = r.message;
                    showToast(gallery.app, cls === "ok" ? 'success' : cls === "warn" ? 'warning' : 'error',
                        'C 站连通性', r.message);
                } catch (e) {
                    netResult.className = "neo-gallery-net-result err";
                    netResult.textContent = "测试失败: " + e;
                    showToast(gallery.app, 'error', 'C 站连通性', '连通性测试请求失败。');
                } finally {
                    testNetBtn.disabled = false;
                    testNetBtn.textContent = label;
                }
            }
        });
        const loraDirsList = $el("div", { className: "neo-gallery-lora-dirs", style: { display: "none" } });
        let loraDirsLoaded = false;
        const loadLoraDirs = async () => {
            loraDirsList.innerHTML = '';
            loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "Loading lora directories..." }));
            try {
                const resp = await api.fetchApi('/neo_gallery/lora_dirs');
                const data = await resp.json();
                const dirs = data.dirs || [];
                loraDirsList.innerHTML = '';
                if (!dirs.length) {
                    loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "No lora files found in models/loras." }));
                    return;
                }
                for (const d of dirs) {
                    const label = d.path === "" ? "(loras root)" : d.path;
                    const cb = $el("input", { type: "checkbox" });
                    cb.checked = loraSyncDirs.includes(d.path);
                    cb.onchange = async () => {
                        if (cb.checked) {
                            if (!loraSyncDirs.includes(d.path)) loraSyncDirs.push(d.path);
                        } else {
                            loraSyncDirs = loraSyncDirs.filter(p => p !== d.path);
                        }
                        try {
                            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", dirs: loraSyncDirs })
                            });
                            const result = await resp.json();
                            if (!resp.ok || !result.success) {
                                showToast(gallery.app, 'error', '保存失败', result.error || 'LORA 目录选择未保存');
                            } else {
                                pollLoraSync();
                            }
                        } catch (e) {
                            showToast(gallery.app, 'error', '保存失败', String(e));
                        }
                    };
                    loraDirsList.appendChild($el("label", { className: "neo-gallery-lora-dir-item" }, [cb, `${label} (${d.count})`]));
                }
            } catch (e) {
                loraDirsList.innerHTML = '';
                loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "Failed to load lora directories." }));
            }
        };
        const loraDirsToggle = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: "\uD83D\uDCC2 Select LORA Directories",
            onclick: () => {
                const hidden = loraDirsList.style.display === "none";
                loraDirsList.style.display = hidden ? "" : "none";
                if (hidden && !loraDirsLoaded) { loraDirsLoaded = true; loadLoraDirs(); }
            }
        });

        const loraProgress = $el("div", { className: "neo-gallery-lora-progress", textContent: "" });
        const retryBtn = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: "\uD83D\uDD04 Retry Failed",
            style: { display: "none" },
            onclick: async () => {
                try {
                    const resp = await api.fetchApi('/neo_gallery/lora_retry_failed', { method: 'POST' });
                    const result = await resp.json();
                    if (resp.ok && result.count > 0) {
                        showToast(gallery.app, 'success', 'Retry Queued', `Re-queued ${result.count} failed loras.`);
                        pollLoraSync();
                    }
                } catch (e) { }
            }
        });
        let loraPollTimer = null;
        const pollLoraSync = async () => {
            if (loraPollTimer) { clearInterval(loraPollTimer); loraPollTimer = null; }
            const tick = async () => {
                if (!document.querySelector('.neo-gallery-dir-modal')) {
                    clearInterval(loraPollTimer); loraPollTimer = null;
                    return;
                }
                try {
                    const resp = await api.fetchApi('/neo_gallery/lora_cache_status');
                    const st = await resp.json();
                    const failHint = st.failed ? ` \u00B7 ${st.failed} failed（可点「测试 C 站连通性」排查网络）` : '';
                    if (st.running) {
                        loraProgress.textContent = `Auto-caching ${st.done}/${st.total} \u00B7 ${st.current || ''}${st.failed ? ` \u00B7 failed ${st.failed}` : ''}`;
                        retryBtn.style.display = st.failed > 0 ? '' : 'none';
                    } else {
                        clearInterval(loraPollTimer); loraPollTimer = null;
                        retryBtn.style.display = st.failed > 0 ? '' : 'none';
                        if (st.error) {
                            loraProgress.textContent = st.error;
                        } else if (st.pending_count) {
                            let reason;
                            if (!st.master_enabled) reason = '总开关已关闭';
                            else if (!st.enabled) reason = '需配置 C 站 API KEY';
                            else reason = `fetches on access${failHint}`;
                            loraProgress.textContent = `${st.pending_count} lora(s) queued \u00B7 ${reason}`;
                        } else {
                            loraProgress.textContent = st.failed ? `${st.failed} failed（可点「测试 C 站连通性」排查网络）` : '';
                        }
                    }
                } catch (e) { }
            };
            loraPollTimer = setInterval(tick, 1500);
            tick();
        };

        const civitaiArea = $el("div", { className: "neo-gallery-civitai-area" }, [
            $el("div", { className: "neo-gallery-civitai-title", textContent: "Civitai（C 站同步）" }),
            $el("label", { className: "neo-gallery-civitai-toggle" }, [
                $el("input", {
                    type: "checkbox",
                    checked: civitaiEnabled,
                    onchange: async (e) => {
                        civitaiEnabled = !!e.target.checked;
                        try {
                            await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", enabled: civitaiEnabled })
                            });
                            showToast(gallery.app, 'success', civitaiEnabled ? '已启用' : '已停用', civitaiEnabled ? 'C 站 LORA 示例获取已开启。' : 'C 站 LORA 示例获取已关闭。');
                        } catch (err) {
                            showToast(gallery.app, 'error', 'Save Failed', 'Failed to save the Civitai LORA switch.');
                        }
                    }
                }),
                $el("span", { textContent: "启用 C 站 LORA（访问时自动获取示例图）" })
            ]),
            $el("label", { className: "neo-gallery-civitai-toggle" }, [
                $el("input", {
                    type: "checkbox",
                    checked: civitaiBookmarkEnabled,
                    onchange: async (e) => {
                        civitaiBookmarkEnabled = !!e.target.checked;
                        try {
                            await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", bookmark_enabled: civitaiBookmarkEnabled })
                            });
                            showToast(gallery.app, 'success', civitaiBookmarkEnabled ? '已启用' : '已停用',
                                civitaiBookmarkEnabled ? 'C 站收藏已开启。' : 'C 站收藏已关闭。');
                        } catch (err) {
                            showToast(gallery.app, 'error', 'Save Failed', 'Failed to save the C 站收藏 switch.');
                        }
                    }
                }),
                $el("span", { textContent: "启用 C 站收藏（默认开启）" })
            ]),
            $el("div", { className: "neo-gallery-civitai-key-row" }, [
                civitaiKeyInput,
                $el("button", {
                    className: "neo-gallery-dir-bulk-btn neo-gallery-civitai-save-btn",
                    textContent: "保存",
                    onclick: saveCivitaiKey,
                }),
            ]),
            $el("div", { className: "neo-gallery-civitai-key-row" }, [
                civitaiProxyInput,
                $el("button", {
                    className: "neo-gallery-dir-bulk-btn neo-gallery-civitai-save-btn",
                    textContent: "保存代理",
                    onclick: saveCivitaiProxy,
                }),
            ]),
            $el("div", { className: "neo-gallery-civitai-actions" }, [testNetBtn]),
            netResult,
            $el("div", { className: "neo-gallery-lora-progress", textContent: "Examples are cached automatically when the Lora section is accessed." }),
            loraDirsToggle,
            loraDirsList,
            retryBtn,
            loraProgress,
        ]);

        modal.appendChild(addArea);
        modal.appendChild(civitaiArea);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        setTimeout(() => {
            const input = document.getElementById('neo-gallery-new-dir-input');
            if (input) input.focus();
        }, 100);
    }
}
