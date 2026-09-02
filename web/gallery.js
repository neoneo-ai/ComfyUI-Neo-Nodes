import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { $el } from "../../../../scripts/ui.js";
import { GalleryComponents } from './gallery-components.js';
import { createRecipesPanel } from './recipes.js';
import {
    PAGE_SIZE,
    getReservedSpace,
    isImageFile,
    sortByMtime,
    showNoFilesMessage,
    showLoadingOverlay,
    showToast,
    showInlineFeedback
} from './gallery-utils.js';

// Load gallery CSS
const galleryCssLink = document.createElement('link');
galleryCssLink.rel = 'stylesheet';
galleryCssLink.href = "/extensions/ComfyUI-Neo-Nodes/gallery.css";
document.head.appendChild(galleryCssLink);

// Load recipes CSS
const recipesCssLink = document.createElement('link');
recipesCssLink.rel = 'stylesheet';
recipesCssLink.href = "/extensions/ComfyUI-Neo-Nodes/recipes.css";
document.head.appendChild(recipesCssLink);

// Civitai 收藏 view: bookmarked C-site models, shown like the Lora section.
const CIVITAI_DIR_NAME = "Civitai 收藏";
const CIVITAI_VIEW_SOURCE = "civitai_bookmarks";

/**
 * NeoGallery — preset-based gallery (no YAML).
 */
class NeoGallery {
    constructor(app) {
        this.app = app;
        this.maxThumbnailSize = 320;
        this.displayLabels = true;
        this.allDirectories = [];
        this.filteredDirectories = [];
        this.sortAscending = true;
        this._renderQueue = [];
        this._renderedCount = 0;
        this.isFocused = false;
        this.isVisible = false;
        
        // UI components
        this.components = new GalleryComponents(this);
        this.searchInput = this.components.createSearchInput(this);
        this.thumbnailSizeSlider = this.components.createThumbnailSizeSlider(this);
        this.customDirSettingBtn = null;
        
        // Card-based layout state
        this.currentView = {
            mode: 'categories',
            source: null,
            categoryPath: [],
        };
        this.workflowMatchActive = false;   // smart filter: show only loras used in the workflow
        this._loraRefreshTimer = null;       // auto-refresh polling for the Lora section
        this.placeholderImageUrl = `${window.location.protocol}//${window.location.host}/neo_gallery/placeholder.png`;
        this.sectionStates = {};
        this.isSearchActive = false;
        this.elementId = "neo-gallery-panel-root";
        
        // Store current directory images for lightbox navigation (used in lazy mode)
        this._currentDirImages = [];
        
        // 滚动位置状态
        this._scrollPositions = {};
        this._currentScrollKey = null;
        this._scrollContainer = null; // 缓存滚动容器
        
        // Lightbox 缩放和平移状态
        this._lightboxScale = 1;
        this._lightboxPanX = 0;
        this._lightboxPanY = 0;
        this._lightboxIsDragging = false;
        this._lightboxDragStartX = 0;
        this._lightboxDragStartY = 0;
        
        // Custom dir input
        this.customDirInput = $el("input", {
            type: "text",
            value: "",
            readonly: true,
            className: "neo-gallery-custom-dir-input-inline",
            style: { display: "none" }
        });

        const customDirBtn = this.components.createCustomDirSettingBtn(this);

        // Main content area
        this.accordion = $el("div", { className: "neo-gallery-accordion" });

        this.element = $el("div", { id: this.elementId, className: "neo-gallery-panel" }, [
            $el("div", { 
                className: "neo-gallery-header-row",
                style: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center' }
            }, [
                $el("h3", { 
                    className: "neo-gallery-header-title",
                    textContent: "Neo Gallery",
                    onclick: () => this.showCategoryCards(),
                    title: "Click to return to home"
                }),
                $el("div", { 
                    style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, gridColumn: '2' }
                }, [this.thumbnailSizeSlider]),
                $el("div", { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, [customDirBtn])
            ]),
            $el("div", { className: "neo-gallery-search-row" }, [
                $el("div", { className: "neo-gallery-search-container" }, [this.searchInput])
            ]),
            $el("div", { 
                id: "neo-gallery-breadcrumb",
                className: "neo-gallery-breadcrumb",
                style: { display: 'none' }
            }, [this.components.createBreadcrumbHome(this)]),
            this.accordion,
            this.customDirInput
        ]);

        this.loadGallerySettings();
    }

    // Static constants for settings
    static THUMBNAIL_SIZE_MIN = 150;
    static THUMBNAIL_SIZE_MAX = 500;
    static THUMBNAIL_SIZE_STEP = 25;
    static THUMBNAIL_SIZE_DEFAULT = 320;

    // ====== Directory Management ======

    async loadGallerySettings() {
        try {
            const resp = await api.fetchApi('/neo_gallery/get_settings');
            if (resp.ok) {
                const settings = await resp.json();
                const customDir = settings.custom_directory || "";
                this.customDirInput.value = customDir;
                
                if (this.customDirSettingBtn) {
                    if (customDir) {
                        const displayName = customDir.split(/[\\/]/).pop();
                        this.customDirSettingBtn.title = customDir + '\n(Click to change)\nCurrent: ' + displayName;
                        this.customDirSettingBtn.textContent = "\uD83D\uDCC1";
                    } else {
                        this.customDirSettingBtn.title = "Set custom directory\n(Currently not configured)";
                        this.customDirSettingBtn.textContent = "+";
                    }
                }
            }
        } catch (error) {
            console.error('Error loading gallery settings:', error);
            if (this.customDirSettingBtn) {
                this.customDirSettingBtn.title = "Failed to load settings";
                this.customDirSettingBtn.textContent = "?";
            }
        }
    }

    async promptAndSetCustomDir() {
        await this.components.buildDirModal(this);
    }

    closeDirModal() {
        const modal = document.querySelector('.neo-gallery-dir-modal-overlay');
        if (modal) modal.remove();
    }

    async removeCustomDir(dirPath) {
    if (!confirm(`Remove directory "${dirPath}" from gallery?`)) return;

    const saveResp = await api.fetchApi('/neo_gallery/save_settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: "remove", path: dirPath })
    });
    const result = await saveResp.json();

