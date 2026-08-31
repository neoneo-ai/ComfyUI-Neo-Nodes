/**
 * Gallery Components - UI building methods
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import {
    PAGE_SIZE,
    getReservedSpace,
    getImageHeight,
    getCardHeight,
    getCoverHeight,
    isImageFile,
    isVideoFile,
    getImageSrc,
    getVideoSrc,
    getThumbnailSrc,
    buildCoverGrid,
    createBreadcrumbItem,
    createBreadcrumbSeparator,
    createSpacer,
    sortByMtime,
    showNoFilesMessage,
    showLoadingOverlay,
    showToast,
    showInlineFeedback
} from './gallery-utils.js';

export class GalleryComponents {
    constructor(gallery) {
        this.gallery = gallery;
    }

    // ====== UI Builders ======

    createSearchInput(gallery) {
        const input = $el("input", {
            type: "text",
            placeholder: "Search prompt images...",
            className: "neo-gallery-search-input"
        });
        input.addEventListener("input", gallery.debounce(() => gallery.handleSearch(input.value), 300));
        return input;
    }

    createThumbnailSizeSlider(gallery) {
        const valueLabel = $el("span", {
            className: "thumbnail-size-value",
            textContent: `${gallery.maxThumbnailSize}px`
        });

        const slider = $el("input", {
            type: "range",
            min: gallery.constructor.THUMBNAIL_SIZE_MIN,
            max: gallery.constructor.THUMBNAIL_SIZE_MAX,
            step: gallery.constructor.THUMBNAIL_SIZE_STEP,
            value: gallery.maxThumbnailSize,
            className: "neo-gallery-thumbnail-slider",
            onchange: () => {
                const val = parseInt(slider.value);
                gallery.updateThumbnailSize(val);
                valueLabel.textContent = `${val}px`;
                gallery.savePluginData({ maxThumbnailSize: val });
            }
        });

        return $el("div", { className: "neo-gallery-slider-row" }, [
            $el("span", { className: "neo-gallery-size-label", textContent: "Size:" }),
            slider,
            valueLabel
        ]);
    }

    createCustomDirSettingBtn(gallery) {
        const btn = $el("button", {
            className: "neo-gallery-custom-dir-btn",
            title: "Set custom directory",
            onclick: async () => await gallery.promptAndSetCustomDir(),
            textContent: "+"
        });
        gallery.customDirSettingBtn = btn;
        return btn;
    }

    // ====== Directory Management Modal ======

    async buildDirModal(gallery) {
        // Remove existing modal and overlay if any
        const existingModal = document.querySelector('.neo-gallery-dir-modal');
        if (existingModal) existingModal.remove();
        const existingOverlay = document.querySelector('.neo-gallery-dir-modal-overlay');
        if (existingOverlay) existingOverlay.remove();

        let currentDirs = [];
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
                            try { await gallery.loadGallery(); gallery.sortAndDisplayImages(); } catch (e) { }
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

        // Quick add buttons
        const quickAddArea = $el("div", { className: "neo-gallery-dir-quick-add" }, [
            $el("span", { className: "neo-gallery-dir-quick-label", textContent: "Quick add:" }),
            $el("button", {
                className: "neo-gallery-dir-quick-btn neo-gallery-dir-quick-input",
                onclick: async () => {
                    try {
                        const resp = await api.fetchApi('/neo_gallery/resolve_path?path_type=input');
                        if (resp.ok) {
                            const result = await resp.json();
                            if (result.success && result.path) {
                                const saveResp = await api.fetchApi('/neo_gallery/save_settings', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: "add", path: result.path })
                                });
                                const saveResult = await saveResp.json();

                                if (saveResp.ok && saveResult.success) {
                                    setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                                    try { await gallery.loadGallery(); gallery.sortAndDisplayImages(); } catch (e) { }
                                } else {
                                    alert('Failed: ' + (result.error || 'Unknown error'));
                                }
                            } else {
                                alert(result.error || 'Could not resolve input directory');
                            }
                        } else {
                            alert('Failed to get ComfyUI input path');
                        }
                    } catch (e) {
                        console.error('[Gallery] Error resolving input path:', e);
                        alert('Error getting ComfyUI input path');
                    }
                },
                textContent: "\uD83D\uDCE5 Input"
            }),
            $el("button", {
                className: "neo-gallery-dir-quick-btn neo-gallery-dir-quick-output",
                onclick: async () => {
                    try {
                        const resp = await api.fetchApi('/neo_gallery/resolve_path?path_type=output');
                        if (resp.ok) {
                            const result = await resp.json();
                            if (result.success && result.path) {
                                const saveResp = await api.fetchApi('/neo_gallery/save_settings', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ action: "add", path: result.path })
                                });
                                const saveResult = await saveResp.json();

                                if (saveResp.ok && saveResult.success) {
                                    setTimeout(() => gallery.promptAndSetCustomDir(), 300);
                                    try { await gallery.loadGallery(); gallery.sortAndDisplayImages(); } catch (e) { }
                                } else {
                                    alert('Failed: ' + (saveResult.error || 'Unknown error'));
                                }
                            } else {
                                alert(result.error || 'Could not resolve output directory');
                            }
                        } else {
                            alert('Failed to get ComfyUI output path');
                        }
                    } catch (e) {
                        console.error('[Gallery] Error resolving output path:', e);
                        alert('Error getting ComfyUI output path');
                    }
                },
                textContent: "\uD83D\uDCE4 Output"
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
                        try { await gallery.loadGallery(); gallery.sortAndDisplayImages(); } catch (e) { }
                    } else if (lines.length > 0) {
                        alert('All directories failed to add. Check paths and try again.');
                    }
                },
                textContent: "Add All"
            })
        ]);

        modal.appendChild(titleBar);
        modal.appendChild(dirListContainer);
        modal.appendChild(addArea);
        modal.appendChild(quickAddArea);
        modal.appendChild(bulkArea);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        setTimeout(() => {
            const input = document.getElementById('neo-gallery-new-dir-input');
            if (input) input.focus();
        }, 100);
    }

    // ====== Send Menus ======

    _removeSendMenu() {
        const existing = document.getElementById('neo-gallery-send-menu');
        if (existing) existing.remove();
    }

    _removeImgSendMenu() {
        const existing = document.getElementById('neo-gallery-img-send-menu');
        if (existing) existing.remove();
    }

    async _showVideoSendMenu(gallery, image, button) {
        this._removeVideoSendMenu();
        if (!isVideoFile(image.filename)) {
            showToast(gallery.app, 'warning', 'Not a Video', 'This file is not a video.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                const isLoadVideo = /load.?video/i.test(node.comfyClass || '') || /load.?video/i.test(node.title || '');
                const isVideoWidget = /video/.test(wn);
                if (isLoadVideo && widget.type === 'combo' && /video/.test(wn)) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadVideo, isText: false });
                } else if ((isLoadVideo || isVideoWidget) && widget.inputEl) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: widget.type === 'customtext' || widget.type === 'text' });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const isLoadVideo = /load.?video/i.test(sn.comfyClass || '') || /load.?video/i.test(sn.title || '');
            const hasVideoWidget = sn.widgets && sn.widgets.some(w => /video/.test((w.name || '').toLowerCase()));
            if (isLoadVideo && hasVideoWidget) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoadVideo-type nodes found.');
            return;
        }

        menuItems.forEach(item => {
            item.isSelected = item.nodeId === selectedNodeId;
        });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isLoadImage !== b.isLoadImage) return a.isLoadImage ? -1 : 1;
            return 0;
        });

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendVideoToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-video-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeVideoSendMenu(); gallery.sendVideoToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeVideoSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    _removeVideoSendMenu() {
        const existing = document.getElementById('neo-gallery-video-send-menu');
        if (existing) existing.remove();
    }

    async _showImgSendMenu(gallery, image, button) {
        gallery._removeImgSendMenu();
        if (!/\.(png|jpg|jpeg|gif|webp|bmp|tiff|mp4|webm|mov|avi)$/i.test(image.filename)) {
            showToast(gallery.app, 'warning', 'Not an Image', 'This file is not an image.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                const isLoadImage = /load.?image/i.test(node.comfyClass || '') || /load.?image/i.test(node.title || '');
                const isImageWidget = /image|upload/.test(wn);
                if (isLoadImage && widget.type === 'combo' && /image/.test(wn)) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: false });
                } else if ((isLoadImage || isImageWidget) && widget.inputEl) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isLoadImage, isText: widget.type === 'customtext' || widget.type === 'text' });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const isLoadImage = /load.?image/i.test(sn.comfyClass || '') || /load.?image/i.test(sn.title || '');
            const hasImageWidget = sn.widgets && sn.widgets.some(w => /image|upload/.test((w.name || '').toLowerCase()));
            const hasTextWidget = sn.widgets && sn.widgets.some(w => ['string', 'text', 'customtext'].includes(w.type));
            if ((isLoadImage && hasImageWidget) || hasTextWidget) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoadImage-type nodes found.');
            return;
        }

        menuItems.forEach(item => {
            item.isSelected = item.nodeId === selectedNodeId;
        });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isLoadImage !== b.isLoadImage) return a.isLoadImage ? -1 : 1;
            return 0;
        });

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendImageToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-img-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); gallery._removeImgSendMenu(); gallery.sendImageToNode(image, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                gallery._removeImgSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    async _showSendMenu(gallery, image, button) {
        gallery._removeSendMenu();
        const menuItems = [];

        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            if (!node.widgets) return;
            node.widgets.forEach((widget, index) => {
                const wn = (widget.name || '').toLowerCase();
                if (/negative/.test(wn)) return;
                if (widget.inputEl && /string|text|custom/.test(widget.type || '')) {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}`, isNeoPrompt: /neo.?prompt/i.test(node.title) });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            if (sn && sn.widgets && sn.widgets.some(w => !/negative/.test((w.name || '').toLowerCase()) && w.inputEl && /string|text|custom/.test(w.type || ''))) {
                selectedNodeId = sn.id;
            }
        }

        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No valid text nodes found.');
            return;
        }

        menuItems.forEach(item => { item.isSelected = item.nodeId === selectedNodeId; });
        menuItems.sort((a, b) => {
            if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
            if (a.isNeoPrompt !== b.isNeoPrompt) return a.isNeoPrompt ? -1 : 1;
            return 0;
        });

        const hasSelection = selKeys.length > 0;
        if (!hasSelection && menuItems.length === 1) {
            this.sendToTarget(image.name, image.txt_content, button, menuItems[0].nodeId, menuItems[0].widgetIndex);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => {
                    e.stopPropagation();
                    gallery._removeSendMenu();
                    this.sendToTarget(image.name, image.txt_content, button, item.nodeId, item.widgetIndex);
                },
                textContent: label
            });
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '10001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                gallery._removeSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    // ====== Internal Helpers ======

    /**
     * Resolve target node and widget from a nodeId (used by copyToClipboard).
     */
    _resolveTargetFromNodeId(nodeId) {
        const targetNode = this.gallery.app.graph.getNodeById(parseInt(nodeId));
        if (!targetNode) return null;

        let isPromptNode = !!targetNode._rsPromptUIElements;
        let targetWidget = null;

        if (isPromptNode) {
            return { targetNode, isPromptNode: true, targetWidget: null };
        }

        // Find first valid text widget as fallback
        targetWidget = targetNode.widgets?.find(w => ['string', 'text', 'customtext'].includes(w.type));
        return { targetNode, isPromptNode: false, targetWidget };
    }

    /**
     * Send cleaned text to a resolved target (prompt node or regular widget).
     */
    _sendToResolvedTarget(textToCopy, targetNode, isPromptNode, targetWidget, feedbackBtn) {
        if (!targetNode) return;

        // Branch 1: Neo Prompt node with custom textarea
        if (isPromptNode && targetNode._rsPromptUIElements) {
            const { customTextarea, textWidget } = targetNode._rsPromptUIElements;
            if (customTextarea) {
                customTextarea.value = textToCopy;
                customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
            if (textWidget) {
                textWidget.value = textToCopy;
            }
            this.gallery.app.graph.setDirtyCanvas(true, true);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Sent!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Sent!', `Sent to ${targetNode.title || 'Node'}`);
        }
        // Branch 2: Regular widget on target node
        else if (targetWidget) {
            targetWidget.value = textToCopy;
            try {
                if (targetNode.onWidgetChanged) {
                    targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
                }
            } catch (e) {
                console.warn(`[Neo Gallery] onWidgetChanged threw: ${e.message}`);
            }
            this.gallery.app.graph.setDirtyCanvas(true, true);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Sent!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Sent!', `Sent to ${targetNode.title} - ${targetWidget.name}`);
        }
    }

    // ====== Public API ======

    /**
     * Send text to a specific node/widget by explicit nodeId and widgetIndex.
     * Falls back to clipboard copy if target resolution fails.
     */
    sendToTarget(imageName, txtContent, feedbackBtn = null, targetNodeId, targetWidgetIndex) {
        const textToCopy = this._cleanText(txtContent);

        // Resolve target node by explicit nodeId
        const resolved = this._resolveTargetFromNodeId(targetNodeId);
        if (!resolved || !resolved.targetNode) {
            console.error(`[Neo Gallery] sendToTarget: Failed to get node by id ${targetNodeId}, falling back to clipboard`);
            return this._fallbackToClipboard(textToCopy, feedbackBtn);
        }

        // For regular widgets, use the specific widget index
        let targetWidget = resolved.targetWidget;
        if (!resolved.isPromptNode && targetWidgetIndex != null) {
            targetWidget = resolved.targetNode.widgets?.[parseInt(targetWidgetIndex)];
            if (!targetWidget) {
                console.error(`[Neo Gallery] sendToTarget: targetWidget[${targetWidgetIndex}] is null/undefined, falling back to clipboard`);
                return this._fallbackToClipboard(textToCopy, feedbackBtn);
            }
        }

        this._sendToResolvedTarget(textToCopy, resolved.targetNode, resolved.isPromptNode, targetWidget, feedbackBtn);
    }

    /**
     * Copy text to system clipboard only.
     */
    copyToClipboard(imageName, txtContent, feedbackBtn = null) {
        const textToCopy = this._cleanText(txtContent);
        return this._fallbackToClipboard(textToCopy, feedbackBtn);
    }

    /**
     * Clean text content for copying.
     */
    _cleanText(txtContent) {
        return String(txtContent || "").trim();
    }

    /**
     * Fallback: write to system clipboard.
     */
    _fallbackToClipboard(textToCopy, feedbackBtn = null) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u2705 Copied!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Copied!', `Copied to clipboard`);
        }).catch((err) => {
            console.error('[Neo Gallery] Clipboard write failed:', err);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u274C Failed', 'error');
        });
    }

    async createDirCard(gallery, name, path, items, subdirs = {}, readOnly = false, source = "local") {
        const isRemote = source === "oss";
        const navTarget = isRemote ? path : name;
        const card = $el("div", {
            className: "neo-gallery-category-card" + (isRemote ? " neo-gallery-card-remote" : ""),
            onclick: () => gallery.showDirectoryStructure(navTarget, [])
        });

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading",
            style: { minHeight: `${Math.max(gallery.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${Math.max(gallery.maxThumbnailSize, 80)}px` }
        });

        // Mark card as lazy-load target with data attributes
        card.dataset.lazyCovers = name;
        card.dataset.lazyCoversPath = path;

        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: name });
        const info = $el("div", { className: "neo-gallery-card-info" }, [
            nameEl,
            $el("span", { className: "neo-gallery-card-count", textContent: `${(items || []).length} items` })
        ]);

        if (isRemote) {
            nameEl.parentElement.appendChild($el("span", {
                className: "neo-gallery-remote-badge",
                textContent: "\u2601"
            }));
        }

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge " + (isRemote ? "type-remote" : "type-directory"),
            title: isRemote ? "Remote (OSS)" : "Directory"
        }, [isRemote ? "\u2601\uFE0F" : "\uD83D\uDCC1"]);

        if (!readOnly) {
            const deleteBtn = $el("div", {
                className: "neo-gallery-card-delete-btn",
                title: `Remove directory "${name}"`,
                onclick: (e) => {
                    e.stopPropagation();
                    gallery.removeCustomDir(path);
                }
            }, ["\u00D7"]);
            card.appendChild(deleteBtn);
        }

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Store cover wrapper reference for lazy loading
        card._coverWrapper = coverWrapper;

        // Try to load cover images from cache immediately
        this._applyCoverImages(card, coverWrapper, gallery, name, name);

        return card;
    }

    /**
     * Apply cover images to a directory card from the global cache.
     */
    _applyCoverImages(card, coverWrapper, gallery, dirName, displayLabel, onCountUpdate) {
        // Use cached cover images from batch fetch
        // Case-insensitive lookup: backend uses lowercase keys (e.g. "presets")
        // but frontend passes the directory name as displayed (e.g. "Presets")
        // Also try the card's full path (e.g. "Cloud Presets/26-06-25") for OSS subdirs
        const coverPath = card.dataset && card.dataset.lazyCoversPath;
        const covers = (gallery._dirCovers && gallery._dirCovers[dirName]) ||
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === dirName.toLowerCase())?.[1]) ||
                       (gallery._dirCovers && coverPath && gallery._dirCovers[coverPath]) ||
                       (gallery._dirCovers && coverPath && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === coverPath.toLowerCase())?.[1]) ||
                       [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, dirName, displayLabel, gallery);
            if (onCountUpdate) onCountUpdate(covers.length);
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - keep skeleton loading for lazy loading
            // Don't remove skeleton-loading here, let IntersectionObserver handle it
            // Only show placeholder if skeleton is not active
            if (!coverWrapper.classList.contains('skeleton-loading')) {
                coverWrapper.innerHTML = '';
                coverWrapper.appendChild($el("div", {
                    className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                    textContent: "\uD83D\uDCCB"
                }));
            }
        }
    }

    /**
     * Render a cover grid from an array of image entries.
     */
    _renderCoverGrid(coverWrapper, images, dirName, displayLabel, gallery) {
        const displayImages = images.slice(0, 2);
        if (displayImages.length === 0) return;

        coverWrapper.innerHTML = '';
        const coverGrid = $el("div", { className: "neo-gallery-card-cover-grid" });

        let loadedCount = 0;

        displayImages.forEach((imgData) => {
            const imgSubfolder = imgData.subfolder || "";
            const imgItem = $el("div", { className: "neo-gallery-card-cover-grid-item" });

            const img = $el("img", {
                src: getThumbnailSrc(imgData, imgSubfolder),
                alt: displayLabel,
                loading: "lazy"
            });

            img.onload = () => {
                if (loadedCount === displayImages.length) {
                    const height = getCoverHeight(coverWrapper, gallery);
                    coverGrid.style.height = `${height * 2}px`;
                }
            };

            img.onerror = () => {
                imgItem.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:24px;">\uD83D\uDCCB</div>';
            };

            imgItem.appendChild(img);
            coverGrid.appendChild(imgItem);
        });

        coverWrapper.appendChild(coverGrid);
    }

    async createSubdirCard(gallery, subdirName, parentDir, fullPath) {
        const cardHeight = getCardHeight(gallery);

        const card = $el("div", {
            className: "neo-gallery-category-card",
            onclick: () => gallery.showDirectoryStructure(parentDir, fullPath),
            style: { width: `${gallery.maxThumbnailSize}px`, minHeight: `${cardHeight}px` }
        });

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: "Directory"
        }, ["\uD83D\uDCC1"]);

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading",
            style: { minHeight: `${Math.max(gallery.maxThumbnailSize * 0.5, 80)}px`, maxHeight: `${gallery.maxThumbnailSize}px` }
        });

        const info = $el("div", { className: "neo-gallery-card-info" }, [
            $el("span", { className: "neo-gallery-card-name", textContent: subdirName }),
            $el("span", { className: "neo-gallery-card-count", textContent: "Loading..." })
        ]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Try to apply cover images from cache first, then fallback to lazy fetch
        const subdirKey = `${parentDir}/${fullPath.join("/")}`;
        this._applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName);

        return card;
    }

    /**
     * Apply cover images to a subdirectory card from the global cache.
     */
    _applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName) {
        // Case-insensitive lookup for consistency
        const covers = (gallery._dirCovers && gallery._dirCovers[subdirKey]) || 
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === subdirKey.toLowerCase())?.[1]) || [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, subdirKey, subdirName, gallery);
            // Update card state from cache
            const countEl = card.querySelector('.neo-gallery-card-count');
            if (countEl) countEl.textContent = `${covers.length} items`;
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - show placeholder
            coverWrapper.innerHTML = '';
            coverWrapper.appendChild($el("div", {
                className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                textContent: "\uD83D\uDCCB"
            }));
            // Remove skeleton loading state even for placeholder
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        }
    }

    /**
     * Update subdir card cover with sample images.
     */
    _updateSubdirCardCover(card, coverWrapper, structure, subdirName, gallery) {
        let coverImages = [];

        // First priority: use sample_images from backend (recursively collected)
        if (structure.sample_images && structure.sample_images.length > 0) {
            coverImages = structure.sample_images.slice(0, 2);
        } else if (structure.images && structure.images.length > 0) {
            // Fallback: use direct images at this level
            coverImages = structure.images.slice(0, 2);
        }

        if (coverImages.length > 0) {
            coverWrapper.innerHTML = '';

            const coverGrid = $el("div", { className: "neo-gallery-card-cover-grid" });

            let loadedCount = 0;
            const displayImages = coverImages.slice(0, 2);

            displayImages.forEach((imgData) => {
                // Use the subfolder from the image data itself (set by backend)
                const imgSubfolder = imgData.subfolder || "";

                const imgItem = $el("div", { className: "neo-gallery-card-cover-grid-item" });

                const img = $el("img", {
                    src: getThumbnailSrc(imgData, imgSubfolder),
                    alt: subdirName,
                    loading: "lazy"
                });

                img.onload = () => {
                    loadedCount++;
                    if (loadedCount === displayImages.length) {
                        const height = getCoverHeight(coverWrapper, gallery);
                        coverGrid.style.height = `${height * 2}px`;
                    }
                };

                img.onerror = () => {
                    imgItem.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:24px;">\uD83D\uDCCB</div>';
                };

                imgItem.appendChild(img);
                coverGrid.appendChild(imgItem);
            });

            coverWrapper.appendChild(coverGrid);
        } else {
            // No images found at any level, show folder icon
            coverWrapper.innerHTML = '';
            coverWrapper.appendChild($el("div", {
                className: "neo-gallery-card-cover neo-gallery-card-placeholder",
                textContent: "\uD83D\uDCCB"
            }));
        }
    }

    // ====== Image Element ======

    createImageElement(gallery, image, subfolder, readOnly = false) {
        const isImageFileResult = isImageFile(image.filename);
        const isVideoFileResult = isVideoFile(image.filename);
        const reservedSpace = getReservedSpace(gallery.displayLabels);
        const imageHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);

        const container = $el("div", {
            className: "neo-gallery-thumb-container",
            style: {
                height: `${gallery.maxThumbnailSize}px`,
                width: `${gallery.maxThumbnailSize}px`
            },
            onclick: () => gallery.showLightbox(image, subfolder),
            dataset: { filename: image.filename, subfolder: subfolder }
        });

        let deleteBtn = null;
        const isPresets = subfolder.toLowerCase() === 'presets' || subfolder.toLowerCase().startsWith('presets/');
        if (!isPresets && !readOnly) {
            deleteBtn = $el("div", {
                className: "neo-gallery-delete-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    gallery.deleteItem(image.name, subfolder);
                }
            }, ["\u00D7"]);
        }

        let imgSendBtn = null;
        if (!isVideoFileResult) {
            imgSendBtn = $el("div", {
                className: "neo-gallery-thumb-img-send-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    gallery._showImgSendMenu(image, imgSendBtn);
                }
            }, ["\uD83D\uDCE4"]);
        }

        let sendBtn = null;
        if (image.txt_content) {
            sendBtn = $el("div", {
                className: "neo-gallery-thumb-send-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    gallery._showSendMenu(image, sendBtn);
                }
            }, ["\u2708\uFE0F"]);
        }

        let videoSendBtn = null;
        if (isVideoFileResult) {
            videoSendBtn = $el("div", {
                className: "neo-gallery-thumb-video-send-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    gallery._showVideoSendMenu(image, videoSendBtn);
                }
            }, ["\uD83D\uDCE5"]);
        }

        let copyBtn = null;
        if (image.txt_content) {
            copyBtn = $el("div", {
                className: "neo-gallery-thumb-copy-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    this.copyToClipboard(image.name, image.txt_content, copyBtn);
                }
            }, ["\u29C9"]);
        }

        let mediaEl;
        const thumbnailSrc = isVideoFileResult || isImageFileResult ? getThumbnailSrc(image, subfolder) : null;
        
        if (thumbnailSrc) {
            // Lazy loading: defer actual src until image scrolls into view
            mediaEl = $el("img", {
                className: "neo-gallery-thumb-img",
                src: gallery.placeholderImageUrl,
                alt: image.name,
                dataset: { thumbnailSrc },
                onerror: () => {
                    if (mediaEl) mediaEl.src = gallery.placeholderImageUrl;
                }
            });
            
            // Pre-load for aspect ratio calculation AND set real src
            const preloaderImg = new Image();
            preloaderImg.onload = () => {
                const aspectRatio = preloaderImg.height / preloaderImg.width;
                container.style.width = `${Math.max(gallery.maxThumbnailSize * (1 / aspectRatio), 40)}px`;
                // Set the real thumbnail src now that we have dimensions
                mediaEl.src = thumbnailSrc;
            };
            preloaderImg.src = thumbnailSrc;
        } else {
            // Unknown type - show placeholder
            mediaEl = $el("div", {
                className: "neo-gallery-thumb-img neo-gallery-thumb-placeholder",
                textContent: "\uD83D\uDCCB"
            });
        }

        const btnBar = $el("div", { className: "neo-gallery-thumb-btn-bar" }, [videoSendBtn, sendBtn, imgSendBtn, copyBtn].filter(Boolean));

        const imgWrapper = $el("div", { className: "neo-gallery-thumb-img-wrapper" }, [mediaEl, btnBar]);

        const labelEl = gallery.displayLabels ? $el("span", {
            className: "neo-gallery-image-label",
            textContent: image.name.replace(/\.\w+$/, '')
        }) : null;

        if (deleteBtn) container.appendChild(deleteBtn);
        container.appendChild(imgWrapper);
        if (labelEl) container.appendChild(labelEl);

        container.title = image.name.replace(/\.\w+$/, '');

        return container;
    }

    // ====== Breadcrumb Navigation ======

    createBreadcrumbHome(gallery) {
        return createBreadcrumbItem("\uD83C\uDFE0", () => gallery.showCategoryCards(), { isHome: true });
    }

    updateBreadcrumb(gallery, pathSegments, sourceName) {
        const breadcrumb = document.getElementById("neo-gallery-breadcrumb");
        if (!breadcrumb) return;

        gallery._removeSiblingDropdown();

        const rootDirName = gallery.currentView.source || '';

        if (pathSegments.length === 0 && !sourceName && !rootDirName) {
            breadcrumb.style.display = 'flex';
            breadcrumb.innerHTML = '';
            breadcrumb.appendChild(gallery.createBreadcrumbHome());
            return;
        }

        breadcrumb.style.display = 'flex';
        breadcrumb.innerHTML = '';

        breadcrumb.appendChild(gallery.createBreadcrumbHome());

        if (rootDirName) {
            breadcrumb.appendChild(createBreadcrumbSeparator());

            if (pathSegments.length > 0) {
                breadcrumb.appendChild(createBreadcrumbItem(rootDirName, () => gallery.showDirectoryStructure(rootDirName, [])));
            } else {
                breadcrumb.appendChild(createBreadcrumbItem(rootDirName, null, { isCurrent: true }));
            }

            for (let i = 0; i < pathSegments.length; i++) {
                breadcrumb.appendChild(createBreadcrumbSeparator());

                if (i === pathSegments.length - 1) {
                    const currentSegmentEl = createBreadcrumbItem(pathSegments[i], null, { isCurrent: true, title: "点击显示同级目录" });
                    currentSegmentEl.classList.add('neo-gallery-breadcrumb-sibling-trigger');
                    currentSegmentEl.onclick = (e) => {
                        e.stopPropagation();
                        gallery._toggleSiblingDropdown(e, rootDirName, pathSegments);
                    };
                    breadcrumb.appendChild(currentSegmentEl);
                } else {
                    breadcrumb.appendChild(createBreadcrumbItem(pathSegments[i], () => gallery.showDirectoryStructure(rootDirName, pathSegments.slice(0, i + 1))));
                }
            }

            if (pathSegments.length > 0) {
                breadcrumb.appendChild(createSpacer());
                breadcrumb.appendChild(createBreadcrumbItem("\u2B06", () => gallery.showDirectoryStructure(rootDirName, pathSegments.slice(0, -1)), { isUp: true, title: "上一级" }));
            } else {
                // Show back button for root directory of custom dir
                breadcrumb.appendChild(createSpacer());
                breadcrumb.appendChild(createBreadcrumbItem("\u2B06", () => gallery.showCategoryCards(), { isUp: true, title: "返回上级" }));
            }
        } else if (sourceName) {
            breadcrumb.appendChild(createBreadcrumbSeparator());
            breadcrumb.appendChild(createBreadcrumbItem(sourceName, null, { isCurrent: true }));

            if (pathSegments.length > 0 || sourceName) {
                breadcrumb.appendChild(createSpacer());
                breadcrumb.appendChild(createBreadcrumbItem("\u2B06", () => gallery.showCategoryCards(), { isUp: true, title: "返回上级" }));
            }
        }
    }

    // ====== Sibling Directory Dropdown ======

    _removeSiblingDropdown() {
        const existing = document.getElementById('neo-gallery-sibling-dropdown');
        if (existing) existing.remove();
    }

    async _toggleSiblingDropdown(gallery, event, rootDirName, pathSegments) {
        gallery._removeSiblingDropdown();

        const trigger = event.currentTarget;
        if (trigger.classList.contains('neo-gallery-breadcrumb-sibling-trigger')) {
            const existingDropdown = document.getElementById('neo-gallery-sibling-dropdown');
            if (existingDropdown) {
                existingDropdown.remove();
                return;
            }
        }

        const parentPath = pathSegments.slice(0, -1);

        let siblings = [];
        try {
            const resp = await api.fetchApi(`/neo_gallery/list?fields=dirs&dir_name=${encodeURIComponent(rootDirName)}&path=${encodeURIComponent(parentPath.join("/"))}`);
            if (resp.ok) {
                const data = await resp.json();
                const structure = data.directories[0] || {};
                // /neo_gallery/list returns subdirs as object {name: {image_count, path}}
                siblings = Object.keys(structure.subdirs || {}).map(name => ({ name, path: [...parentPath, name] }));
            }
        } catch (e) {
            console.error('[Gallery] Error fetching sibling directories:', e);
        }

        if (siblings.length === 0) return;

        const dropdown = $el("div", {
            id: "neo-gallery-sibling-dropdown",
            className: "neo-galleryibling-dropdown"
        });

        const rect = event.target.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
        dropdown.style.zIndex = '9999';

        const listContainer = $el("div", { className: "neo-gallery-sibling-list" });

        for (const sib of siblings) {
            const item = $el("div", {
                className: "neo-gallery-sibling-item",
                onclick: (e) => {
                    e.stopPropagation();
                    gallery._removeSiblingDropdown();
                    gallery.showDirectoryStructure(rootDirName, sib.path);
                },
                textContent: sib.name
            });

            item.onmouseenter = () => item.classList.add('neo-gallery-sibling-item-hover');
            item.onmouseleave = () => item.classList.remove('neo-gallery-sibling-item-hover');

            listContainer.appendChild(item);
        }

        dropdown.appendChild(listContainer);
        document.body.appendChild(dropdown);

        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== trigger) {
                gallery._removeSiblingDropdown();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    // ====== Lightbox ======

    injectAnimations() { }

    toggleFullscreen(gallery, lightbox) {
        const container = document.querySelector('#neo-gallery-lightbox-container');
        
        if (!document.fullscreenElement && container) {
            // Entering fullscreen: add fullscreen-mode class for CSS styling
            container.classList.add('fullscreen-mode');
            
            // Also enter native browser fullscreen on the lightbox element
            if (lightbox.requestFullscreen) {
                lightbox.requestFullscreen();
            } else if (lightbox.webkitRequestFullscreen) {
                lightbox.webkitRequestFullscreen();
            } else if (lightbox.msRequestFullscreen) {
                lightbox.msRequestFullscreen();
            }
        } else if (document.fullscreenElement && container) {
            // Exiting fullscreen: remove fullscreen-mode class
            container.classList.remove('fullscreen-mode');
            
            // Exit native browser fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
    }

    _applyLightboxTransform(gallery, mediaEl) {
        if (gallery._lightboxScale === 1) {
            mediaEl.style.transform = 'none';
            mediaEl.style.cursor = 'default';
        } else {
            mediaEl.style.transform = `scale(${gallery._lightboxScale}) translate(${gallery._lightboxPanX}px, ${gallery._lightboxPanY}px)`;
            mediaEl.style.cursor = gallery._lightboxIsDragging ? 'grabbing' : 'grab';
        }
    }

    showLightbox(gallery, image, subfolder) {
        gallery.injectAnimations();

        const existingLightbox = document.querySelector('.neo-gallery-lightbox');
        if (existingLightbox && gallery.currentLightboxImages && gallery.currentLightboxImages.length > 0) {
            const newIndex = gallery.currentLightboxImages.findIndex(img => img.filename === image.filename && img.subfolder === subfolder);
            if (newIndex >= 0) {
                gallery.updateLightboxContent(existingLightbox, image, subfolder, gallery.currentLightboxImages, newIndex);
                return;
            }
        }

        const existing = document.querySelector('.neo-gallery-lightbox');
        if (existing) existing.remove();

        // 使用原生 DOM API 创建 lightbox，确保 querySelector 能正常工作
        const lightbox = document.createElement('div');
        lightbox.id = "neo-gallery-lightbox";
        lightbox.className = "neo-gallery-lightbox";
        lightbox.onclick = (e) => {
            if (e.target === lightbox) {
                gallery.closeLightbox();
            }
        };

        const container = document.createElement('div');
        container.id = "neo-gallery-lightbox-container";
        container.className = "neo-gallery-lightbox-container";

        const imgWrapper = document.createElement('div');
        imgWrapper.id = "neo-gallery-lightbox-img-wrapper";
        imgWrapper.className = "neo-gallery-lightbox-img-wrapper";
        imgWrapper.style.userSelect = 'none';
        imgWrapper.style.webkitUserSelect = 'none';
        imgWrapper.style.mozUserSelect = 'none';
        imgWrapper.style.msUserSelect = 'none';
        imgWrapper.style.draggable = false;

        const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
        const isVideo = isVideoFile(image.filename);
        const mediaUrl = image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
        const videoUrl = `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;

        let mediaEl;
        if (isVideo) {
            mediaEl = document.createElement('video');
            mediaEl.className = "neo-gallery-lightbox-image neo-gallery-lightbox-video";
            mediaEl.src = videoUrl;
            mediaEl.controls = true;
            mediaEl.autoplay = true;
            mediaEl.loop = true;
            mediaEl.style.maxWidth = '100%';
            mediaEl.style.maxHeight = '80vh';
        } else {
            mediaEl = document.createElement('img');
            mediaEl.className = "neo-gallery-lightbox-image";
            mediaEl.src = mediaUrl;
            mediaEl.draggable = false;
            mediaEl.style.userSelect = 'none';
            mediaEl.style.webkitUserSelect = 'none';
            mediaEl.style.mozUserSelect = 'none';
            mediaEl.style.msUserSelect = 'none';
        }

        const closeBtn = document.createElement('div');
        closeBtn.className = "neo-gallery-lightbox-close-btn";
        closeBtn.textContent = "\u00D7";
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            gallery.closeLightbox();
        };

        let sendBtn = null;
        if (image.txt_content) {
            sendBtn = document.createElement('div');
            sendBtn.className = "neo-gallery-lightbox-btn neo-gallery-lightbox-send-btn";
            sendBtn.textContent = "\u2708\uFE0F Send";
            sendBtn.onclick = (e) => {
                e.stopPropagation();
                gallery._showSendMenu(image, sendBtn);
            };
        }

        let videoSendBtn = null;
        if (isVideo) {
            videoSendBtn = document.createElement('div');
            videoSendBtn.className = "neo-gallery-lightbox-btn neo-gallery-lightbox-video-send-btn";
            videoSendBtn.textContent = "\uD83D\uDCE5 Video";
            videoSendBtn.onclick = (e) => {
                e.stopPropagation();
                gallery._showVideoSendMenu(image, videoSendBtn);
            };
        }

        const copyBtn = document.createElement('div');
        copyBtn.className = "neo-gallery-lightbox-btn neo-gallery-lightbox-copy-btn";
        copyBtn.textContent = "\u29C9 Copy";
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            this.copyToClipboard(image.name, image.txt_content, copyBtn);
        };

        imgWrapper.appendChild(mediaEl);

        // 为图片添加缩放和平移事件监听器
        if (!isVideo) {
            // 滚轮缩放事件 - 动态获取当前图片元素
            const wheelHandler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newScale = Math.max(0.5, Math.min(5, gallery._lightboxScale + delta));
                
                gallery._lightboxScale = newScale;
                this._applyLightboxTransform(gallery, currentMediaEl);
            };
            
            // 拖拽平移事件 - 动态获取当前图片元素
            const mouseDownHandler = (e) => {
                if (gallery._lightboxScale <= 1) return;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                if (e.target !== currentMediaEl && e.target !== imgWrapper) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                gallery._lightboxIsDragging = true;
                gallery._lightboxDragStartX = e.clientX - gallery._lightboxPanX;
                gallery._lightboxDragStartY = e.clientY - gallery._lightboxPanY;
                
                currentMediaEl.style.cursor = 'grabbing';
            };
            
            const mouseMoveHandler = (e) => {
                if (!gallery._lightboxIsDragging) return;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                gallery._lightboxPanX = e.clientX - gallery._lightboxDragStartX;
                gallery._lightboxPanY = e.clientY - gallery._lightboxDragStartY;
                
                this._applyLightboxTransform(gallery, currentMediaEl);
            };
            
            const mouseUpHandler = () => {
                gallery._lightboxIsDragging = false;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (currentMediaEl) {
                    currentMediaEl.style.cursor = gallery._lightboxScale > 1 ? 'grab' : 'default';
                }
            };
            
            const mouseLeaveHandler = () => {
                gallery._lightboxIsDragging = false;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (currentMediaEl) {
                    currentMediaEl.style.cursor = gallery._lightboxScale > 1 ? 'grab' : 'default';
                }
            };
            
            imgWrapper.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
            imgWrapper.addEventListener('mousedown', mouseDownHandler, { capture: true });
            imgWrapper.addEventListener('mousemove', mouseMoveHandler, { capture: true });
            imgWrapper.addEventListener('mouseup', mouseUpHandler, { capture: true });
            imgWrapper.addEventListener('mouseleave', mouseLeaveHandler, { capture: true });
            
            // 保存处理器引用以便后续移除
            imgWrapper._lightboxWheelHandler = wheelHandler;
            imgWrapper._lightboxMouseDownHandler = mouseDownHandler;
            imgWrapper._lightboxMouseMoveHandler = mouseMoveHandler;
            imgWrapper._lightboxMouseUpHandler = mouseUpHandler;
            imgWrapper._lightboxMouseLeaveHandler = mouseLeaveHandler;
        }

        const imageInfo = document.createElement('div');
        imageInfo.className = 'neo-gallery-lightbox-image-info';
        if (!isVideo) {
            mediaEl.onload = () => {
                if (imageInfo) {
                    imageInfo.textContent = `${mediaEl.naturalWidth} \u00d7 ${mediaEl.naturalHeight}`;
                }
            };
        } else {
            mediaEl.onloadedmetadata = () => {
                if (imageInfo) {
                    imageInfo.textContent = `${mediaEl.videoWidth} \u00d7 ${mediaEl.videoHeight}`;
                }
            };
        }
        imgWrapper.appendChild(imageInfo);

        // Build all images list for navigation
        const allImages = [];
        const { source, categoryPath, mode } = gallery.currentView;

        // In lazy mode, dir.items may be empty - use saved _currentDirImages if available
        if (mode === 'categories') {
            for (const dir of gallery.allDirectories) {
                if (!gallery.isSearchActive || gallery.filteredDirectories.some(d => d.name === dir.name)) {
                    // Use saved images if dir.items is empty (lazy mode)
                    const items = (dir.items && dir.items.length > 0) ? dir.items : [];
                    for (const item of items) {
                        allImages.push({ ...item, subfolder: dir.name });
                    }
                }
            }
        } else if (source && mode !== 'categories') {
            const dir = gallery.allDirectories.find(d => d.name === source || d.path === source);
            if (dir) {
                // Directly use _currentDirImages when dir.items is undefined (lazy mode)
                let dirItems = [];
                if (dir.items && dir.items.length > 0) {
                    dirItems = [...dir.items];
                } else if (gallery._currentDirImages && gallery._currentDirImages.length > 0) {
                    dirItems = [...gallery._currentDirImages];
                }
                if (categoryPath && categoryPath.length > 0) {
                    const catKey = categoryPath[0];
                    dirItems = dirItems.filter(i => {
                        const match = i.category === catKey || !i.category;
                        return match;
                    });
                }
                for (const item of dirItems) {
                    allImages.push({ ...item, subfolder: item.subfolder || source });
                }
            }
        } else {
            for (const dir of gallery.allDirectories) {
                if (!gallery.isSearchActive || gallery.filteredDirectories.some(d => d.name === dir.name)) {
                    const items = (dir.items && dir.items.length > 0) ? dir.items : [];
                    for (const item of items) {
                        allImages.push({ ...item, subfolder: dir.name });
                    }
                }
            }
        }

        allImages.sort((a, b) => a.name.localeCompare(b.name));
        const currentIndex = allImages.findIndex(img => img.filename === image.filename && img.subfolder === subfolder);

        const prevBtn = $el("div", {
            id: "neo-gallery-lightbox-prev-btn",
            className: "neo-gallery-lightbox-nav-arrow",
            style: {
                cursor: currentIndex > 0 ? "pointer" : "not-allowed",
                opacity: currentIndex > 0 ? "0.8" : "0.3"
            },
            onclick: (e) => {
                if (currentIndex <= 0) return;
                e.stopPropagation();
                const prevItem = allImages[currentIndex - 1];
                gallery.updateLightboxContent(lightbox, prevItem, prevItem.subfolder, allImages, currentIndex - 1);
            }
        }, ["\u2039"]);
        imgWrapper.appendChild(prevBtn);

        const nextBtn = $el("div", {
            id: "neo-gallery-lightbox-next-btn",
            className: "neo-gallery-lightbox-nav-arrow",
            style: {
                cursor: currentIndex < allImages.length - 1 ? "pointer" : "not-allowed",
                opacity: currentIndex < allImages.length - 1 ? "0.8" : "0.3"
            },
            onclick: (e) => {
                if (currentIndex >= allImages.length - 1) return;
                e.stopPropagation();
                const nextItem = allImages[currentIndex + 1];
                gallery.updateLightboxContent(lightbox, nextItem, nextItem.subfolder, allImages, currentIndex + 1);
            }
        }, ["\u203A"]);
        imgWrapper.appendChild(nextBtn);

        // Fullscreen toggle button (bottom center of image)
        const fullscreenBtn = $el("div", {
            id: "neo-gallery-lightbox-fullscreen-btn",
            className: "neo-gallery-lightbox-nav-arrow neo-gallery-lightbox-fullscreen-btn",
            style: {
                cursor: "pointer",
                opacity: "0.8",
                fontSize: "14px"
            },
            title: "Toggle fullscreen (F)",
            onclick: (e) => {
                e.stopPropagation();
                this.toggleFullscreen(gallery, lightbox);
            }
        }, ["⛶"]);
        imgWrapper.appendChild(fullscreenBtn);

        let promptSection = null;
        if (image.txt_content) {
            promptSection = $el("div", {
                id: "neo-gallery-lightbox-prompt-section",
                className: "neo-gallery-lightbox-prompt-section"
            });

            const sections = this.gallery.parsePromptSections(image.txt_content);
            const promptContainer = $el("div", { className: "neo-gallery-lightbox-prompt-container" });

            if (sections.length > 0 && sections.some(s => s.label)) {
                for (const section of sections) {
                    if (section.label) {
                        const sectionEl = $el("div", { className: "neo-gallery-lightbox-prompt-section-item" }, [
                            $el("span", { className: "neo-gallery-lightbox-prompt-label", textContent: section.label + "\uff1a" }),
                            $el("span", { className: "neo-gallery-lightbox-prompt-value", textContent: section.value })
                        ]);
                        promptContainer.appendChild(sectionEl);
                    } else if (section.value) {
                        promptContainer.appendChild($el("div", {
                            textContent: section.value,
                            style: { marginBottom: "3px", whiteSpace: "pre-wrap" }
                        }));
                    }
                }
            } else {
                promptContainer.appendChild($el("div", {
                    textContent: gallery.cleanText(image.txt_content),
                    style: { whiteSpace: "pre-wrap" }
                }));
            }

            promptSection.appendChild(promptContainer);

            const promptBtnsContainer = $el("div", { className: "neo-gallery-lightbox-prompt-btns" });
            if (sendBtn) promptBtnsContainer.appendChild(sendBtn);
            if (videoSendBtn) promptBtnsContainer.appendChild(videoSendBtn);
            promptBtnsContainer.appendChild(copyBtn);
            promptSection.appendChild(promptBtnsContainer);
        } else {
            // 反推按钮：暂时隐藏（待修复图片消失问题后重新启用）
            const reverseBtn = $el("div", {
                id: "neo-gallery-lightbox-reverse-btn",
                className: "neo-gallery-lightbox-btn neo-gallery-lightbox-reverse-btn",
                style: { display: 'none' },
                onclick: async (e) => {
                    e.stopPropagation();
                    try {
                        reverseBtn.textContent = "\u231B 反推中...";
                        reverseBtn.style.pointerEvents = "none";
                        const resp = await api.fetchApi('/rs_prompts/reverse_prompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: image.filename, subfolder: subfolder })
                        });
                        if (resp.ok) {
                            const result = await resp.json();
                            if (result.status === "success") {
                                image.txt_content = result.prompt || "";
                                showToast(gallery.app, "success", "\u2705 \u53CD\u63A8\u6210\u529F", "");
                            } else {
                                showToast(gallery.app, "error", "\u274C \u53CD\u63A8\u5931\u8D25", result.error || "");
                                reverseBtn.textContent = "\uD83D\uDD0D 反推";
                                reverseBtn.style.pointerEvents = "auto";
                            }
                        } else {
                            const err = await resp.json().catch(() => ({}));
                            showToast(gallery.app, "error", "\u274C \u53CD\u63A8\u5931\u8D25", err.error || "");
                            reverseBtn.textContent = "\uD83D\uDD0D 反推";
                            reverseBtn.style.pointerEvents = "auto";
                        }
                    } catch (err) {
                        showToast(gallery.app, "error", "\u274C \u53CD\u63A8\u8BF7\u6C42\u5931\u8D25", err.message);
                        reverseBtn.textContent = "\uD83D\uDD0D 反推";
                        reverseBtn.style.pointerEvents = "auto";
                    }
                }
            }, ["\uD83D\uDD0D 反推"]);
            container.appendChild(reverseBtn);
        }

        // Add no-prompt class when there's no txt_content to remove border/background
        container.classList.toggle('no-prompt', !image.txt_content);

        container.appendChild(imgWrapper);
        if (promptSection) container.appendChild(promptSection);
        container.appendChild(closeBtn);
        lightbox.appendChild(container);
        document.body.appendChild(lightbox);

        gallery.currentLightbox = lightbox;
        gallery.currentLightboxImages = allImages;
        gallery.currentLightboxIndex = currentIndex;

        const handleKeyDown = (e) => {
            switch (e.key) {
                case 'ArrowLeft':
                    gallery.navigateLightboxImage(-1);
                    break;
                case 'ArrowRight':
                    gallery.navigateLightboxImage(1);
                    break;
                case 'Escape':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else {
                        gallery.closeLightbox();
                    }
                    break;
                case 'f':
                case 'F':
                    this.toggleFullscreen(gallery, lightbox);
                    break;
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        gallery.currentLightboxKeyboardHandler = handleKeyDown;

        // Listen for native fullscreen change to clean up class when exiting via Escape/ESC
        const onFullscreenChange = () => {
            if (!document.fullscreenElement) {
                const c = document.querySelector('#neo-gallery-lightbox-container');
                if (c) c.classList.remove('fullscreen-mode');
            }
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        gallery._fullscreenChangeListener = onFullscreenChange;
    }

    closeLightbox(gallery) {
        if (gallery.currentLightbox) {
            gallery.currentLightbox.remove();
            gallery.currentLightbox = null;
        }
        if (gallery.currentLightboxKeyboardHandler) {
            document.removeEventListener('keydown', gallery.currentLightboxKeyboardHandler);
            gallery.currentLightboxKeyboardHandler = null;
        }
        // 重置缩放和平移状态
        gallery._lightboxScale = 1;
        gallery._lightboxPanX = 0;
        gallery._lightboxPanY = 0;
        gallery._lightboxIsDragging = false;
    }

    navigateLightboxImage(gallery, direction) {
        if (!gallery.currentLightbox || !gallery.currentLightboxImages || gallery.currentLightboxImages.length === 0) return;

        const newIndex = gallery.currentLightboxIndex + direction;
        if (newIndex < 0 || newIndex >= gallery.currentLightboxImages.length) return;

        const nextItem = gallery.currentLightboxImages[newIndex];
        gallery.updateLightboxContent(gallery.currentLightbox, nextItem, nextItem.subfolder, gallery.currentLightboxImages, newIndex);
    }

    updateLightboxContent(lightbox, image, subfolder, allImages, currentIndex) {
        // 使用 document.querySelector 而不是在 wrapped element 上调用 querySelector
        const container = document.querySelector('#neo-gallery-lightbox-container');
        if (!container) {
            this.gallery.closeLightbox();
            setTimeout(() => this.gallery.showLightbox(image, subfolder), 100);
            return;
        }

        const imgWrapper = container.querySelector('#neo-gallery-lightbox-img-wrapper');
        if (!imgWrapper) {
            this.gallery.closeLightbox();
            setTimeout(() => this.gallery.showLightbox(image, subfolder), 100);
            return;
        }

        const isVideo = isVideoFile(image.filename);
        const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
        const newMediaUrl = image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
        const newVideoUrl = `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;

        const existingMedia = imgWrapper.querySelector('video, img');

        if (existingMedia) {
            // Stop any playing video and remove old media element first
            if (existingMedia.tagName === 'VIDEO') {
                existingMedia.pause();
                existingMedia.src = '';  // Clear src to release resources
            }
            existingMedia.remove();
        }

        // Remove any leftover spinner from previous image
        const oldSpinner = imgWrapper.querySelector('.neo-gallery-lightbox-spinner');
        if (oldSpinner) oldSpinner.remove();

        // Create new media element
        let newMediaEl;
        if (isVideo) {
            newMediaEl = document.createElement('video');
            newMediaEl.className = "neo-gallery-lightbox-image neo-gallery-lightbox-video";
            newMediaEl.src = newVideoUrl;
            newMediaEl.controls = true;
            newMediaEl.autoplay = true;
            newMediaEl.loop = true;
            newMediaEl.style.maxWidth = '100%';
            newMediaEl.style.maxHeight = '80vh';
        } else {
            newMediaEl = document.createElement('img');
            newMediaEl.className = "neo-gallery-lightbox-image loading";
            newMediaEl.draggable = false;
            newMediaEl.style.userSelect = 'none';
            newMediaEl.style.webkitUserSelect = 'none';
            newMediaEl.style.mozUserSelect = 'none';
            newMediaEl.style.msUserSelect = 'none';

            // Show spinner while loading
            const spinner = document.createElement('div');
            spinner.className = 'neo-gallery-lightbox-spinner';
            imgWrapper.appendChild(spinner);

            const onLoaded = () => {
                const sp = imgWrapper.querySelector('.neo-gallery-lightbox-spinner');
                if (sp) sp.remove();
                newMediaEl.classList.remove('loading');
            };

            // Use fetch + blob for reliable load detection
            imgWrapper.appendChild(newMediaEl);
            fetch(newMediaUrl).then(resp => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.blob();
            }).then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                newMediaEl.onload = () => { URL.revokeObjectURL(blobUrl); onLoaded(); };
                newMediaEl.onerror = onLoaded;
                newMediaEl.src = blobUrl;
            }).catch(() => {
                onLoaded();
            });
        }

        // Append new media element (video path)
        if (isVideo) {
            imgWrapper.appendChild(newMediaEl);
        }

        // Preload adjacent images for instant navigation
        if (allImages && !isVideo) {
            const preloadIndices = [currentIndex - 1, currentIndex + 1];
            for (const idx of preloadIndices) {
                if (idx >= 0 && idx < allImages.length) {
                    const adj = allImages[idx];
                    if (!isVideoFile(adj.filename)) {
                        const adjSubfolder = adj.subfolder || subfolder;
                        const adjCategoryParam = adj.category ? `&category=${encodeURIComponent(adj.category)}` : '';
                        const adjUrl = `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(adj.filename)}&subfolder=${encodeURIComponent(adjSubfolder)}${adjCategoryParam}`;
                        const preImg = new Image();
                        preImg.src = adjUrl;
                    }
                }
            }
        }
        
        // 在 imgWrapper 上添加事件监听器（而不是在图片上），确保事件能被捕获
        if (!isVideo) {
            // 移除旧的事件监听器
            const oldWheelHandler = imgWrapper._lightboxWheelHandler;
            const oldMouseDownHandler = imgWrapper._lightboxMouseDownHandler;
            const oldMouseMoveHandler = imgWrapper._lightboxMouseMoveHandler;
            const oldMouseUpHandler = imgWrapper._lightboxMouseUpHandler;
            const oldMouseLeaveHandler = imgWrapper._lightboxMouseLeaveHandler;
            
            if (oldWheelHandler) imgWrapper.removeEventListener('wheel', oldWheelHandler, { capture: true });
            if (oldMouseDownHandler) imgWrapper.removeEventListener('mousedown', oldMouseDownHandler, { capture: true });
            if (oldMouseMoveHandler) imgWrapper.removeEventListener('mousemove', oldMouseMoveHandler, { capture: true });
            if (oldMouseUpHandler) imgWrapper.removeEventListener('mouseup', oldMouseUpHandler, { capture: true });
            if (oldMouseLeaveHandler) imgWrapper.removeEventListener('mouseleave', oldMouseLeaveHandler, { capture: true });
            
            // 滚轮缩放事件 - 动态获取当前图片元素
            const wheelHandler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newScale = Math.max(0.5, Math.min(5, this.gallery._lightboxScale + delta));
                
                this.gallery._lightboxScale = newScale;
                this._applyLightboxTransform(this.gallery, currentMediaEl);
            };
            
            // 拖拽平移事件 - 动态获取当前图片元素
            const mouseDownHandler = (e) => {
                if (this.gallery._lightboxScale <= 1) return;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                if (e.target !== currentMediaEl && e.target !== imgWrapper) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                this.gallery._lightboxIsDragging = true;
                this.gallery._lightboxDragStartX = e.clientX - this.gallery._lightboxPanX;
                this.gallery._lightboxDragStartY = e.clientY - this.gallery._lightboxPanY;
                
                currentMediaEl.style.cursor = 'grabbing';
            };
            
            const mouseMoveHandler = (e) => {
                if (!this.gallery._lightboxIsDragging) return;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (!currentMediaEl) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                this.gallery._lightboxPanX = e.clientX - this.gallery._lightboxDragStartX;
                this.gallery._lightboxPanY = e.clientY - this.gallery._lightboxDragStartY;
                
                this._applyLightboxTransform(this.gallery, currentMediaEl);
            };
            
            const mouseUpHandler = () => {
                this.gallery._lightboxIsDragging = false;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (currentMediaEl) {
                    currentMediaEl.style.cursor = this.gallery._lightboxScale > 1 ? 'grab' : 'default';
                }
            };
            
            const mouseLeaveHandler = () => {
                this.gallery._lightboxIsDragging = false;
                const currentMediaEl = imgWrapper.querySelector('img');
                if (currentMediaEl) {
                    currentMediaEl.style.cursor = this.gallery._lightboxScale > 1 ? 'grab' : 'default';
                }
            };
            
            imgWrapper.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
            imgWrapper.addEventListener('mousedown', mouseDownHandler, { capture: true });
            imgWrapper.addEventListener('mousemove', mouseMoveHandler, { capture: true });
            imgWrapper.addEventListener('mouseup', mouseUpHandler, { capture: true });
            imgWrapper.addEventListener('mouseleave', mouseLeaveHandler, { capture: true });
            
            // 保存处理器引用以便后续移除
            imgWrapper._lightboxWheelHandler = wheelHandler;
            imgWrapper._lightboxMouseDownHandler = mouseDownHandler;
            imgWrapper._lightboxMouseMoveHandler = mouseMoveHandler;
            imgWrapper._lightboxMouseUpHandler = mouseUpHandler;
            imgWrapper._lightboxMouseLeaveHandler = mouseLeaveHandler;
            
            // 应用当前的缩放和平移状态
            if (this.gallery._lightboxScale !== 1) {
                this._applyLightboxTransform(this.gallery, newMediaEl);
            }
        }

        // Update image info
        const infoEl = container.querySelector('.neo-gallery-lightbox-image-info');
        if (infoEl) {
            if (isVideo) {
                newMediaEl.onloadedmetadata = () => {
                    infoEl.textContent = `${newMediaEl.videoWidth} \u00d7 ${newMediaEl.videoHeight}`;
                };
            } else {
                newMediaEl.onload = () => {
                    infoEl.textContent = `${newMediaEl.naturalWidth} \u00d7 ${newMediaEl.naturalHeight}`;
                };
            }
        }

        let promptSection = container.querySelector('#neo-gallery-lightbox-prompt-section');

        if (image.txt_content) {
            // 从"无提示词"变为"有提示词"时，移除旧的反推按钮
            const oldReverseBtn = container.querySelector('#neo-gallery-lightbox-reverse-btn');
            if (oldReverseBtn) oldReverseBtn.remove();

            // 如果 promptSection 已存在（从反推状态切换），先将其从 DOM 中移除再重建
            if (promptSection && promptSection.parentNode) {
                promptSection.remove();
            }

            // 创建新的 promptSection
            const sections = this.gallery.parsePromptSections(image.txt_content);
            promptSection = $el("div", {
                id: "neo-gallery-lightbox-prompt-section",
                className: "neo-gallery-lightbox-prompt-section"
            });

            const promptContainer = $el("div", { className: "neo-gallery-lightbox-prompt-container" });

            if (sections.length > 0 && sections.some(s => s.label)) {
                for (const section of sections) {
                    if (section.label) {
                        const sectionEl = $el("div", { className: "neo-gallery-lightbox-prompt-section-item" }, [
                            $el("span", { className: "neo-gallery-lightbox-prompt-label", textContent: section.label + "\uff1a" }),
                            $el("span", { className: "neo-gallery-lightbox-prompt-value", textContent: section.value })
                        ]);
                        promptContainer.appendChild(sectionEl);
                    } else if (section.value) {
                        promptContainer.appendChild($el("div", {
                            textContent: section.value,
                            style: { marginBottom: "3px", whiteSpace: "pre-wrap" }
                        }));
                    }
                }
            } else {
                promptContainer.appendChild($el("div", {
                    textContent: this.gallery.cleanText(image.txt_content),
                    style: { whiteSpace: "pre-wrap" }
                }));
            }

            promptSection.appendChild(promptContainer);

            // 始终创建按钮容器
            const sendBtn = image.txt_content ? $el("div", {
                className: "neo-gallery-lightbox-btn neo-gallery-lightbox-send-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    this.gallery._showSendMenu(image, sendBtn);
                }
            }, ["\u2708\uFE0F Send"]) : null;

            const copyBtn = $el("div", {
                className: "neo-gallery-lightbox-btn neo-gallery-lightbox-copy-btn",
                onclick: (e) => {
                    e.stopPropagation();
                    this.copyToClipboard(image.name, image.txt_content, copyBtn);
                }
            }, ["\u29C9 Copy"]);

            const promptBtnsContainer = $el("div", { className: "neo-gallery-lightbox-prompt-btns" });
            if (sendBtn) promptBtnsContainer.appendChild(sendBtn);
            if (isVideo) {
                const vSendBtn = $el("div", {
                    className: "neo-gallery-lightbox-btn neo-gallery-lightbox-video-send-btn",
                    onclick: (e) => {
                        e.stopPropagation();
                        this.gallery._showVideoSendMenu(this.gallery, image, vSendBtn);
                    }
                }, ["\uD83D\uDCE5 Video"]);
                promptBtnsContainer.appendChild(vSendBtn);
            }
            promptBtnsContainer.appendChild(copyBtn);
            promptSection.appendChild(promptBtnsContainer);

            // 将新的 promptSection 追加到 container（在 imgWrapper 之后，closeBtn 之前）
            const imgWrapper = container.querySelector('#neo-gallery-lightbox-img-wrapper');
            if (imgWrapper) {
                const closeBtn = container.querySelector('.neo-gallery-lightbox-close-btn');
                if (closeBtn && closeBtn !== imgWrapper.nextSibling) {
                    container.insertBefore(promptSection, closeBtn);
                } else {
                    container.appendChild(promptSection);
                }
            } else {
                container.appendChild(promptSection);
            }
        } else {
            // 反推按钮：暂时隐藏（待修复图片消失问题后重新启用）
            const reverseBtn = $el("div", {
                id: "neo-gallery-lightbox-reverse-btn",
                className: "neo-gallery-lightbox-btn neo-gallery-lightbox-reverse-btn",
                style: { display: 'none' },
                onclick: async (e) => {
                    e.stopPropagation();
                    try {
                        reverseBtn.textContent = "\u231B 反推中...";
                        reverseBtn.style.pointerEvents = "none";
                        const resp = await api.fetchApi('/rs_prompts/reverse_prompt', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: image.filename, subfolder: subfolder })
                        });
                        if (resp.ok) {
                            const result = await resp.json();
                            if (result.status === "success") {
                                image.txt_content = result.prompt || "";
                                showToast(this.gallery.app, "success", "\u2705 \u53CD\u63A8\u6210\u529F", "");
                            } else {
                                showToast(gallery.app, "error", "\u274C \u53CD\u63A8\u5931\u8D25", result.error || "");
                                reverseBtn.textContent = "\uD83D\uDD0D 反推";
                                reverseBtn.style.pointerEvents = "auto";
                            }
                        } else {
                            const err = await resp.json().catch(() => ({}));
                            showToast(this.gallery.app, "error", "\u274C \u53CD\u63A8\u5931\u8D25", err.error || "");
                            reverseBtn.textContent = "\uD83D\uDD0D 反推";
                            reverseBtn.style.pointerEvents = "auto";
                        }
                    } catch (err) {
                        showToast(this.gallery.app, "error", "\u274C \u53CD\u63A8\u8BF7\u6C42\u5931\u8D25", err.message);
                        reverseBtn.textContent = "\uD83D\uDD0D 反推";
                        reverseBtn.style.pointerEvents = "auto";
                    }
                }
            }, ["\uD83D\uDD0D 反推"]);
            container.appendChild(reverseBtn);
        }

        const prevBtn = imgWrapper.querySelector('#neo-gallery-lightbox-prev-btn');
        const nextBtn = imgWrapper.querySelector('#neo-gallery-lightbox-next-btn');

        if (prevBtn) {
            prevBtn.style.opacity = currentIndex > 0 ? "0.8" : "0.3";
            prevBtn.style.cursor = currentIndex > 0 ? "pointer" : "not-allowed";
            if (currentIndex > 0) {
                prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    const prevItem = allImages[currentIndex - 1];
                    this.gallery.updateLightboxContent(lightbox, prevItem, prevItem.subfolder, allImages, currentIndex - 1);
                };
            } else {
                prevBtn.onclick = null;
            }
        }
        if (nextBtn) {
            nextBtn.style.opacity = currentIndex < allImages.length - 1 ? "0.8" : "0.3";
            nextBtn.style.cursor = currentIndex < allImages.length - 1 ? "pointer" : "not-allowed";
            if (currentIndex < allImages.length - 1) {
                nextBtn.onclick = (e) => {
                    e.stopPropagation();
                    const nextItem = allImages[currentIndex + 1];
                    this.gallery.updateLightboxContent(lightbox, nextItem, nextItem.subfolder, allImages, currentIndex + 1);
                };
            } else {
                nextBtn.onclick = null;
            }
        }

        // Toggle no-prompt class for border/background removal
        container.classList.toggle('no-prompt', !image.txt_content);

        this.gallery.currentLightboxIndex = currentIndex;
    }
}
