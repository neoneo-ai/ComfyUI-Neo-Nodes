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
        let civitaiKeySet = false;
        let civitaiKeyHint = "";
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
                civitaiEnabled = !!settings.civitai_lora_enabled;
                civitaiBookmarkEnabled = settings.civitai_bookmark_enabled !== false;
                if (Array.isArray(settings.lora_sync_dirs)) loraSyncDirs = [...settings.lora_sync_dirs];
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

        // Directory list area
        const dirListContainer = $el("div", { className: "neo-gallery-dir-list-container" });

        if (currentDirs.length === 0) {
            dirListContainer.appendChild($el("div", {
                className: "neo-gallery-dir-empty",
                textContent: "No directories configured yet."
            }));
        } else {
            const dirItems = $el("div", { className: "neo-gallery-dir-items" });

            for (const dirPath of currentDirs) {
                const item = $el("div", { className: "neo-gallery-dir-item" }, [
                    $el("span", {
                        className: "neo-gallery-dir-path",
                        textContent: dirPath,
                        title: dirPath
                    }),
                    $el("button", {
                        className: "neo-gallery-dir-remove-btn",
                        onclick: async (e) => {
                            e.stopPropagation();
                            await gallery.removeCustomDir(dirPath);
                            setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                        },
                        textContent: "\u2715"
                    })
                ]);
                dirItems.appendChild(item);
            }

            dirListContainer.appendChild(dirItems);
        }

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
                            setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                            try { await gallery.loadGallery(); gallery.list.sortAndDisplayImages(); } catch (e) { }
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


        // Bulk add area
        const bulkArea = $el("div", { className: "neo-gallery-dir-bulk-area" }, [
            $el("textarea", {
                id: "neo-gallery-bulk-dir-input",
                className: "neo-gallery-dir-textarea",
                placeholder: "Bulk add (one path per line):\n/path/to/dir1\n/path/to/dir2",
                rows: 3
            }),
            $el("button", {
                className: "neo-gallery-dir-bulk-btn",
                onclick: async () => {
                    const textarea = document.getElementById('neo-gallery-bulk-dir-input');
                    const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                    if (lines.length === 0) return;

                    let successCount = 0;
                    for (const dirPath of lines) {
                        try {
                            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "add", path: dirPath })
                            });
                            const result = await resp.json();
                            if (resp.ok && result.success) successCount++;
                        } catch (e) { }
                    }

                    if (successCount > 0) {
                        textarea.value = '';
                        setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                        try { await gallery.loadGallery(); gallery.list.sortAndDisplayImages(); } catch (e) { }
                    } else if (lines.length > 0) {
                        alert('All directories failed to add. Check paths and try again.');
                    }
                },
                textContent: "Add All"
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
            $el("div", { className: "neo-gallery-civitai-actions" }, [testNetBtn]),
            netResult,
            $el("div", { className: "neo-gallery-lora-progress", textContent: "Examples are cached automatically when the Lora section is accessed." }),
            loraDirsToggle,
            loraDirsList,
            retryBtn,
            loraProgress,
        ]);

        modal.appendChild(addArea);
        modal.appendChild(bulkArea);
        modal.appendChild(civitaiArea);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        setTimeout(() => {
            const input = document.getElementById('neo-gallery-new-dir-input');
            if (input) input.focus();
        }, 100);
    }
}