    if (saveResp.ok && result.success) {
    // Clear thumbnails for this directory
    try {
            await api.fetchApi('/neo_gallery/clear_thumbnails', {
            method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subfolder: dirPath })
                });
            } catch (e) {
                console.warn('[Neo Gallery] Failed to clear thumbnails:', e);
            }
            await this.loadGallery();
            await this.sortAndDisplayImages();
        } else {
            alert('Failed to remove directory: ' + (result.error || ''));
        }
    }

    // ====== State / Persistence ======

    async savePluginData(overrides) {
        const pluginData = {
            sectionStates: this.sectionStates,
            sortAscending: this.sortAscending,
            maxThumbnailSize: this.maxThumbnailSize,
            displayLabels: this.displayLabels,
            scrollPositions: this._scrollPositions,
            ...overrides
        };
        try {
            const resp = await api.fetchApi('/userdata/neo_gallery_data.json', {
                method: 'POST',
                body: JSON.stringify(pluginData),
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error saving plugin data:', error);
        }
    }

    async loadPluginData() {
        try {
            const response = await api.fetchApi('/userdata/neo_gallery_data.json');
            if (response.ok) {
                const data = await response.json();
                this.sectionStates = data.sectionStates || {};
                this.sortAscending = data.sortAscending !== undefined ? data.sortAscending : true;
                this.maxThumbnailSize = data.maxThumbnailSize || 300;
                this.displayLabels = data.displayLabels !== undefined ? data.displayLabels : true;
                this._scrollPositions = data.scrollPositions || {};
            }
        } catch (error) {
            console.error('Error loading plugin data:', error);
        }
    }

    // ====== Cover Image Cache ======

    // ====== Data Loading & Caching ======

    async loadGallery() {
        try {
            // Fetch directory structure with covers (covers loaded lazily per card via IntersectionObserver)
            const resp = await api.fetchApi('/neo_gallery/list?fields=dirs,covers');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            
            this.allDirectories = (data.directories || []).map(dir => ({
                name: dir.name,
                path: dir.path,
                subdirs: dir.subdirs || {},
                read_only: dir.read_only || false,
                root_count: dir.root_count || 0,
                items: dir.items || [],
                source: dir.source || "local",
                lora_path: dir.lora_path || null,
                pending: dir.pending || false,
                civitai: dir.civitai || null,
                model_name: dir.model_name || "",
                base_model: dir.base_model || "",
                has_pending: dir.has_pending || false
            }));
            this.filteredDirectories = this.allDirectories;

            // Use covers from list response (no separate request needed)
            // FIX: Merge with existing cache instead of replacing to preserve covers when navigating back
            if (data.covers && Object.keys(data.covers).length > 0) {
                this._dirCovers = { ...this._dirCovers, ...data.covers };
                console.log('[Neo Gallery] Merged cover images from list response:', Object.keys(this._dirCovers).length, 'directories');
            }
        } catch (error) {
            console.error('Error loading gallery:', error);
            this.allDirectories = [];
            this.filteredDirectories = this.allDirectories;
        }
    }

    // ====== Rendering ======

    async sortAndDisplayImages() {
        // Clear cached scroll container reference before clearing DOM
        this._scrollContainer = null;
        this.accordion.innerHTML = "";

        const dirsToDisplay = this.isSearchActive ? this.filteredDirectories : this.allDirectories;

        if (this.currentView.mode === 'civitai_bookmarks') {
            await this._renderCivitaiBookmarks();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        if (this.currentView.mode === 'directory' && this._currentDirStructure) {
            this.renderDirectoryStructure(this._currentDirStructure, this.currentView.source, this.currentView.categoryPath);
            // Restore scroll position after directory rendering
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        if (this.currentView.mode === 'images') {
            this.renderExpandedImages();
            // Restore scroll position after images rendering
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        // In lazy mode, count dirs with subdirs, root_count, or pending lora fetches
        const totalDirs = dirsToDisplay.filter(d => 
            (d.subdirs && Object.keys(d.subdirs).length > 0) || (d.root_count && d.root_count > 0) || d.pending
        ).length;

        // The "Civitai 收藏" home card is always present (like Lora), so a non-search
        // view never renders empty — only a search with no matches does.
        if (totalDirs === 0 && this.isSearchActive) {
            showNoFilesMessage(this.accordion, "No matching images found");
            return;
        }

        const cardContainer = await this.createCategoryCardGrid(dirsToDisplay);
        if (cardContainer) {
            this.accordion.appendChild(cardContainer);
        }

        // Setup IntersectionObserver for lazy-loading cover images on directory cards
        this._setupCoverLazyLoad();

        // Restore scroll position after rendering completes
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._restoreScrollPosition();
            });
        });
    }

    async createCategoryCardGrid(dirGroups) {
        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { gridTemplateColumns: `repeat(auto-fill, ${this.maxThumbnailSize}px)` }
        });

        // Collect workflow-used loras once for the smart filter (only lora dirs are filtered).
        const usedLoras = this.workflowMatchActive ? this.collectUsedLoras() : null;

        for (const dir of dirGroups) {
            // Show cards if there are subdirs, root_count, or a pending lora fetch
            const hasContent = (dir.subdirs && Object.keys(dir.subdirs).length > 0) ||
                               (dir.root_count && dir.root_count > 0) ||
                               dir.pending;
            if (!hasContent) continue;

            // Smart filter: hide lora dirs not used in the current workflow
            if (usedLoras && dir.path && String(dir.path).toLowerCase().startsWith('lora/') && dir.lora_path) {
                if (!usedLoras.has(dir.lora_path.replace(/\\/g, '/'))) continue;
            }

            // FIX: For presets, only show the card as a directory entry (no root items displayed directly)
            // This prevents mixing root-level files with subdirectory cards on the home page
            const isPresets = dir.name.toLowerCase() === 'presets';
            const displayItems = isPresets ? [] : (dir.items || []);

            const card = await this.components.createDirCard(this, dir.name, dir.path, displayItems, dir.subdirs, dir.read_only, dir.source, dir);
            container.appendChild(card);
        }

        // Civitai 收藏 entry — a home-page card like Lora that opens the bookmarked-models list.
        if (!this.isSearchActive) {
            container.appendChild(this._createCivitaiHomeCard());
        }

        return container;
    }

    // ====== Smart Workflow Matching (智能感知) ======

    /**
     * Collect the lora paths currently loaded by LoraLoader nodes on the canvas.
     * Returns a Set of normalized (posix, forward-slash) lora relative paths.
     */
    collectUsedLoras() {
        const used = new Set();
        if (!this.app || !this.app.graph || !this.app.graph._nodes) return used;
        for (const node of this.app.graph._nodes) {
            if (node.mode === 4) continue; // bypassed nodes don't contribute
            if (!/^LoraLoader/i.test(node.comfyClass || '') || !node.widgets) continue;
            for (const w of node.widgets) {
                if (w.name === 'lora_name' && w.type === 'combo' && typeof w.value === 'string' && w.value) {
                    used.add(w.value.replace(/\\/g, '/'));
                }
            }
        }
        return used;
    }

    toggleWorkflowMatch() {
        this.workflowMatchActive = !this.workflowMatchActive;
        this.sortAndDisplayImages();
    }

    /**
     * Jump straight to the directory of a lora used by the current workflow.
     * The target card is briefly highlighted after render, but the rest of the
     * directory stays fully visible (no persistent filter).
     */
    async _jumpToUsedLora() {
        const used = [...this.collectUsedLoras()];
        if (used.length === 0) return;
        used.sort();
        this._jumpTargetPath = used[0];
        const segs = used[0].replace(/\.(safetensors|pt|ckpt|bin|sft)$/i, "").split("/");
        await this.showDirectoryStructure("Lora", segs.slice(0, -1));
    }

    // ====== Lora Section Auto-Refresh ======

    _isLoraView() {
        return this.currentView.mode === 'directory' && (this.currentView.source || '').toLowerCase().startsWith('lora');
    }

    startLoraRefresh() {
        if (this._loraRefreshTimer) return;
        this._loraRefreshTimer = setInterval(async () => {
            try {
                const resp = await api.fetchApi('/neo_gallery/lora_cache_status');
                if (!resp.ok) return;
                const st = await resp.json();
                // Keep refreshing while the auto-cache worker is active or loras are
                // queued with a configured API key; without a key there is nothing to fetch.
                if (this._isLoraView() && st.enabled && (st.running || st.pending_count > 0)) {
                    const src = this.currentView.source;
                    const segs = this.currentView.categoryPath || [];
                    await this.showDirectoryStructure(src, segs);
                } else {
                    this.stopLoraRefresh();
                }
            } catch (e) { /* keep polling */ }
        }, 2000);
    }

    stopLoraRefresh() {
        if (this._loraRefreshTimer) {
            clearInterval(this._loraRefreshTimer);
            this._loraRefreshTimer = null;
        }
    }

    // ====== Civitai 收藏 (bookmarked C-site models, shown like the Lora section) ======

    _createCivitaiHomeCard() {
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-civitai-home",
            onclick: () => this.showCivitaiBookmarks()
        });
        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper",
            style: { minHeight: `${Math.max(this.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${Math.max(this.maxThumbnailSize, 80)}px` }
        });
        coverWrapper.appendChild($el("div", {
            className: "neo-gallery-card-cover neo-gallery-card-placeholder",
            textContent: "\uD83D\uDCDA"
        }));
        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: "Civitai 收藏（可保存为配方）"
        }, ["\uD83D\uDCC1"]);
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: CIVITAI_DIR_NAME });
        const info = $el("div", { className: "neo-gallery-card-info" }, [nameEl]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        return card;
    }

    async showCivitaiBookmarks() {
        await this._saveCurrentScrollPosition();
        this.currentView.mode = 'civitai_bookmarks';
        this.currentView.source = CIVITAI_DIR_NAME;
        this.currentView.categoryPath = [];
        this.stopLoraRefresh();
        this.components.updateBreadcrumb(this, [], '');

        const stateKey = `gallery_v2:${encodeURIComponent(CIVITAI_VIEW_SOURCE)}:`;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('gallery', stateKey);
        history.pushState({ galleryState: stateKey }, '', currentUrl.toString());

        await this._renderCivitaiBookmarks();
    }

    async _renderCivitaiBookmarks() {
        this.accordion.innerHTML = "";
        let data;
        try {
            const resp = await api.fetchApi('/rs_recipes/civitai_bookmarks', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
            });
            data = await resp.json();
        } catch (e) {
            console.error('[Neo Gallery] Failed to load Civitai bookmarks:', e);
            showNoFilesMessage(this.accordion, "加载收藏失败");
            return;
        }

        if (!data.success) {
            const msg = data.needs_api_key ? "需在「Manage Directories」配置 C 站 API KEY" : (data.error || "加载收藏失败");
            showNoFilesMessage(this.accordion, msg);
            return;
        }

        const items = data.items || [];
        if (items.length === 0) {
            showNoFilesMessage(this.accordion, "暂无收藏的 C 站模型");
            return;
        }

        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { gridTemplateColumns: `repeat(auto-fill, ${this.maxThumbnailSize}px)` }
        });
        for (const item of items) {
            container.appendChild(this._createCivitaiBookmarkCard(item));
        }
        this.accordion.appendChild(container);

        this._setupCivitaiCoverLazyLoad();
    }

    _createCivitaiBookmarkCard(item) {
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-civitai-card",
            onclick: (e) => this._openCivitaiBookmarkDir(item, e.currentTarget)
        });
        card.dataset.civitaiId = item.id;

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading",
            style: { minHeight: `${Math.max(this.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${Math.max(this.maxThumbnailSize, 80)}px` }
        });

        const typeLabel = [item.type, item.baseModel].filter(Boolean).join(" · ");
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: item.name || ("Civitai #" + item.id) });
        const info = $el("div", { className: "neo-gallery-card-info" }, [nameEl]);

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: typeLabel || "Civitai 模型"
        }, ["\uD83D\uDCC1"]);

        const saveBtn = $el("div", {
            className: "neo-gallery-card-civitai-save-btn",
            title: "保存为配方",
            onclick: (e) => { e.stopPropagation(); this._saveCivitaiBookmarkAsRecipe(item, saveBtn); }
        }, ["\uD83D\uDCBE"]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        card.appendChild(saveBtn);
        card._coverWrapper = coverWrapper;

        if (item.cover) {
            this._applyCivitaiCover(coverWrapper, item.cover);
        }
        return card;
    }

    async _openCivitaiBookmarkDir(item, card) {
        if (card && card.dataset.opening === "1") return;
        if (card) card.dataset.opening = "1";
        const progressEl = card ? $el("div", { className: "neo-gallery-civitai-progress", textContent: "正在连接 Civitai…" }) : null;
        if (progressEl) card.appendChild(progressEl);
        let pollTimer = null;
        const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
        if (progressEl) {
            pollTimer = setInterval(async () => {
                try {
                    const resp = await api.fetchApi('/rs_recipes/civitai_bookmark_status');
                    const st = await resp.json();
                    if (st.running) {
                        progressEl.textContent = `正在缓存示例图 ${st.done}/${st.total} · ${st.current || ''}`;
                    } else if (st.error) {
                        progressEl.textContent = st.error;
                    }
                } catch (_) { /* keep the initial hint */ }
            }, 1000);
        }
        try {
            const resp = await api.fetchApi('/rs_recipes/civitai_bookmark_media', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, name: item.name })
            });
            const data = await resp.json();
            if (!data.success) {
                showToast(this.app, 'error', '加载示例图失败', data.error || '');
                return;
            }
            if (!(data.images || []).length) {
                showToast(this.app, 'info', '无示例图', '该模型暂无可预览的示例图');
                return;
            }
            // Navigate into the model's cached example images as a standard directory,
            // exactly like the Lora section (grid + lightbox with send image / prompt).
            await this.showDirectoryStructure(CIVITAI_DIR_NAME, [data.model_key || String(item.id)]);
        } catch (e) {
            console.error('[Neo Gallery] Failed to open Civitai bookmark examples:', e);
            showToast(this.app, 'error', '打开失败', String(e));
        } finally {
            stopPolling();
            if (progressEl) progressEl.remove();
            if (card) delete card.dataset.opening;
        }
    }

    _applyCivitaiCover(coverWrapper, url) {
        coverWrapper.classList.remove('skeleton-loading');
        coverWrapper.classList.add('skeleton-loaded');
        coverWrapper.innerHTML = '';
        const img = $el("img", { src: url, alt: "", loading: "lazy" });
        img.onerror = () => this._setCivitaiCoverPlaceholder(coverWrapper);
        coverWrapper.appendChild(img);
    }

    _setCivitaiCoverPlaceholder(coverWrapper) {
        coverWrapper.classList.remove('skeleton-loading');
        coverWrapper.innerHTML = '';
        coverWrapper.appendChild($el("div", {
            className: "neo-gallery-card-cover neo-gallery-card-placeholder",
            textContent: "\uD83D\uDCDA"
        }));
    }

    _setupCivitaiCoverLazyLoad() {
        // Fetch covers for cards that didn't get one from the list response (like Lora lazy covers).
        const pending = Array.from(this.accordion.querySelectorAll('.neo-gallery-civitai-card[data-civitai-id]'))
            .filter(c => c._coverWrapper && c._coverWrapper.classList.contains('skeleton-loading'));
        if (pending.length === 0) return;

        const observer = new IntersectionObserver(async (entries, obs) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const card = entry.target;
                obs.unobserve(card);
                try {
                    const resp = await api.fetchApi('/rs_recipes/civitai_model_cover', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.dataset.civitaiId })
                    });
                    const data = await resp.json();
                    if (data.success && data.cover) {
                        this._applyCivitaiCover(card._coverWrapper, data.cover);
                    } else {
                        this._setCivitaiCoverPlaceholder(card._coverWrapper);
                    }
                } catch (e) {
                    this._setCivitaiCoverPlaceholder(card._coverWrapper);
                }
            }
        }, { rootMargin: '200px' });

        for (const card of pending) observer.observe(card);
    }

    async _saveCivitaiBookmarkAsRecipe(item, button) {
        if (button.dataset.saving === "1") return;
        const url = `https://civitai.com/models/${item.id}`;
        button.dataset.saving = "1";
        button.textContent = "\u23F3";
        try {
            const resolveResp = await api.fetchApi('/rs_recipes/civitai_resolve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
            });
            const resolved = await resolveResp.json();
            if (!resolved.success) {
                showInlineFeedback(button, resolved.error || "解析失败", "error");
                button.textContent = "\uD83D\uDCBE";
                return;
            }
            const saveResp = await api.fetchApi('/rs_recipes/save_from_civitai', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    name: resolved.name || item.name,
                    model_id: resolved.model_id,
                    prompt: resolved.prompt || "",
                    images: resolved.images || [],
                    loras: resolved.loras || []
                })
            });
            const saved = await saveResp.json();
            if (!saved.success) {
                showInlineFeedback(button, saved.error || "保存失败", "error");
                button.textContent = "\uD83D\uDCBE";
                return;
            }
            showInlineFeedback(button, "已保存为配方", "success");
            button.textContent = "\u2705";
        } catch (e) {
            console.error('[Neo Gallery] Failed to save Civitai recipe:', e);
            showInlineFeedback(button, String(e), "error");
            button.textContent = "\uD83D\uDCBE";
        } finally {
            button.dataset.saving = "";
        }
    }

    async showDirectoryStructure(source, pathSegments = []) {
        const dirName = source;
        const relPath = pathSegments.join("/");

        // The "Civitai 收藏" top level is a custom bookmark list, not a real directory.
        // With no path segments we show that list; with path segments we render the
        // selected model's cached example images as a standard directory (like Lora).
        if (dirName === CIVITAI_DIR_NAME && pathSegments.length === 0) {
            this.showCivitaiBookmarks();
            return;
        }

        // 修复：在进入新视图之前，先保存当前视图的滚动位置
        if (this.currentView.mode !== 'directory' || this.currentView.source !== dirName) {
            await this._saveCurrentScrollPosition();
        }
        
        try {
            // Use /neo_gallery/list with fields=dirs,items,covers to get directory structure, items, and covers
            const resp = await api.fetchApi(`/neo_gallery/list?fields=dirs,items,covers&dir_name=${encodeURIComponent(dirName)}&path=${encodeURIComponent(relPath)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            
            const data = await resp.json();
            let structure = data.directories[0] || {};
            
            // Update covers cache if provided (merge to preserve parent dir covers when navigating back)
            if (data.covers && Object.keys(data.covers).length > 0) {
                this._dirCovers = { ...this._dirCovers, ...data.covers };
                console.log('[Neo Gallery] Merged cover images from directory response:', Object.keys(this._dirCovers).length, 'directories');
            }
            
            this.currentView.mode = 'directory';
            this.currentView.source = dirName;
            this.currentView.categoryPath = pathSegments;
            this._currentDirStructure = structure;

            this.components.updateBreadcrumb(this, pathSegments, '');

            this.renderDirectoryStructure(structure, dirName, pathSegments);

            // Auto-refresh while browsing the Lora section so newly cached examples appear.
            if (String(dirName).toLowerCase().startsWith('lora')) {
                this.startLoraRefresh();
            } else {
                this.stopLoraRefresh();
            }
            
            // Push state to history for back button support (use query param to avoid conflict with workflow hash)
            const stateKey = `gallery_v2:${encodeURIComponent(dirName)}:${pathSegments.join('/')}`;
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('gallery', stateKey);
            history.pushState({ galleryState: stateKey }, '', currentUrl.toString());

        } catch (error) {
            console.error('[Gallery] Error loading directory structure:', error);
            showToast(this.app, 'error', 'Error', 'Failed to load directory structure');
        }
    }

    async _fetchLazyImages(structure, dirName, pathSegments) {
        // Fetch full image list using /neo_gallery/list with dir_name parameter
        const relPath = pathSegments.join("/");
        
        try {
            // Use /neo_gallery/list with dir_name to get specific directory data
            const listResp = await api.fetchApi(`/neo_gallery/list?fields=items&dir_name=${encodeURIComponent(dirName)}&path=${encodeURIComponent(relPath)}`);
            if (!listResp.ok) throw new Error(`HTTP ${listResp.status}`);
            
            const listData = await listResp.json();
            
            // Get the directory from response
            const matchedDir = listData.directories[0];
            
            if (matchedDir && matchedDir.items) {
                this.renderImagesFromStructure(matchedDir.items, dirName, pathSegments);
                return;
            }
            
            // Fallback: show no files message
            showNoFilesMessage(this.accordion, "No images found in this folder");
        } catch (error) {
            console.error('[Gallery] Error loading directory structure:', error);
            showToast(this.app, 'error', 'Error', 'Failed to load directory structure');
        }
    }

    async renderDirectoryStructure(structure, dirName, pathSegments) {
        this.accordion.innerHTML = "";
        
        // New structure: { subdirs: object, items: array, root_count: number }
        const { subdirs, items, root_count } = structure;
        
        // Convert items to images for compatibility
        const imageArray = items || [];
        // Convert subdirs object to array for compatibility (keep pending/lora metadata)
        const subdirArray = Object.keys(subdirs || {}).map(name => ({
            name,
            path: subdirs[name].path || name,
            image_count: subdirs[name].image_count || 0,
            pending: subdirs[name].pending || false,
            lora_path: subdirs[name].lora_path || null,
            model_name: subdirs[name].model_name || "",
            base_model: subdirs[name].base_model || "",
            civitai: subdirs[name].civitai || null
        }));

        // Include pending lora subdirs (queued/running/failed) even with no cached images yet.
        const nonEmptySubdirs = subdirArray.filter(s => s.image_count > 0 || s.pending);
        const hasSubdirs = nonEmptySubdirs.length > 0;
        
        if (hasSubdirs) {
            this.renderSubdirCards(structure, dirName, pathSegments, nonEmptySubdirs);
        } else if (imageArray.length > 0) {
            this.renderImagesFromStructure(imageArray, dirName, pathSegments);
        } else if (root_count && root_count > 0) {
            // Lazy-loaded: has images but no image data yet — fetch them now
            await this._fetchLazyImages(structure, dirName, pathSegments);
            return; // Don't show anything yet, _fetchLazyImages will render
        } else if (structure.pending) {
            const st = structure.civitai || {};
            let message, cls;
            if (st.needs_api_key) {
                message = "需要在「Manage Directories」中配置 C 站 API KEY 才能获取示例图。";
                cls = "pending-warn";
            } else if (st.status === 'not_found') {
                message = "This lora was not found on Civitai.";
                cls = "pending-failed";
            } else if (st.status === 'failed') {
                message = `抓取失败：${st.error || 'unknown error'}`;
                if (st.error && st.error.includes("无法连接")) {
                    message += " · 可在「Manage Directories」中点「测试 C 站连通性」排查（C 站需要代理或可直连的网络）";
                }
                cls = "pending-failed";
            } else {
                message = "Fetching examples from Civitai... this directory will refresh automatically.";
                cls = "";
            }
            this.accordion.appendChild($el("div", {
                className: "neo-gallery-pending-message" + (cls ? " " + cls : ""),
                textContent: message
            }));
        } else {
            showNoFilesMessage(this.accordion, "No images found in this folder");
        }
    }

    async renderSubdirCards(structure, dirName, pathSegments, filteredSubdirs = null) {
        // New structure: { subdirs: object, items: array, root_count: number }
        const { subdirs, items, root_count } = structure;
        const dir = this.allDirectories.find(d => d.name === dirName || d.path === dirName);

        // Use filtered subdirs if provided (non-empty only), otherwise use all
        const displaySubdirs = filteredSubdirs || Object.keys(subdirs || {});

        let subdirArray = Array.isArray(displaySubdirs)
            ? displaySubdirs
            : Object.keys(subdirs || {}).map(name => ({ name, path: subdirs[name].path || name, image_count: subdirs[name].image_count || 0 }));

        // Smart workflow filter for the Lora section: only active when the user
        // manually enables it. Jumping to a used lora highlights the card instead.
        const isLoraView = String(dirName).toLowerCase().startsWith('lora');
        const jumpTarget = this._jumpTargetPath || null;
        this._jumpTargetPath = null;
        if (isLoraView && this.workflowMatchActive) {
            const usedLoras = this.collectUsedLoras();
            if (usedLoras.size > 0) {
                const beforeFilter = subdirArray;
                subdirArray = subdirArray.filter(s => {
                    const loraPath = (s.lora_path || '').replace(/\\/g, '/');
                    return !loraPath || usedLoras.has(loraPath);
                });
                // The used lora may not have cached examples yet (not_found / pending),
                // so nothing matches here. Show the whole directory instead of an
                // empty page so the jump is never a dead end.
                if (subdirArray.length === 0) {
                    subdirArray = beforeFilter;
                }
            }
        }

        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { gridTemplateColumns: `repeat(auto-fill, ${this.maxThumbnailSize}px)` }
        });

        if (isLoraView) {
            const usedCount = this.collectUsedLoras().size;
            const filterBar = $el("div", { className: "neo-gallery-workflow-filter" }, [
                $el("span", { className: "neo-gallery-workflow-filter-label", textContent: "智能感知:" }),
                $el("button", {
                    className: "neo-gallery-workflow-chip" + (!this.workflowMatchActive ? " active" : ""),
                    onclick: () => { if (this.workflowMatchActive) this.toggleWorkflowMatch(); }
                }, ["全部"]),
                $el("button", {
                    className: "neo-gallery-workflow-chip" + (this.workflowMatchActive ? " active" : ""),
                    onclick: () => this._jumpToUsedLora()
                }, [`工作流已用 (${usedCount})`])
            ]);
            this.accordion.appendChild(filterBar);
        }

        for (const subdir of subdirArray) {
            const subdirName = typeof subdir === 'string' ? subdir : subdir.name;
            const fullPath = [...pathSegments, subdirName];
            
            const card = await this.components.createSubdirCard(this, subdirName, dirName, fullPath, subdir);
            if (jumpTarget) {
                const cardLora = ((subdir && subdir.lora_path) || '').replace(/\\/g, '/');
                if (cardLora === jumpTarget) {
                    card.classList.add('neo-gallery-card-jump-highlight');
                }
            }
            container.appendChild(card);
        }
        
        if (subdirArray.length > 0) {
            this.accordion.appendChild(container);
        }
        
        // Only show images section if we have actual image data (not lazy-loaded)
        if (items && items.length > 0) {
            
            const imageGrid = $el("div", { className: "neo-gallery-image-grid" });
            
            let currentSubfolder;
            if (pathSegments.length > 0) {
                currentSubfolder = dirName + "/" + pathSegments.join("/");
            } else {
                currentSubfolder = dirName;
            }
            
            // Use render queue for lazy loading
            this._renderQueue = [...sortByMtime(items)];
            this._renderedCount = 0;
            
            const renderPage = (count) => {
                for (let i = 0; i < count && this._renderQueue.length > 0; i++) {
                    const item = this._renderQueue.shift();
                    const itemSubfolder = item.subfolder || currentSubfolder;
                    const itemWithSubfolder = {...item, subfolder: itemSubfolder};
                    const imgEl = this.components.createImageElement(this, itemWithSubfolder, itemSubfolder, (dir && dir.source) || "");
                    imageGrid.appendChild(imgEl);
                }
                this._renderedCount += count;
            };
            
            // Render first page
            renderPage(PAGE_SIZE);
            this.accordion.appendChild(imageGrid);
            
            // Setup auto-load if there are more images
            if (this._renderQueue.length > 0) {
                console.log('[Neo Gallery] Setting up auto-load in renderSubdirCards, remaining:', this._renderQueue.length);
                this._setupAutoLoad(imageGrid, renderPage);
            }
            
            // Save images for lightbox navigation (lazy mode fallback)
            this._currentDirImages = [...sortByMtime(items)];
        }
    }

    renderImagesFromStructure(images, dirName, pathSegments) {
        let subfolder;
        if (pathSegments.length > 0) {
            subfolder = dirName + "/" + pathSegments.join("/");
        } else {
            subfolder = dirName;
        }
        const dir = this.allDirectories.find(d => d.name === dirName || d.path === dirName);

        if (images.length === 0) {
            showNoFilesMessage(this.accordion, "No images found in this folder");
            return;
        }

        const sortedItems = sortByMtime(images);
        this._renderQueue = [...sortedItems];
        this._renderedCount = 0;
        
        const imageGrid = $el("div", { className: "neo-gallery-image-grid neo-gallery-expanded-images" });
        
        const renderPage = (count) => {
            for (let i = 0; i < count && this._renderQueue.length > 0; i++) {
                const item = this._renderQueue.shift();
                // Use item's subfolder if available, otherwise use the current subfolder
                const itemSubfolder = item.subfolder || subfolder;
                // Add subfolder to item so it's available when sending
                const itemWithSubfolder = {...item, subfolder: itemSubfolder};
                const el = this.components.createImageElement(this, itemWithSubfolder, itemSubfolder, (dir && dir.source) || "");
                if (!isImageFile(item.filename)) {
                    el.style.width = `${this.maxThumbnailSize}px`;
                }
                imageGrid.appendChild(el);
            }
            this._renderedCount += count;
        };

        this.accordion.appendChild(imageGrid);
        renderPage(PAGE_SIZE);
        
        // Save images for lightbox navigation (lazy mode fallback)
        this._currentDirImages = [...sortedItems];
        
        // 滚动到底部自动加载
        if (this._renderQueue.length > 0) {
            this._setupAutoLoad(imageGrid, renderPage);
        }
    }

    showCategoryImages(source, pathSegments, displayName) {
        this.showDirectoryStructure(source, pathSegments || []);
    }

    async showCategoryCards() {
        // 保存当前滚动位置（在切换 mode 之前）
        const currentKey = this._getScrollKey();
        if (currentKey) {
            const scrollContainer = this._getScrollContainer();
            const scrollTop = scrollContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : scrollContainer.scrollTop;
            this._scrollPositions[currentKey] = scrollTop;
        }
        
        this.currentView.mode = 'categories';
        this.currentView.source = null;
        this.currentView.categoryPath = [];
        this.stopLoraRefresh();

        const breadcrumb = document.getElementById("neo-gallery-breadcrumb");
        if (breadcrumb) {
            breadcrumb.style.display = 'none';
        }

        // Remove gallery query param when going back to categories
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.delete('gallery');
        history.replaceState(null, '', currentUrl.toString());

        await this.sortAndDisplayImages();
    }

    renderExpandedImages() {
        const { source, categoryPath } = this.currentView;
        
        let items = [];
        let subfolder = source;

        const dir = this.allDirectories.find(d => d.name === source || d.path === source);
        // In lazy mode, dir.items is undefined - use _currentDirImages as fallback
        const dirItems = (dir && Array.isArray(dir.items)) ? dir.items : [];
        if (dir) {
            subfolder = source;
            if (categoryPath.length > 0) {
                const catKey = categoryPath[0];
                items = dirItems.filter(i => i.category === catKey || !i.category);
            } else {
                items = [...dirItems];
            }
        }

        // Fallback to _currentDirImages if dir.items is empty (lazy mode)
        if (items.length === 0 && this._currentDirImages && this._currentDirImages.length > 0) {
            items = [...this._currentDirImages];
        }

        if (items.length === 0) {
            showNoFilesMessage(this.accordion, "No images found in this category");
            return;
        }

        const sortedItems = sortByMtime(items);
        this._renderQueue = [...sortedItems];
        this._renderedCount = 0;
        
        const imageGrid = $el("div", { className: "neo-gallery-image-grid neo-gallery-expanded-images" });
        
        const renderPage = (count) => {
            for (let i = 0; i < count && this._renderQueue.length > 0; i++) {
                const item = this._renderQueue.shift();
                // Add subfolder to item so it's available when sending
                const itemWithSubfolder = {...item, subfolder: subfolder};
                const el = this.components.createImageElement(this, itemWithSubfolder, subfolder, dir.source || "");
                if (!isImageFile(item.filename)) {
                    el.style.width = `${this.maxThumbnailSize}px`;
                }
                imageGrid.appendChild(el);
            }
            this._renderedCount += count;
        };

        this.accordion.appendChild(imageGrid);
        renderPage(PAGE_SIZE);
        
        // Save images for lightbox navigation (lazy mode fallback)
        this._currentDirImages = [...sortedItems];
        
        // 滚动到底部自动加载
        if (this._renderQueue.length > 0) {
            this._setupAutoLoad(imageGrid, renderPage);
        }
    }

    _getScrollKey() {
        if (this.currentView.mode === 'directory' && this.currentView.source) {
            return `gallery_v2:${encodeURIComponent(this.currentView.source)}:${this.currentView.categoryPath.join('/')}`;
        }
        return 'gallery_categories';
    }

    _getScrollContainer() {
        if (this._scrollContainer) {
            return this._scrollContainer;
        }
        
        // 尝试多种可能的滚动容器选择器（按优先级排序）
        const selectors = [
            // ComfyUI sidebar-content-container: 实际的侧边栏滚动容器（最常见）
            '.sidebar-content-container',
            // Tailwind CSS: ComfyUI 主内容区滚动容器
            '.size-full.overflow-x-hidden.overflow-y-auto',
            // ComfyUI v1.3.x+ sidebar panel (flex layout)
            '[id="side-bar-panel"]',
            '.p-splitterpanel.side-bar-panel',
            // ComfyUI 侧边栏相关
            '#comfy-sidebar',
            '.comfy-sidebar',
            '.comfy-menu',
            '.sidebar',
            // 通用选择器
            '[role="complementary"]',
        ];
        
        for (const selector of selectors) {
            const container = document.querySelector(selector);
            if (container && (container.scrollHeight > container.clientHeight || container === document.body)) {
                this._scrollContainer = container;
                return container;
            }
        }
        
        // 回退：使用 window
        const parent = this.element?.parentElement;
        if (parent) {
            let current = parent;
            while (current && current !== document.body && current !== document.documentElement) {
                const style = window.getComputedStyle(current);
                
                if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
                    const canScroll = current.scrollHeight > current.clientHeight + 10;
                    
                    if (canScroll) {
                        this._scrollContainer = current;
                        return current;
                    } else {
                        if (!this._scrollContainer) {
                            this._scrollContainer = current;
                        }
                    }
                }
                current = current.parentElement;
            }
            
            if (this._scrollContainer) {
                return this._scrollContainer;
            }
        }
        
        return window;
    }

    async _saveScrollPositionAsync(key) {
        const scrollContainer = this._getScrollContainer();
        const scrollTop = scrollContainer === window 
            ? window.pageYOffset || document.documentElement.scrollTop 
            : scrollContainer.scrollTop;
        this._scrollPositions[key] = scrollTop;
        await this.savePluginData();
    }

    _saveScrollPosition() {
        const key = this._getScrollKey();
        if (key) {
            const scrollContainer = this._getScrollContainer();
            const scrollTop = scrollContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : scrollContainer.scrollTop;
            this._scrollPositions[key] = scrollTop;
            
            // 异步持久化，不阻塞渲染
            this.savePluginData({ scrollPositions: this._scrollPositions }).catch(err => {
                console.warn('[Neo Gallery] Failed to persist scroll position:', err);
            });
        }
    }

    /**
     * 保存当前视图的滚动位置（用于视图切换前）
     */
    async _saveCurrentScrollPosition() {
        const currentKey = this._getScrollKey();
        if (!currentKey) return;
        
        // 清除缓存的滚动容器引用，确保获取最新的
        this._scrollContainer = null;
        const scrollContainer = this._getScrollContainer();
        
        let scrollTop = 0;
        if (scrollContainer === window) {
            scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        } else {
            // Neo Gallery 内容在 .sidebar-content-container 内部滚动，使用容器的 scrollTop
            scrollTop = scrollContainer.scrollTop;
        }
        
        this._scrollPositions[currentKey] = scrollTop;
        
        // 立即持久化
        try {
            await this.savePluginData();
        } catch (err) {
            console.error('[Neo Gallery] [_saveCurrentScrollPosition] Failed to persist:', err);
        }
    }

    _restoreScrollPosition() {
        const key = this._getScrollKey();
        if (!key) return;
        
        // 修复：使用 'in' 检查 key 是否存在，而不是 !this._scrollPositions[key]（因为值可能是 0）
        if (!(key in this._scrollPositions)) {
            return;
        }
        
        const targetScrollTop = this._scrollPositions[key];
        
        // 使用多次 requestAnimationFrame + setTimeout 确保 DOM 完全渲染后再恢复滚动位置
        const restore = () => {
            const scrollContainer = this._getScrollContainer();
            
            if (scrollContainer === window) {
                window.scrollTo(0, targetScrollTop);
            } else {
                const windowScrollTop = window.pageYOffset || document.documentElement.scrollTop;
                if (scrollContainer.scrollTop === 0 && windowScrollTop > 0) {
                    window.scrollTo(0, targetScrollTop);
                } else if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
                    scrollContainer.scrollTop = Math.min(targetScrollTop, maxScroll);
                } else {
                    return false;
                }
            }
            return true;
        };
        
        // 延迟恢复以确保 DOM 完全渲染
        setTimeout(() => {
            const scrollContainer = this._getScrollContainer();
            if (scrollContainer === window) {
                window.scrollTo(0, targetScrollTop);
            } else if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
                scrollContainer.scrollTop = Math.min(targetScrollTop, maxScroll);
            } else {
                // 容器尚未就绪，稍后重试
                setTimeout(() => restore(), 300);
            }
        }, 100);
    }

    _setupAutoLoad(container, renderPage) {
        // 移除旧的监听器 - 使用闭包保存的旧容器引用
        if (this._autoLoadScrollHandler && this._currentScrollContainer) {
            const oldContainer = this._currentScrollContainer;
            if (oldContainer === window) {
                window.removeEventListener('scroll', this._autoLoadScrollHandler);
            } else {
                oldContainer.removeEventListener('scroll', this._autoLoadScrollHandler);
            }
        }
        
        const threshold = 300; // 距离底部多少像素时触发加载
        const scrollContainer = this._getScrollContainer();
        
        // 保存容器引用到闭包中，避免后续查找错误元素
        this._currentScrollContainer = scrollContainer;
        
        this._autoLoadScrollHandler = () => {
            const currentContainer = this._currentScrollContainer || this._getScrollContainer();
            const scrollTop = currentContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : currentContainer.scrollTop;
            const viewHeight = currentContainer === window 
                ? window.innerHeight 
                : currentContainer.clientHeight;
            const docHeight = currentContainer === window 
                ? document.documentElement.scrollHeight 
                : currentContainer.scrollHeight;
            
            // 当滚动到距离底部 threshold 像素时触发加载
            if (scrollTop + viewHeight >= docHeight - threshold) {
                if (this._renderQueue.length > 0) {
                    renderPage(PAGE_SIZE);
                    if (this._renderQueue.length > 0) {
                        this._setupAutoLoad(container, renderPage);
                    }
                }
            }
        };
        if (scrollContainer === window) {
            window.addEventListener('scroll', this._autoLoadScrollHandler);
        } else {
            scrollContainer.addEventListener('scroll', this._autoLoadScrollHandler);
        }
    }

    // ====== Actions ======

    async deleteItem(name, subfolder) {
        try {
            const response = await api.fetchApi('/neo_gallery/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: name, subfolder })
            });
            const result = await response.json();
            
            // Check success field (new format) or deleted field (legacy fallback)
            if (result.success || result.deleted) {
                showToast(this.app, 'success', 'Deleted', `Removed: ${name}`);
                
                // Remove from data source immediately
                // In lazy mode, use _currentDirImages as fallback since dir.items is undefined
                for (const dir of this.allDirectories) {
                    const items = Array.isArray(dir.items) ? dir.items : [];
                    if (items.length > 0) {
                        const before = items.length;
                        dir.items = items.filter(item => item.name !== name || item.subfolder !== subfolder);
                        if (before !== dir.items.length) break;
                    }
                }
                
                // Also remove from filtered directories (search results)
                for (const dir of this.filteredDirectories) {
                    const items = Array.isArray(dir.items) ? dir.items : [];
                    if (items.length > 0) {
                        const before = items.length;
                        dir.items = items.filter(item => item.name !== name || item.subfolder !== subfolder);
                        if (before !== dir.items.length) break;
                    }
                }
                
                // Also remove from _currentDirImages (lazy mode fallback)
                if (this._currentDirImages && this._currentDirImages.length > 0) {
                    const before = this._currentDirImages.length;
                    this._currentDirImages = this._currentDirImages.filter(item => item.name !== name || item.subfolder !== subfolder);
                    if (before !== this._currentDirImages.length) {
                        // Re-render current view to reflect deletion
                        await this.sortAndDisplayImages();
                    }
                }
                
                // Remove DOM element immediately for better UX
                let domRemoved = false;
                
                // Try matching by filename (with extension) and also try without extension
                const nameWithoutExt = name.replace(/\.(png|jpg|jpeg|gif|webp|bmp|tiff|mp4|webm|mov|avi|mkv|flv|wmv)$/i, '');
                
                // First try: match with full filename (image.filename in DOM) or without extension
                const thumbContainers = document.querySelectorAll('.neo-gallery-thumb-container');
                for (const container of thumbContainers) {
                    if ((container.dataset.filename === name || container.dataset.filename === nameWithoutExt) && 
                        container.dataset.subfolder === subfolder) {
                        container.remove();
                        domRemoved = true;
                        break;
                    }
                }
                
                // Second try: match by checking if filename starts with the deleted name (handles extension mismatch)
                if (!domRemoved) {
                    for (const container of thumbContainers) {
                        const containerName = container.dataset.filename || '';
                        const containerSubfolder = container.dataset.subfolder || '';
                        if ((containerName === name || containerName.startsWith(nameWithoutExt + '.')) && 
                            containerSubfolder === subfolder) {
                            container.remove();
                            domRemoved = true;
                            break;
                        }
                    }
                }
                
                // Also remove from presets directory cards that might reference this file
                if (!domRemoved) {
                    const cardThumbnails = document.querySelectorAll('.neo-gallery-card-cover-grid-item img');
                    for (const img of cardThumbnails) {
                        if (img.alt === name || (img.src && img.src.includes(encodeURIComponent(name)))) {
                            img.parentElement?.parentElement?.remove();
                            break;
                        }
                    }
                }
                
                // If no elements remain, show empty state
                const remaining = document.querySelectorAll('.neo-gallery-thumb-container');
                if (remaining.length === 0 && !this.isSearchActive) {
                    this.displayNoFilesMessage();
                }
            } else {
                const errorMsg = result.error || 'Unknown error';
                showToast(this.app, 'error', 'Delete Failed', errorMsg);
            }
        } catch (error) {
            console.error("Error deleting item:", error);
            showToast(this.app, 'error', 'Delete Failed', error.message || 'Network error');
        }
    }

    async handleSearch(searchTerm) {
        searchTerm = searchTerm.toLowerCase();
        this.isSearchActive = searchTerm.length > 0;
        
        // Use list?search_mode=1 to get lightweight searchable data (style + content only, no full txt parsing)
        const resp = await api.fetchApi('/neo_gallery/list?search_mode=1');
        if (!resp.ok) {
            console.error('[Gallery] Search failed: could not fetch search data');
            this.filteredDirectories = [];
            await this.sortAndDisplayImages();
            return;
        }
        
        const data = await resp.json();
        this.filteredDirectories = (data.directories || [])
            .map(dir => ({
                ...dir,
                items: (dir.items || []).filter(img =>
                    (img.name && img.name.toLowerCase().includes(searchTerm)) ||
                    (img.style && img.style.toLowerCase().includes(searchTerm)) ||
                    (img.content && img.content.toLowerCase().includes(searchTerm))
                )
            }))
            .filter(d => d.items.length > 0);
        
        this.currentView.mode = 'categories';
        this.currentView.source = null;
        this.currentView.categoryPath = [];
        
        await this.sortAndDisplayImages();
    }

    async updateThumbnailSize(newSize) {
        this.maxThumbnailSize = newSize;
        if (this.thumbnailSizeSlider) {
            const slider = this.thumbnailSizeSlider.querySelector("input[type='range']");
            if (slider) slider.value = newSize;
        }
        const grids = document.querySelectorAll('.neo-gallery-category-grid');
        for (const grid of grids) {
            if (grid.offsetParent !== null) {
                grid.style.gridTemplateColumns = `repeat(auto-fill, ${newSize}px)`;
            }
        }
        await this.sortAndDisplayImages();
    }

    async updateLabelDisplay(display) {
        this.displayLabels = display;
        await this.sortAndDisplayImages();
    }

    // ====== Prompt Handling ======

    cleanText(text) {
        if (!text) return "";
        text = text.replace(/^[,\s]+|[,\s]+$/g, '');
        text = text.replace(/\s*BREAK\s*(?:,\s*)?/gi, '. ');
        text = text.replace(/\.{2,}/g, '.').replace(/,\s*\./g, '.');
        text = text.replace(/([.,])(?=\S)/g, '$1 ').trim();
        return text;
    }

    getFirstSegment(text) {
        if (!text) return "";
        const segments = text.split(/[.\u3002\uFF01\uFF01\uff1b:\n]+/).filter(s => s.trim());
        if (segments.length === 0) return "";
        let first = segments[0].trim();
        const colonIdx = first.indexOf('\uff1a');
        if (colonIdx > 0) {
            first = first.substring(colonIdx + 1).trim();
        }
        return first.length > 50 ? first.substring(0, 50) + '...' : first;
    }

    parsePromptSections(txtContent) {
        if (!txtContent) return [];
        const rawSegments = txtContent.split(/[.\u3002\uff01\uff01\uff1b\n]+/).filter(s => s.trim());
        const sections = [];

        for (const rawSeg of rawSegments) {
            const trimmed = rawSeg.trim();
            if (!trimmed) continue;

            const fullColonMatch = trimmed.match(/^(.+?)[\uff1a](.*)$/s);
            if (fullColonMatch) {
                const beforeColon = fullColonMatch[1].trim();
                const afterColon = fullColonMatch[2].trim();
                const cjkMatch = beforeColon.match(/[\u4e00-\u9fa5]/g);
                const cjkCount = cjkMatch ? cjkMatch.length : 0;

                if (cjkCount > 0 && cjkCount <= 10 && beforeColon.length <= 30) {
                    sections.push({ label: beforeColon, value: afterColon });
                } else {
                    sections.push({ label: null, value: trimmed });
                }
                continue;
            }

            sections.push({ label: null, value: trimmed });
        }

        return sections;
    }

    combineTexts(existing, newText) {
        existing = this.cleanText(existing);
        newText = this.cleanText(newText);
        if (!existing) return newText;
        return existing.endsWith('.') ? existing + ' ' + newText : existing + ', ' + newText;
    }

    // ====== Utility ======

    debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    showToast(severity, summary, detail) {
        showToast(this.app, severity, summary, detail);
    }

    showInlineFeedback(button, message, type) {
        showInlineFeedback(button, message, type);
    }

    displayNoFilesMessage() {
        this.accordion.appendChild($el("div", {
            className: "neo-gallery-no-files-message"
        }, [
            $el("div", { className: "neo-gallery-no-files-message-icon", textContent: "\uD83D\uDCF7" }),
            $el("p", { className: "neo-gallery-no-files-message-text", textContent: "No presets found. Add images + .txt files to gallery/presets/ or click \u{1F4C1} to add custom directories." })
        ]));
    }

    // ====== Image Send ======

    async sendImageToNode(image, target, button) {
        const selectedValue = target === 'selected' ? 'selected' : target;
        let targetNode = null;
        let targetWidget = null;
        if (selectedValue === 'selected') {
            const selKeys = Object.keys(app.canvas.selected_nodes);
            if (selKeys.length > 0) {
                targetNode = app.canvas.selected_nodes[selKeys[0]];
                targetWidget = targetNode?.widgets?.find(w => /image|upload/.test((w.name||'').toLowerCase()));
            }
        } else {
            const [nodeId, , index] = selectedValue.split(':');
            targetNode = app.graph.getNodeById(parseInt(nodeId));
            targetWidget = targetNode?.widgets?.[parseInt(index)];
        }
        if (!targetNode || !targetWidget) {
            showToast(this.app, 'error', 'Send Failed', 'Could not find target node/widget.');
            return;
        }
        const widgetType = targetWidget.type || '';
        
        if (widgetType === 'combo') {
            try {
                const resp = await api.fetchApi('/neo_gallery/copy_to_input?filename=' + encodeURIComponent(image.filename) + (image.subfolder ? '&subfolder=' + encodeURIComponent(image.subfolder) : ''));
                if (resp.ok) {
                    const result = await resp.json();
                    if (result.success) {
                        targetWidget.value = result.skipped ? image.filename : result.filename;
                    } else {
                        showToast(this.app, 'error', 'Copy Failed', result.error || 'Failed to copy image to input directory');
                        return;
                    }
                } else {
                    showToast(this.app, 'error', 'Copy Failed', 'Failed to copy image');
                    return;
                }
            } catch (e) {
                console.error('[Gallery] Error copying image:', e);
                showToast(this.app, 'error', 'Copy Failed', 'Error copying image');
                return;
            }
        } else {
            const filePath = `${image.subfolder || ''}/${image.filename}`;
            if (widgetType === 'customtext' || widgetType === 'text') {
                targetWidget.value = filePath;
            } else {
                targetWidget.value = {
                    filename: image.filename,
                    subfolder: image.subfolder || '',
                    type: image.type || 'input'
                };
            }
        }
        if (widgetType === 'combo' && targetWidget.callback) {
            targetWidget.callback(targetWidget.value);
        } else if (targetNode.onWidgetChanged) {
            targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
        }
        app.graph.setDirtyCanvas(true, true);
        showInlineFeedback(button, '\u2705 Image Sent!', 'success');
        showToast(this.app, 'success', 'Image Sent!', `Sent to ${targetNode.title || 'Node'} - ${targetWidget.name}`);
    }

    // ====== Video Send ======

    async sendVideoToNode(image, target, button) {
        const selectedValue = target === 'selected' ? 'selected' : target;
        let targetNode = null;
        let targetWidget = null;
        if (selectedValue === 'selected') {
            const selKeys = Object.keys(app.canvas.selected_nodes);
            if (selKeys.length > 0) {
                targetNode = app.canvas.selected_nodes[selKeys[0]];
                targetWidget = targetNode?.widgets?.find(w => /video/.test((w.name||'').toLowerCase()));
            }
        } else {
            const [nodeId, , index] = selectedValue.split(':');
            targetNode = app.graph.getNodeById(parseInt(nodeId));
            targetWidget = targetNode?.widgets?.[parseInt(index)];
        }
        if (!targetNode || !targetWidget) {
            showToast(this.app, 'error', 'Send Failed', 'Could not find target node/widget.');
            return;
        }
        const widgetType = targetWidget.type || '';
        
        if (widgetType === 'combo') {
            try {
                const resp = await api.fetchApi('/neo_gallery/copy_to_input?filename=' + encodeURIComponent(image.filename) + (image.subfolder ? '&subfolder=' + encodeURIComponent(image.subfolder) : ''));
                if (resp.ok) {
                    const result = await resp.json();
                    if (result.success) {
                        targetWidget.value = result.skipped ? image.filename : result.filename;
                    } else {
                        showToast(this.app, 'error', 'Copy Failed', result.error || 'Failed to copy video to input directory');
                        return;
                    }
                } else {
                    showToast(this.app, 'error', 'Copy Failed', 'Failed to copy video');
                    return;
                }
            } catch (e) {
                console.error('[Gallery] Error copying video:', e);
                showToast(this.app, 'error', 'Copy Failed', 'Error copying video');
                return;
            }
        } else {
            const filePath = `${image.subfolder || ''}/${image.filename}`;
            if (widgetType === 'customtext' || widgetType === 'text') {
                targetWidget.value = filePath;
            } else {
                targetWidget.value = {
                    filename: image.filename,
                    subfolder: image.subfolder || '',
                    type: image.type || 'input'
                };
            }
        }
        if (widgetType === 'combo' && targetWidget.callback) {
            targetWidget.callback(targetWidget.value);
        } else if (targetNode.onWidgetChanged) {
            targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
        }
        app.graph.setDirtyCanvas(true, true);
        showInlineFeedback(button, '\u2705 Video Sent!', 'success');
        showToast(this.app, 'success', 'Video Sent!', `Sent to ${targetNode.title || 'Node'} - ${targetWidget.name}`);
    }

    // ====== Lightbox (delegated to components) ======

    injectAnimations() {}

    showLightbox(image, subfolder) {
        this.components.showLightbox(this, image, subfolder);
    }

    closeLightbox() {
        this.components.closeLightbox(this);
    }

    navigateLightboxImage(direction) {
        this.components.navigateLightboxImage(this, direction);
    }

    updateLightboxContent(lightbox, image, subfolder, allImages, currentIndex) {
        this.components.updateLightboxContent(lightbox, image, subfolder, allImages, currentIndex);
    }

    // ====== Breadcrumb (delegated to components) ======

    createBreadcrumbHome() {
        return this.components.createBreadcrumbHome(this);
    }

    updateBreadcrumb(pathSegments, sourceName) {
        this.components.updateBreadcrumb(this, pathSegments, sourceName);
    }

    _removeSiblingDropdown() {
        this.components._removeSiblingDropdown();
    }

    _toggleSiblingDropdown(event, rootDirName, pathSegments) {
        this.components._toggleSiblingDropdown(this, event, rootDirName, pathSegments);
    }

    // ====== Send Menus (delegated to components) ======

    _removeSendMenu() {
        this.components._removeSendMenu();
    }

    _removeImgSendMenu() {
        this.components._removeImgSendMenu();
    }

    _showImgSendMenu(image, button) {
        this.components._showImgSendMenu(this, image, button);
    }

    _showLoraSendMenu(loraPath, button) {
        this.components._showLoraSendMenu(this, loraPath, button);
    }

    _removeLoraSendMenu() {
        this.components._removeLoraSendMenu();
    }

    async sendLoraToNode(loraPath, target, button) {
        let targetNode = null;
        let targetWidget = null;
        if (target === 'selected') {
            const selKeys = Object.keys(app.canvas.selected_nodes);
            if (selKeys.length > 0) {
                targetNode = app.canvas.selected_nodes[selKeys[0]];
                targetWidget = targetNode?.widgets?.find(w => w.name === 'lora_name');
            }
        } else {
            const [nodeId, , index] = target.split(':');
            targetNode = app.graph.getNodeById(parseInt(nodeId));
            targetWidget = targetNode?.widgets?.[parseInt(index)];
        }
        if (!targetNode || !targetWidget) {
            showToast(this.app, 'error', 'Send Failed', 'Could not find target node/widget.');
            return;
        }
        // LoraLoader combo values use OS separators; lora_path from the gallery is posix.
        const normalized = loraPath.replace(/\//g, '\\');
        const options = targetWidget.options || (targetWidget.options_values || []);
        const matched = Array.isArray(options) ? options.find(o => (o || '').replace(/\\/g, '/') === loraPath.replace(/\\/g, '/')) : null;
        targetWidget.value = matched !== undefined && matched !== null ? matched : normalized;
        if (targetWidget.callback) {
            targetWidget.callback(targetWidget.value);
        } else if (targetNode.onWidgetChanged) {
            targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
        }
        app.graph.setDirtyCanvas(true, true);
        showInlineFeedback(button, '\u2705 Lora Sent!', 'success');
        showToast(this.app, 'success', 'Lora Sent!', `${targetWidget.value} \u2192 ${targetNode.title || 'Node'}`);
    }

    _showSendMenu(image, button) {
        this.components._showSendMenu(this, image, button);
    }

    _showVideoSendMenu(image, button) {
        this.components._showVideoSendMenu(this, image, button);
    }

    // ====== Main init ======

    async init() {
        await this.loadPluginData();
        
        // Restore gallery state from URL query param on page load
        const params = new URLSearchParams(window.location.search);
        const galleryParam = params.get('gallery');
        if (galleryParam) {
            let dirName, pathSegments;
            const v2Match = galleryParam.match(/^gallery_v2:(.+):(.*)$/);
            if (v2Match) {
                dirName = decodeURIComponent(v2Match[1]);
                const pathStr = v2Match[2];
                pathSegments = pathStr ? pathStr.split('/') : [];
            } else {
                const match = galleryParam.match(/^gallery_(.+?)_(.*)$/);
                if (match) {
                    dirName = match[1];
                    const pathStr = match[2];
                    pathSegments = pathStr ? pathStr.split('/') : [];
                }
            }
            if (dirName) {
                this.currentView.mode = 'directory';
                this.currentView.source = dirName;
                this.currentView.categoryPath = pathSegments;
                // Load gallery data first so breadcrumb can initialize properly
                await this.loadGallery();
                await this.showDirectoryStructure(dirName, pathSegments);
                return; // skip normal init
            }
        }

        // Intercept browser back button when gallery is visible
        window.addEventListener('popstate', (e) => {
            if (!this.isVisible) return;
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                const parentPath = this.currentView.categoryPath.slice(0, -1);
                this.showDirectoryStructure(this.currentView.source, parentPath);
            } else {
                this.showCategoryCards();
            }
        });

        // Intercept keyboard back navigation (Alt+Left, Backspace) - use capture to beat ComfyUI
        window.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            
            if ((e.altKey && e.key === 'ArrowLeft') || (e.ctrlKey && e.key === 'ArrowLeft')) {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                    const parentPath = this.currentView.categoryPath.slice(0, -1);
                    this.showDirectoryStructure(this.currentView.source, parentPath);
                } else {
                    this.showCategoryCards();
                }
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                    const parentPath = this.currentView.categoryPath.slice(0, -1);
                    this.showDirectoryStructure(this.currentView.source, parentPath);
                } else {
                    this.showCategoryCards();
                }
            }
        }, true);
    }

    async loadAndDisplay() {
        this.accordion.innerHTML = '';
        const loadingEl = showLoadingOverlay(this.accordion, this.maxThumbnailSize);
        
        // 直接加载（不额外增加延迟）
        await this.loadGallery();
        await this.sortAndDisplayImages();
        
        if (loadingEl.parentNode) loadingEl.remove();
    }

    /**
     * 启动滚动监听器，在每次滚动时自动保存当前位置
     */
    startScrollListener() {
        // 清除旧的监听器
        this.stopScrollListener();
        
        const onScroll = () => {
            if (!this.currentView || !this.currentView.mode) return;
            
            const key = this._getScrollKey();
            if (!key) return;
            
            const scrollContainer = this._getScrollContainer();
            let scrollTop = 0;
            if (scrollContainer === window) {
                scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            } else {
                scrollTop = scrollContainer.scrollTop;
            }
            
            // 只在位置变化超过 50px 时保存，避免频繁写入
            const prevValue = this._scrollPositions[key];
            if (prevValue === undefined || Math.abs(scrollTop - prevValue) > 50) {
                this._scrollPositions[key] = scrollTop;
            }
        };
        
        // 监听滚动容器的 scroll 事件
        const scrollContainer = this._getScrollContainer();
        if (scrollContainer === window) {
            window.addEventListener('scroll', onScroll, { passive: true });
            this._scrollListener = onScroll;
            this._scrollTarget = window;
        } else {
            scrollContainer.addEventListener('scroll', onScroll, { passive: true });
            this._scrollListener = onScroll;
            this._scrollTarget = scrollContainer;
        }
    }

    stopScrollListener() {
        if (this._scrollListener && this._scrollTarget) {
            this._scrollTarget.removeEventListener('scroll', this._scrollListener);
            this._scrollListener = null;
            this._scrollTarget = null;
        }
    }

    /**
     * Setup IntersectionObserver for lazy-loading cover images on directory cards.
     * Only loads covers when cards scroll into the viewport.
     */
    _setupCoverLazyLoad() {
        // Disconnect old observer if exists
        if (this._coverLazyObserver) {
            this._coverLazyObserver.disconnect();
        }

        const options = {
            root: null, // viewport
            rootMargin: '200px', // Start loading 200px before card enters viewport
            threshold: 0.1
        };

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const card = entry.target;
                    const dirName = card.dataset.lazyCovers;
                    
                    if (dirName && !card.dataset._lazyLoaded) {
                        // Mark as loaded to avoid duplicate requests
                        card.dataset._lazyLoaded = 'true';
                        
                        // Get the coverWrapper - skeleton is applied directly on it
                        const coverWrapper = card._coverWrapper || card.querySelector('.neo-gallery-card-cover-wrapper');
                        if (coverWrapper) {
                            // Remove skeleton shimmer by clearing inline styles and loading covers
                            this.components._applyCoverImages(card, coverWrapper, this, dirName, dirName);
                        }
                    }
                    
                    observer.unobserve(card);
                }
            }
        }, options);

        // Observe all directory cards with lazy data attribute
        const cards = document.querySelectorAll('.neo-gallery-category-card[data-lazy-covers]');
        for (const card of cards) {
            observer.observe(card);
        }

        this._coverLazyObserver = observer;
    }
}

// ====== Extension Registration =====
app.registerExtension({
    name: "comfy.neo.gallery",
    async setup() {
        const gallery = new NeoGallery(app);
        app.neoGallery = gallery;
        await gallery.init();

        app.ui.settings.addSetting({
            id: "Neo Gallery._General.maxThumbnailSize",
            name: "Neo Gallery Max Thumbnail Size",
            type: "slider", attrs: { min: 150, max: 500, step: 25 }, defaultValue: 320,
            onChange: (val) => { if (app.neoGallery) app.neoGallery.updateThumbnailSize(val); }
        });

        app.ui.settings.addSetting({
            id: "Neo Gallery._General.displayLabels",
            name: "Neo Gallery Display Image Labels",
            type: "boolean", defaultValue: true,
            onChange: (val) => { if (app.neoGallery) app.neoGallery.updateLabelDisplay(val); }
        });

        // Periodic persistence of scroll positions (every 5 seconds when gallery is visible)
        let _scrollPersistInterval = null;
        
        if (app.extensionManager && app.extensionManager.registerSidebarTab) {
                app.extensionManager.registerSidebarTab({
            id: "neo.gallery",
            icon: "pi pi-images",
            title: "素材",
            tooltip: "Neo Gallery",
            type: "custom",
            render: async (el) => {
                el.innerHTML = "";
                
                if (gallery.element.parentNode) {
                    gallery.element.parentNode.removeChild(gallery.element);
                }
                el.appendChild(gallery.element);
                
                if (!gallery._loaded) {
                    await gallery.loadAndDisplay();
                    gallery._loaded = true;
                } else {
                    gallery.accordion.innerHTML = "";
                    await gallery.sortAndDisplayImages();
                }
                // Re-initialize breadcrumb if URL has gallery param (panel was mounted after init)
                const params = new URLSearchParams(window.location.search);
                const galleryParam = params.get('gallery');
                if (galleryParam && gallery.currentView.mode === 'directory') {
                    gallery.components.updateBreadcrumb(gallery, gallery.currentView.categoryPath, '');
                }
                gallery.isVisible = true;
                
                // 启动滚动监听器，在每次滚动时自动保存位置
                gallery.startScrollListener();

            },
            });

            // 视频配方侧边栏
            app.extensionManager.registerSidebarTab({
                id: "neo.recipes",
                icon: "pi pi-box",
                title: "配方",
                tooltip: "Neo Recipes (视频配方)",
                type: "custom",
                render: async (el) => {
                    el.innerHTML = "";
                    const panel = await createRecipesPanel();
                    el.appendChild(panel);
                },
            });

        }
    },
});
