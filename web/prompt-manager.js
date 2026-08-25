/**
 * prompt-manager.js
 * 提示词管理模块 - UI 组件创建 + 保存、列表、加载、删除
 */

import { app } from "../../scripts/app.js";

// Remember last opened settings tab
let _lastSettingsTab = "llm"; // "llm" or "templates"

import {
    savePrompt,
    loadPrompt,
    listPrompts,
    deletePrompt,
    extractTitle,
    extractClassify,
    randomPrompt as randomPromptAPI,
    downloadModel,
    clearModelStatusCache,
    monitorDownloadProgress,
    getAvailableModels,
    setCurrentModel,
    checkModel,
    checkAllModels,
    // Template management
    listTemplates,
    loadTemplate,
    saveTemplate,
    deleteTemplate,
    // Skills
    listSkills,
    fileToBase64,
    imagesFromClipboard
} from "./prompt-service.js";

// ==========================================
// DOM 元素工厂
// ==========================================

function mkEl(tag, className, styles = '') {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (styles) {
        el.style.cssText = styles;
    }
    return el;
}

// ==========================================
// UI 组件创建 (内部使用)
// ==========================================

function createOverlayWithSearch() {
    const overlay = mkEl("div", "rs-preset-list-overlay");
    // Search input at top of the panel
    const searchBar = mkEl("input", "rs-preset-search-input");
    searchBar.type = "text";
    searchBar.placeholder = "🔍 Search presets...";
    const body = mkEl("div", "rs-preset-list-body");
    overlay.appendChild(searchBar);
    overlay.appendChild(body);
    return { overlay, body, searchBar };
}

function createInputModal() {
    const modal = mkEl("div", "rs-preset-name-input");
    const aiStatus = mkEl("div", "rs-ai-status processing");
    aiStatus.innerHTML = "⏳ AI 正在分析提示词...";

    const label = mkEl("div", "rs-input-label");
    label.textContent = "Prompt name:";

    const inputWrapper = mkEl("div", "rs-input-wrapper");
    const field = mkEl("input", "rs-input-field");
    field.placeholder = "Enter preset name...";
    inputWrapper.appendChild(field);

    const tagsLabel = mkEl("div", "rs-input-label");
    tagsLabel.textContent = "Tags (optional):";

    const tagsContainer = mkEl("div", "rs-tags-container");
    const tagList = ["唯美", "特色", "写实", "古风", "动漫", "油画", "室内", "户外"];
    const selectedTags = new Set();

    tagList.forEach(tag => {
        const tagBtn = mkEl("button", "rs-tag-btn");
        tagBtn.textContent = tag;
        tagBtn.addEventListener("click", () => {
            if (selectedTags.has(tag)) {
                selectedTags.delete(tag);
                tagBtn.classList.remove("rs-tag-selected");
            } else {
                selectedTags.add(tag);
                tagBtn.classList.add("rs-tag-selected");
            }
        });
        tagsContainer.appendChild(tagBtn);
    });

    const btnsDiv = mkEl("div", "rs-input-buttons");
    const okBtn = mkEl("button", "rs-input-ok-btn");
    okBtn.textContent = "OK";
    const cancelBtn = mkEl("button", "rs-input-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, cancelBtn);
    modal.append(aiStatus, label, inputWrapper, tagsLabel, tagsContainer, btnsDiv);

    return { modal, aiStatus, label, field, inputWrapper, tagsContainer, okBtn, cancelBtn, selectedTags };
}

function createDeleteModal() {
    const modal = mkEl("div", "rs-delete-confirm-overlay");
    const textDiv = mkEl("div", "rs-delete-text");
    const btnsDiv = mkEl("div", "rs-delete-buttons");
    const okBtn = mkEl("button", "rs-delete-ok-btn");
    okBtn.textContent = "OK";
    const cancelBtn = mkEl("button", "rs-delete-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, cancelBtn);
    modal.append(textDiv, btnsDiv);
    return { modal, textDiv, okBtn, cancelBtn };
}

function createDownloadModal() {
    const modal = mkEl("div", "rs-download-modal");
    
    const header = mkEl("div", "rs-download-header");
    header.innerHTML = "📦 Model Download";
    
    const content = mkEl("div", "rs-download-content");
    
    const infoText = mkEl("div", "rs-download-info");
    infoText.innerHTML = `
        <div class="rs-download-title">LLM Model Required</div>
        <div class="rs-download-desc">Download the model to enable AI features</div>
    `;
    
    const modelInfo = mkEl("div", "rs-download-model-info");
    modelInfo.innerHTML = `
        <div class="rs-download-model-name">Qwen3.5-0.8B-Q4_K_M.gguf</div>
        <div class="rs-download-repo">lmstudio-community/Qwen3.5-0.8B-GGUF</div>
    `;
    
    const progressContainer = mkEl("div", "rs-download-progress-container");
    progressContainer.style.display = "none";
    
    const progressBar = mkEl("div", "rs-download-progress-bar");
    const progressFill = mkEl("div", "rs-download-progress-fill");
    const progressText = mkEl("div", "rs-download-progress-text");
    progressText.textContent = "0%";
    
    progressBar.appendChild(progressFill);
    progressContainer.appendChild(progressBar);
    progressContainer.appendChild(progressText);
    
    const statusText = mkEl("div", "rs-download-status");
    statusText.textContent = "Ready to download";
    
    const btnsDiv = mkEl("div", "rs-download-buttons");
    const downloadBtn = mkEl("button", "rs-download-btn");
    downloadBtn.textContent = "🚀 Start Download";
    const cancelBtn = mkEl("button", "rs-download-cancel-btn");
    cancelBtn.textContent = "Cancel";
    const closeBtn = mkEl("button", "rs-download-close-btn");
    closeBtn.textContent = "✕";
    closeBtn.style.display = "none";
    
    btnsDiv.append(downloadBtn, cancelBtn, closeBtn);
    
    content.append(infoText, modelInfo, progressContainer, statusText, btnsDiv);
    modal.append(header, content);
    
    return { 
        modal, 
        infoText, 
        modelInfo, 
        progressContainer, 
        progressFill, 
        progressText, 
        statusText, 
        downloadBtn, 
        cancelBtn, 
        closeBtn 
    };
}

// ==========================================
// Settings Modal - Simplified: single provider dropdown (Local GGUF + remote APIs)
// ==========================================

function createSettingsModal() {
    const overlay = mkEl("div", "rs-settings-overlay");
    const modal = mkEl("div", "rs-settings-modal");
    
    const wrapper = mkEl("div", "rs-settings-modal-wrapper");
    
    const header = mkEl("div", "rs-settings-header");
    const titleSpan = mkEl("span", "rs-settings-title-bar");
    titleSpan.textContent = "⚙️ Settings";
    header.appendChild(titleSpan);
    
    const closeBtn = mkEl("button", "rs-settings-close-btn");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.appendChild(closeBtn);
    
    const content = mkEl("div", "rs-settings-content");
    
    // Tab navigation - LLM Settings + Templates (only 2 tabs)
    const tabNav = mkEl("div", "rs-tabs-nav");
    
    const llmTabBtn = mkEl("button", "rs-tab-btn active");
    llmTabBtn.textContent = "🤖 LLM Settings";
    
    const templateTabBtn = mkEl("button", "rs-tab-btn");
    templateTabBtn.textContent = "📝 Prompt Templates";
    
    tabNav.appendChild(llmTabBtn);
    tabNav.appendChild(templateTabBtn);
    
    // ==========================================
    // LLM Settings tab content (single form with provider dropdown)
    // ==========================================
    const llmTabContent = mkEl("div", "rs-llm-settings-content");

    // Provider select - unified dropdown with all providers including Local GGUF
    const remoteForm = mkEl("div", "rs-remote-form");
    
    const remoteInfoText = mkEl("div", "rs-settings-info");
    remoteInfoText.innerHTML = `
        <div class="rs-settings-title">LLM Provider</div>
        <div class="rs-settings-desc">Choose a provider for AI features</div>
    `;

    // Provider select row
    const providerRow = mkEl("div", "rs-config-row");
    const providerLabel = mkEl("label", "rs-form-label");
    providerLabel.textContent = "Provider";
    
    const providerSelect = mkEl("select", "rs-form-input rs-remote-provider");
    providerSelect.id = "rs-remote-provider";
    // <option value="local">Local (GGUF)</option>
    providerSelect.innerHTML = `
        <option value="openai">OpenAI Compatible</option>
        <option value="lmstudio">LM Studio</option>
        <option value="ollama">Ollama</option>
    `;
    
    providerRow.appendChild(providerLabel);
    providerRow.appendChild(providerSelect);

    // Model input (text for OpenAI) - hidden by default, shown only for OpenAI
    const modelInput = mkEl("input", "rs-form-input rs-remote-model");
    modelInput.type = "text";
    modelInput.id = "rs-remote-model";
    modelInput.placeholder = "e.g., gpt-4o-mini";
    modelInput.style.display = 'none';

    // Model select (for LM Studio / Ollama - fetches from remote URL) - hidden by default
    const modelSelectEl = document.createElement('select');
    modelSelectEl.className = 'rs-form-input rs-remote-model';
    modelSelectEl.id = 'rs-remote-model-select';
    modelSelectEl.style.display = 'none';

    // Model select (for Local GGUF - fetches from local filesystem) - hidden by default
    const localModelSelectEl = document.createElement('select');
    localModelSelectEl.className = 'rs-form-input rs-local-model-select';
    localModelSelectEl.id = 'rs-local-model-select';
    localModelSelectEl.style.cssText = 'width: 100%; padding: 6px 8px; background: #2a2a2a; border: 1px solid #444; color: #ccc; font-size: 12px; border-radius: 4px; outline: none; box-sizing: border-box; height: 32px;';
    localModelSelectEl.style.display = 'none';

    // API Key input row
    const apiKeyRow = mkEl("div", "rs-config-row");
    const apiKeyLabel = mkEl("label", "rs-form-label");
    apiKeyLabel.textContent = "API Key";
    
    const apiKeyInput = mkEl("input", "rs-form-input rs-remote-api-key");
    apiKeyInput.type = "password";
    apiKeyInput.id = "rs-remote-api-key";
    apiKeyInput.placeholder = "Optional for local services";
    
    apiKeyRow.appendChild(apiKeyLabel);
    apiKeyRow.appendChild(apiKeyInput);

    // Base URL input row
    const baseUrlRow = mkEl("div", "rs-config-row");
    const baseUrlLabel = mkEl("label", "rs-form-label");
    baseUrlLabel.textContent = "Base URL";
    
    const baseUrlInput = mkEl("input", "rs-form-input rs-remote-base-url");
    baseUrlInput.type = "text";
    baseUrlInput.id = "rs-remote-base-url";
    baseUrlInput.placeholder = "Leave empty for default";
    
    baseUrlRow.appendChild(baseUrlLabel);
    baseUrlRow.appendChild(baseUrlInput);

    // Model row - contains text input, remote select, and local select
    const modelRowWrapper = mkEl("div", "rs-config-row");
    modelRowWrapper.id = "rs-model-input-wrapper";
    const modelLabel = mkEl("label", "rs-form-label");
    modelLabel.textContent = "Model";
    modelRowWrapper.appendChild(modelLabel);
    modelRowWrapper.appendChild(modelInput);
    modelRowWrapper.appendChild(modelSelectEl);
    // Append localModelSelectEl to DOM (hidden by default, shown for Local GGUF)
    modelRowWrapper.appendChild(localModelSelectEl);

    // Provider save status indicator
    const providerSaveStatusText = mkEl("div", "rs-provider-save-status");
    providerSaveStatusText.textContent = "";
    providerSaveStatusText.style.display = "none";
    providerSaveStatusText.style.fontSize = "11px";
    providerSaveStatusText.style.color = "#999";

    // 本地模型下载区：未下载时显示下载按钮，点击后显示进度
    const localDownloadArea = mkEl("div", "rs-local-download-area");
    localDownloadArea.style.display = "none";
    localDownloadArea.style.marginTop = "10px";

    const localDownloadBtn = mkEl("button", "rs-btn rs-btn-local rs-local-download-btn");
    localDownloadBtn.textContent = "⬇️ Download Model";
    localDownloadBtn.type = "button";
    localDownloadBtn.style.cursor = "pointer";

    const localDownloadProgressWrap = mkEl("div", "rs-local-download-progress-wrap");
    localDownloadProgressWrap.style.display = "none";
    localDownloadProgressWrap.style.position = "relative";
    localDownloadProgressWrap.style.width = "100%";
    localDownloadProgressWrap.style.height = "24px";
    localDownloadProgressWrap.style.background = "#2a2a2a";
    localDownloadProgressWrap.style.border = "1px solid #444";
    localDownloadProgressWrap.style.borderRadius = "4px";
    localDownloadProgressWrap.style.overflow = "hidden";

    const localDownloadProgressFill = mkEl("div", "rs-local-download-progress-fill");
    localDownloadProgressFill.style.width = "0%";
    localDownloadProgressFill.style.height = "100%";
    localDownloadProgressFill.style.background = "#5090cc";
    localDownloadProgressFill.style.transition = "width 0.3s ease";

    const localDownloadProgressText = mkEl("span", "rs-local-download-progress-text");
    localDownloadProgressText.textContent = "0%";
    localDownloadProgressText.style.position = "absolute";
    localDownloadProgressText.style.top = "0";
    localDownloadProgressText.style.left = "0";
    localDownloadProgressText.style.right = "0";
    localDownloadProgressText.style.lineHeight = "24px";
    localDownloadProgressText.style.textAlign = "center";
    localDownloadProgressText.style.color = "#fff";
    localDownloadProgressText.style.fontSize = "11px";

    localDownloadProgressWrap.appendChild(localDownloadProgressFill);
    localDownloadProgressWrap.appendChild(localDownloadProgressText);
    localDownloadArea.append(localDownloadBtn, localDownloadProgressWrap);

    remoteForm.append(remoteInfoText, providerRow, modelRowWrapper, apiKeyRow, baseUrlRow, providerSaveStatusText, localDownloadArea);

    // ==========================================
    // Template Management Tab (Tab 2)
    // ==========================================
    const templateTabContent = mkEl("div", "rs-tab-content");
    
    const tplToolbar = mkEl("div", "rs-tpl-toolbar");
    const tplSearchInput = mkEl("input", "rs-form-input rs-tpl-search");
    tplSearchInput.placeholder = "🔍 Search templates...";
    const newTplBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-new-btn");
    newTplBtn.textContent = "+ New Template";
    
    const tplListBody = mkEl("div", "rs-tpl-list-body");
    tplListBody.style.maxHeight = "200px";
    tplListBody.style.overflowY = "auto";
    
    const tplEditorArea = mkEl("div", "rs-tpl-editor-area");
    
    const tplNameRow = mkEl("div", "rs-config-row");
    const tplNameLabel = mkEl("label", "rs-form-label");
    tplNameLabel.textContent = "Template Name";
    const tplNameInput = mkEl("input", "rs-form-input rs-tpl-name");
    tplNameInput.placeholder = "Enter template name...";
    tplNameRow.appendChild(tplNameLabel);
    tplNameRow.appendChild(tplNameInput);
    
    // Tags input removed - simplified template editor
    
    const tplContentRow = mkEl("div", "rs-config-row");
    const tplContentLabel = mkEl("label", "rs-form-label");
    tplContentLabel.textContent = "System Prompt Content";
    const tplContentTextarea = document.createElement("textarea");
    tplContentTextarea.className = "rs-form-input rs-tpl-content";
    tplContentTextarea.style.minHeight = "120px";
    tplContentTextarea.style.resize = "vertical";
    tplContentTextarea.placeholder = "Enter the system prompt content...";
    
    const tplEditorBtns = mkEl("div", "rs-modal-btns");
    const tplSaveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    tplSaveBtn.textContent = "💾 Save";
    const tplCancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-tpl-cancel-btn");
    tplCancelBtn.textContent = "✕ Cancel";
    
    tplEditorBtns.append(tplSaveBtn, tplCancelBtn);
    tplEditorArea.append(tplNameRow, tplContentRow, tplEditorBtns);
    tplContentRow.appendChild(tplContentTextarea);
    
    templateTabContent.append(tplToolbar, tplListBody, tplEditorArea);
    tplToolbar.append(tplSearchInput, newTplBtn);

    // ==========================================
    // Assemble content
    // ==========================================
    llmTabContent.style.cssText = "display: block !important";
    content.append(tabNav, llmTabContent, templateTabContent);
    llmTabContent.appendChild(remoteForm);

    const statusText = mkEl("div", "rs-settings-status");
    statusText.textContent = "";
    statusText.style.display = "none";
    
    wrapper.append(header, content);
    modal.appendChild(wrapper);
    
    // ==========================================
    // Tab switching logic
    // ==========================================
    const switchToTab = (tabBtn, contentEl, tabName) => {
        llmTabBtn.classList.remove("active");
        templateTabBtn.classList.remove("active");
        tabBtn.classList.add("active");
        
        // Hide all tab contents first
        llmTabContent.style.cssText = "display: none !important";
        templateTabContent.style.cssText = "display: none !important";
        
        // Show the selected tab content
        contentEl.style.cssText = "display: block !important";
        
        // Remember last opened tab
        _lastSettingsTab = tabName;
    };

    let _templatesLoaded = false;

    // Initial state: restore from memory or default to LLM tab
    if (_lastSettingsTab === "templates") {
        llmTabContent.style.cssText = "display: none !important";
        templateTabContent.style.cssText = "display: block !important";
        llmTabBtn.classList.remove("active");
        templateTabBtn.classList.add("active");
        // Load templates if restoring to templates tab
        if (!_templatesLoaded) {
            loadTemplatesList().then(() => { _templatesLoaded = true; });
        }
    } else {
        llmTabContent.style.cssText = "display: block !important";
        templateTabContent.style.cssText = "display: none !important";
        llmTabBtn.classList.add("active");
        templateTabBtn.classList.remove("active");
    }

    const handleLlmClick = (e) => { 
        e.stopImmediatePropagation(); 
        switchToTab(llmTabBtn, llmTabContent, "llm"); 
    };
    
    const handleTemplateClick = async (e) => { 
        e.stopImmediatePropagation(); 
        switchToTab(templateTabBtn, templateTabContent, "templates"); 
        if (!_templatesLoaded) {
            await loadTemplatesList();
            _templatesLoaded = true;
        }
    };

    llmTabBtn.addEventListener("mousedown", handleLlmClick, true);
    templateTabBtn.addEventListener("mousedown", handleTemplateClick, true);
    llmTabBtn.addEventListener("click", handleLlmClick, true);
    templateTabBtn.addEventListener("click", handleTemplateClick, true);

    // ==========================================
    // Provider change handler - show/hide fields dynamically
    // ==========================================
    const fetchModelsFromUrl = async (baseUrl, targetSelect) => {
        targetSelect.innerHTML = '';
        const loadingOpt = document.createElement('option');
        loadingOpt.value = '__loading__';
        loadingOpt.textContent = '⏳ Loading models...';
        targetSelect.appendChild(loadingOpt);
        targetSelect.disabled = true;
        
        try {
            const proxyUrl = `/rs_prompts/fetch_remote_models`;
            const resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_url: baseUrl })
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();
            if (!result.success) throw new Error(result.error || 'Failed');
            
            targetSelect.innerHTML = '';

            const models = result.models || (result.data && result.data.data) || [];
            
            models.forEach(m => {
                const id = typeof m === 'string' ? m : (m && (m.id || m.name));
                if (!id) return;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = id;
                targetSelect.appendChild(opt);
            });
            
            if (!targetSelect.options.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No models found';
                targetSelect.appendChild(opt);
            }
        } catch (e) {
            console.warn('Failed to fetch models:', e);
            targetSelect.innerHTML = '<option value="">❌ Failed to load</option>';
        } finally {
            targetSelect.disabled = false;
        }
    };

    const setSelectedModelValue = (modelSelect, modelValue) => {
        if (!modelValue || !modelSelect) return;
        
        let found = false;
        for (let i = 0; i < modelSelect.options.length; i++) {
            if (modelSelect.options[i].value === modelValue) {
                modelSelect.value = modelValue;
                found = true;
                break;
            }
        }
        
        if (!found) {
            const opt = document.createElement('option');
            opt.value = modelValue;
            opt.textContent = modelValue;
            modelSelect.appendChild(opt);
            modelSelect.value = modelValue;
        }
    };

    const getModelValue = () => {
        const provider = providerSelect.value;
        if (provider === 'local') {
            return localModelSelectEl.value || '';
        } else if (provider === 'openai') {
            return modelInput.value;
        } else {
            // LM Studio / Ollama
            if (modelSelectEl && modelSelectEl.style.display !== 'none' && modelSelectEl.value) {
                return modelSelectEl.value;
            }
            return modelInput.value;
        }
    };

    const fetchLocalModels = async () => {
        localModelSelectEl.innerHTML = '';
        const loadingOpt = document.createElement('option');
        loadingOpt.value = '__loading__';
        loadingOpt.textContent = '⏳ Loading models...';
        localModelSelectEl.appendChild(loadingOpt);
        localModelSelectEl.disabled = true;

        try {
            const resp = await fetch('/rs_prompts/get_models');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();
            
            localModelSelectEl.innerHTML = '';
            
            if (result.models && result.models.length > 0) {
                result.models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.key;
                    opt.textContent = m.name || m.key;
                    if (m.key === result.current_model) {
                        opt.selected = true;
                    }
                    localModelSelectEl.appendChild(opt);
                });
            } else {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No models found';
                localModelSelectEl.appendChild(opt);
            }
        } catch (e) {
            console.warn('Failed to fetch local models:', e);
            localModelSelectEl.innerHTML = '<option value="">❌ Failed to load</option>';
        } finally {
            localModelSelectEl.disabled = false;
        }
    };

    const REMOTE_PROVIDER_DEFAULTS = {
        lmstudio: { baseUrl: "http://localhost:1234/v1" },
        ollama: { baseUrl: "http://localhost:11430/v1" }
    };

    let savedRemoteConfig = null;

    const handleProviderChange = async () => {
        const provider = providerSelect.value;

        // Load this provider's own saved config so switching providers never overwrites each other
        const fullConfig = await window.NeoNodes?.getRemoteLLMConfig?.() || {};
        savedRemoteConfig = fullConfig;
        const saved = (fullConfig.providers && fullConfig.providers[provider]) || {};
        const mask = (v) => (v === '***' ? '' : (v || ''));
        
        if (provider === 'local') {
            // Local GGUF: show local model select, hide everything else
            apiKeyRow.style.display = "none";
            baseUrlRow.style.display = "none";
            modelInput.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'block', 'important');
            
            // Fetch available local models
            fetchLocalModels();

            // 刷新当前选中本地模型的下载状态（显示下载按钮/进度），等下拉填充后执行
            setTimeout(() => {
                if (typeof refreshLocalDownloadState === 'function') {
                    refreshLocalDownloadState();
                }
            }, 500);
        } else if (provider === 'openai') {
            if (typeof stopLocalModelStatusPoller === 'function') {
                stopLocalModelStatusPoller();
            }
            localDownloadArea.style.display = "none";
            apiKeyRow.style.display = "flex";
            baseUrlRow.style.display = "flex";
            apiKeyInput.placeholder = "sk-... (optional for cloud)";
            modelInput.style.setProperty('display', '', '');
            modelInput.type = "text";
            modelInput.placeholder = "e.g., gpt-4o-mini";
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'none', 'important');
            apiKeyInput.value = mask(saved.api_key);
            baseUrlInput.value = saved.base_url || "";
            modelInput.value = saved.model || "";
        } else if (provider === 'lmstudio' || provider === 'ollama') {
            if (typeof stopLocalModelStatusPoller === 'function') {
                stopLocalModelStatusPoller();
            }
            localDownloadArea.style.display = "none";
            apiKeyRow.style.display = "none";
            modelInput.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'block', 'important');
            const defaultBaseUrl = REMOTE_PROVIDER_DEFAULTS[provider].baseUrl;
            baseUrlInput.value = saved.base_url || defaultBaseUrl;
            await fetchModelsFromUrl(baseUrlInput.value.trim(), modelSelectEl);
            if (saved.model && saved.model !== '__loading__') {
                setSelectedModelValue(modelSelectEl, saved.model);
            } else if (modelSelectEl.options.length > 1 && modelSelectEl.value === '__loading__') {
                // 无有效保存模型时，自动选中第一个可用模型
                modelSelectEl.value = modelSelectEl.options[1]?.value || '';
            }
        }
    };

    providerSelect.addEventListener("change", async () => {
        await handleProviderChange();
        // Small delay to allow local models to start loading before auto-saving
        if (providerSelect.value === 'local') {
            setTimeout(() => autoSaveConfig(), 200);
        } else {
            autoSaveConfig();
        }
    });

    // ==========================================
    // Auto-save on field changes (blur/change)
    // ==========================================
    let saveTimeout = null;
    const autoSaveConfig = () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            const provider = providerSelect.value;
            const modelValue = getModelValue();
            const config = {
                enabled: provider !== 'local',
                provider: provider,
                api_key: apiKeyInput.value,
                base_url: baseUrlInput.value
            };
            // 远程模型下拉为空（加载失败或未选择）时不覆盖已保存的 model
            if (provider === 'lmstudio' || provider === 'ollama') {
                if (modelValue) config.model = modelValue;
            } else {
                config.model = modelValue;
            }

            const result = await window.NeoNodes?.saveRemoteLLMConfig?.(config);
            
            if (result && result.success) {
                providerSaveStatusText.textContent = "✅ Saved";
                providerSaveStatusText.style.display = "block";
                providerSaveStatusText.style.color = "#16a34a";
                
                setTimeout(() => {
                    providerSaveStatusText.style.display = "none";
                }, 1500);
            } else {
                providerSaveStatusText.textContent = "❌ Save failed";
                providerSaveStatusText.style.display = "block";
                providerSaveStatusText.style.color = "#dc2626";
                
                setTimeout(() => {
                    providerSaveStatusText.style.display = "none";
                }, 2000);
            }
        }, 300);
    };

    // Auto-save on field changes (blur/change) - provider select already has its handler above
    apiKeyInput.addEventListener("blur", autoSaveConfig);
    baseUrlInput.addEventListener("blur", autoSaveConfig);
    // Auto-fetch models when the base URL field changes (LM Studio / Ollama)
    const fetchModelsForBaseUrl = async () => {
        if (providerSelect.value === 'lmstudio' || providerSelect.value === 'ollama') {
            const url = baseUrlInput.value.trim();
            if (!url) return;
            await fetchModelsFromUrl(url, modelSelectEl);
            const savedModel = savedRemoteConfig?.providers?.[providerSelect.value]?.model;
            if (savedModel && savedModel !== '__loading__') {
                setSelectedModelValue(modelSelectEl, savedModel);
            } else if (modelSelectEl.options.length > 1 && modelSelectEl.value === '__loading__') {
                modelSelectEl.value = modelSelectEl.options[1]?.value || '';
            }
        }
    };
    baseUrlInput.addEventListener("change", fetchModelsForBaseUrl);
    baseUrlInput.addEventListener("blur", fetchModelsForBaseUrl);
    modelInput.addEventListener("blur", autoSaveConfig);
    modelSelectEl.addEventListener("change", autoSaveConfig);

    // ==========================================
    // 本地模型下载：未下载时显示下载按钮，点击后显示进度
    // ==========================================
    let localModelStatusTimer = null;

    function stopLocalModelStatusPoller() {
        if (localModelStatusTimer) {
            clearInterval(localModelStatusTimer);
            localModelStatusTimer = null;
        }
    }

    function setLocalDownloadArea(state) {
        // state: 'hidden' | 'ready' | 'missing' | 'downloading' | 'error'
        if (state === "ready" || state === "hidden") {
            localDownloadArea.style.display = "none";
            return;
        }
        localDownloadArea.style.display = "block";
        if (state === "missing") {
            localDownloadBtn.style.display = "inline-block";
            localDownloadBtn.disabled = false;
            localDownloadProgressWrap.style.display = "none";
        } else if (state === "downloading") {
            localDownloadBtn.style.display = "none";
            localDownloadProgressWrap.style.display = "block";
        } else { // error -> 保留按钮重试
            localDownloadBtn.style.display = "inline-block";
            localDownloadBtn.disabled = false;
            localDownloadProgressWrap.style.display = "none";
        }
    }

    function setLocalDownloadProgress(percent) {
        localDownloadProgressFill.style.width = `${percent}%`;
        localDownloadProgressText.textContent = `${percent}%`;
    }

    function setLocalStatusMsg(msg, color, autoHide = true) {
        providerSaveStatusText.textContent = msg;
        providerSaveStatusText.style.display = "block";
        providerSaveStatusText.style.color = color || "#999";
        if (autoHide) {
            setTimeout(() => { providerSaveStatusText.style.display = "none"; }, 2500);
        }
    }

    function pollDownloadProgress() {
        stopLocalModelStatusPoller();
        setLocalDownloadArea("downloading");
        setLocalDownloadProgress(0);
        localModelStatusTimer = setInterval(async () => {
            let latest;
            try {
                clearModelStatusCache();
                latest = await checkModel();
            } catch (e) {
                latest = null;
            }
            const dl = latest?.download_status?.model;
            if (latest?.model_available) {
                stopLocalModelStatusPoller();
                setLocalDownloadArea("ready");
                setLocalStatusMsg("✅ Model ready", "#16a34a");
                return;
            }
            if (dl?.downloading) {
                setLocalDownloadProgress(dl.progress || 0);
                return;
            }
            if (dl?.error) {
                stopLocalModelStatusPoller();
                setLocalDownloadArea("error");
                setLocalStatusMsg("❌ Download failed: " + dl.error, "#dc2626", false);
            }
        }, 2000);
    }

    async function refreshLocalDownloadState() {
        stopLocalModelStatusPoller();
        let status;
        try {
            clearModelStatusCache();
            status = await checkModel();
        } catch (e) {
            setLocalDownloadArea("hidden");
            return;
        }

        if (status.model_available) {
            setLocalDownloadArea("ready");
            setLocalStatusMsg("✅ Model ready", "#16a34a");
            return;
        }

        const dlStatus = status.download_status?.model;
        if (dlStatus?.downloading) {
            setLocalDownloadProgress(dlStatus.progress || 0);
            pollDownloadProgress();
            return;
        }
        if (dlStatus?.error) {
            setLocalDownloadArea("error");
            setLocalStatusMsg("❌ Download failed: " + dlStatus.error, "#dc2626", false);
            return;
        }

        // 未下载：显示下载按钮
        setLocalDownloadArea("missing");
        setLocalStatusMsg("⚠️ Model not downloaded", "#f59e0b");
    }

    localModelSelectEl.addEventListener("change", async () => {
        autoSaveConfig();
        stopLocalModelStatusPoller();
        const modelKey = localModelSelectEl.value;
        if (!modelKey) {
            setLocalDownloadArea("hidden");
            return;
        }

        try {
            const setResult = await setCurrentModel(modelKey);
            if (!setResult || !setResult.success) {
                setLocalStatusMsg("❌ Model switch failed: " + (setResult?.error || modelKey), "#dc2626");
                return;
            }
            await refreshLocalDownloadState();
        } catch (e) {
            console.error("Failed to switch local model:", e);
            setLocalStatusMsg("❌ " + (e.message || "Model switch failed"), "#dc2626");
        }
    });

    localDownloadBtn.addEventListener("click", async () => {
        localDownloadBtn.disabled = true;
        localDownloadBtn.textContent = "⏳ Starting...";
        try {
            const result = await downloadModel("model");
            if (result.error) {
                setLocalDownloadArea("error");
                localDownloadBtn.textContent = "⬇️ Download Model";
                setLocalStatusMsg("❌ Download start failed: " + result.error, "#dc2626", false);
                return;
            }
            if (result.status === "already_exists") {
                await refreshLocalDownloadState();
                return;
            }
            // 下载已启动：显示进度
            pollDownloadProgress();
        } catch (e) {
            console.error("Failed to start download:", e);
            localDownloadBtn.disabled = false;
            localDownloadBtn.textContent = "⬇️ Download Model";
            setLocalStatusMsg("❌ " + (e.message || "Download failed to start"), "#dc2626");
        }
    });

    // ==========================================
    // Template management state and functions
    // ==========================================
    let currentTemplateId = null;
    let currentTemplateSource = "custom";
    
    async function loadTemplatesList() {
        tplListBody.innerHTML = "";
        
        const templates = await listTemplates();
        if (!templates || !templates.length) {
            tplListBody.textContent = "No templates found";
            return;
        }
        
        templates.forEach(tpl => {
            const row = document.createElement("div");
            row.className = "rs-tpl-item";
            row.dataset.id = tpl.id;
            row.style.cursor = "default";
            
            const leftDiv = mkEl("div", "rs-preset-left");
            const contentSpan = mkEl("span", "rs-preset-content");
            contentSpan.textContent = tpl.name || tpl.id;
            contentSpan.style.cursor = "pointer";
            contentSpan.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();
                loadTemplateEditor(tpl);
            }, true);
            
            const sourceBadge = mkEl("span", "rs-source-badge");
            sourceBadge.textContent = tpl.source === "presets" ? "SYS" : "USR";
            sourceBadge.title = tpl.source === "presets" ? "System preset (cannot delete)" : "User custom";
            contentSpan.appendChild(sourceBadge);
            
            leftDiv.appendChild(contentSpan);
            row.appendChild(leftDiv);
            
            if (tpl.tags && tpl.tags.length > 0) {
                const tagsSpan = document.createElement("span");
                tagsSpan.className = "rs-tags-part";
                tagsSpan.textContent = ` [${tpl.tags.join(", ")}]`;
                contentSpan.appendChild(document.createTextNode(" "));
                contentSpan.appendChild(tagsSpan);
            }
            
            // Add view/edit button for all templates
            const viewBtn = mkEl("span", "rs-delete-icon");
            viewBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
            viewBtn.title = "View/Edit template";
            viewBtn.style.cursor = "pointer";
            viewBtn.style.display = "inline-block";
            viewBtn.style.pointerEvents = "auto";
            viewBtn.style.marginRight = "8px";
            
            viewBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();
                loadTemplateEditor(tpl);
            }, true);
            row.appendChild(viewBtn);
            
            if (tpl.source === "custom") {
                const deleteBtn = mkEl("span", "rs-delete-icon");
                deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                deleteBtn.style.cursor = "pointer";
                deleteBtn.style.display = "inline-block";
                deleteBtn.style.pointerEvents = "auto";
                deleteBtn.style.zIndex = "1000";
                
                deleteBtn.addEventListener("mousedown", async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    
                    if (!confirm(`Delete template "${tpl.name}"?`)) {
                        return;
                    }
                    
                    const result = await deleteTemplate(tpl.id);
                    if (result.success) {
                        loadTemplatesList();
                        document.dispatchEvent(new CustomEvent("rs.templates.updated"));
                    } else {
                        alert(`Delete failed: ${result.error || "Unknown error"}`);
                    }
                }, true);
                row.appendChild(deleteBtn);
            } else {
                const copyBtn = mkEl("span", "rs-delete-icon");
                copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                copyBtn.title = "Copy as custom template";
                copyBtn.style.cursor = "pointer";
                copyBtn.style.display = "inline-block";
                copyBtn.style.pointerEvents = "auto";
                copyBtn.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    tplCopyAsCustom(tpl);
                }, true);
                row.appendChild(copyBtn);
            }
            
            tplListBody.appendChild(row);
        });
    }
    
    async function loadTemplateEditor(tpl) {
        currentTemplateId = tpl.id;
        currentTemplateSource = tpl.source || "custom";
        tplNameInput.value = tpl.name || tpl.id;
        tplContentTextarea.value = tpl.content || "";
        
        // Disable editing for preset templates
        const isPreset = currentTemplateSource === "presets";
        tplNameInput.disabled = isPreset;
        tplContentTextarea.disabled = isPreset;
        
        // Update save button visibility/behavior based on template type
        if (isPreset) {
            tplSaveBtn.style.display = "none";
        } else {
            tplSaveBtn.style.display = "inline-block";
        }
        
        tplEditorArea.style.display = "block";
    }
    
    async function tplCopyAsCustom(tpl) {
        const newId = tpl.id + "_copy_" + Date.now();
        await saveTemplate({
            id: newId,
            name: (tpl.name || tpl.id) + " (Copy)",
            content: tpl.content || "",
            tags: [...(tpl.tags || [])],
            source: "custom"
        });
        loadTemplatesList();
        document.dispatchEvent(new CustomEvent("rs.templates.updated"));
    }
    
    // Template search handler
    tplSearchInput.addEventListener("input", () => {
        const query = tplSearchInput.value.trim().toLowerCase();
        const items = tplListBody.querySelectorAll(".rs-tpl-item");
        items.forEach(item => {
            const name = (item.querySelector(".rs-preset-content")?.textContent || "").toLowerCase();
            item.style.display = (!query || name.includes(query)) ? "flex" : "none";
        });
    });
    
    // New template button - use capture phase to prevent ComfyUI interception
    const handleNewTplClick = (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        currentTemplateId = null;
        currentTemplateSource = "custom";
        tplNameInput.value = "";
        tplContentTextarea.value = "";
        tplNameInput.disabled = false;
        tplContentTextarea.disabled = false;
        tplSaveBtn.style.display = "inline-block";
        tplEditorArea.style.display = "block";
        tplNameInput.focus();
    };
    newTplBtn.addEventListener("mousedown", handleNewTplClick, true);
    newTplBtn.addEventListener("click", handleNewTplClick, true);
    
    // Save template button - use capture phase
    const handleSaveTplClick = async (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        const name = tplNameInput.value.trim();
        if (!name) { alert("Template name is required"); return; }
        
        const content = tplContentTextarea.value;
        
        // Generate id from name, keeping unicode letters/digits (e.g. Chinese names)
        let id = currentTemplateId || name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
        if (!id) return;
        
        const result = await saveTemplate({
            id,
            name,
            content,
            tags: [],
            source: "custom"
        });
        
        if (result.success) {
            tplNameInput.value = "";
            tplContentTextarea.value = "";
            currentTemplateId = null;
            loadTemplatesList();
            document.dispatchEvent(new CustomEvent("rs.templates.updated"));
        } else {
            alert("Save failed: " + (result.error || "Unknown error"));
        }
    };
    tplSaveBtn.addEventListener("mousedown", handleSaveTplClick, true);
    tplSaveBtn.addEventListener("click", handleSaveTplClick, true);
    
    // Cancel button - use capture phase
    const handleCancelTplClick = (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        tplNameInput.value = "";
        tplContentTextarea.value = "";
        currentTemplateId = null;
        tplEditorArea.style.display = "none";
    };
    tplCancelBtn.addEventListener("mousedown", handleCancelTplClick, true);
    tplCancelBtn.addEventListener("click", handleCancelTplClick, true);
    
    return { 
        modal, 
        overlay,
        modelList: null, // no longer used (model list is in the main UI)
        statusText, 
        closeBtn,
        enableCheckbox: null,  // removed - not needed anymore
        providerSelect,
        modelInput,
        modelSelectEl,
        localModelSelectEl,
        apiKeyInput,
        apiKeyRow,
        baseUrlInput,
        baseUrlRow,  // added for loadRemoteLLMConfig
        enableStatusText: null,  // removed
        providerSaveStatusText,
        autoSaveConfig,
        stopLocalModelStatusPoller,
        refreshLocalDownloadState,
        fetchModelsFromUrl,
        setSelectedModelValue,
        fetchLocalModels,
        handleProviderChange,
        _llmMode: "local",
        _handleLocalModeClick: null,
        _handleRemoteModeClick: null
    };
}

// ==========================================
// Load Remote LLM Config into settings modal
// Now simplified: just set provider/model values from saved config
// ==========================================

async function loadRemoteLLMConfig(settingsModal) {
    const config = await window.NeoNodes?.getRemoteLLMConfig?.() || {};

    // Determine provider value - default to 'local' if no valid provider or no config
    let providerValue = config.active_provider || 'local';
    if (!['local', 'openai', 'lmstudio', 'ollama'].includes(providerValue)) {
        providerValue = 'openai';
    }

    // If enabled is false, default to local
    if (config.enabled === false) {
        providerValue = 'local';
    }

    settingsModal.providerSelect.value = providerValue;

    // Load this provider's saved config and show/hide fields correctly
    if (settingsModal.handleProviderChange) {
        await settingsModal.handleProviderChange();
    }
}

// ==========================================
// Quick input tips rotation
// ==========================================

const QUICK_INPUT_TIPS = [
    "✨ 输入描述，AI 自动帮你生成提示词",
    "📝 输入改写需求，如：'去掉动漫风格，改成写实'",
    "🌐 输入翻译需求，如：'翻译成中文'",
    "🎨 输入风格要求，如：'改成赛博朋克风格'",
    "📷 输入场景描述，如：'夕阳下的海边日落'",
    "🔍 输入关键词搜索已有提示词",
    "🚀 输入描述后按 Enter 生成，Shift+Enter 换行",
    "🔄 输入修改指令，如：'增加细节描述'",
    "🎭 输入角色描述，如：'一个穿着汉服的女孩'",
    "🌅 输入时间场景，如：'清晨的森林，阳光穿透树叶'",
    "🏙️ 输入城市描述，如：'未来科幻城市，高楼林立'",
    "💾 点击保存按钮将提示词存为预设",
    "⚙️ 设置中可切换 AI 模型和模板"
];

function getRandomTip() {
    return QUICK_INPUT_TIPS[Math.floor(Math.random() * QUICK_INPUT_TIPS.length)];
}

// ==========================================
// Status bars with toggle, template selector, action buttons
// ==========================================

function createStatusBars() {
    const statusBar = mkEl("div", "rs-status-bar");
    
    const toggleWrapper = mkEl("div", "rs-toggle-wrapper");
    
    // Tab-style toggle with text labels
    const toggleSwitch = mkEl("div", "rs-toggle-switch");
    toggleSwitch.setAttribute("data-rs-tooltip", "Switch between local prompt and external input");
    
    const localTab = mkEl("div", "rs-toggle-tab rs-toggle-local");
    localTab.textContent = "LOCAL";
    localTab.dataset.state = "local";
    
    const externalTab = mkEl("div", "rs-toggle-tab rs-toggle-external");
    externalTab.textContent = "EXTERNAL";
    externalTab.dataset.state = "external";
    
    toggleSwitch.appendChild(localTab);
    toggleSwitch.appendChild(externalTab);
    toggleWrapper.appendChild(toggleSwitch);
    
    // Template selector dropdown (now skill-aware: templates + tasks + image skills)
    const tplSelector = mkEl("select", "rs-tpl-selector");
    tplSelector.title = "Select skill (template / task / image)";

    // 附加图片 chips 容器 + 图片选择按钮（用于反推等 vision skill）
    const imageChipsRow = mkEl("div", "rs-image-chips");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    const attachedImages = []; // [{data: dataURI, name: string}]

    function addImageFile(file) {
        return fileToBase64(file).then(img => {
            attachedImages.push(img);
            renderImageChips();
            return img;
        }).catch(e => console.error("Failed to read image:", e));
    }

    // 悬停放大预览：单例元素挂在 body 上（fixed 定位），避免被节点 overflow 裁剪
    let imageHoverPreview = null;

    function showImageHoverPreview(src, anchorEl) {
        if (!imageHoverPreview) {
            imageHoverPreview = mkEl("img", "rs-image-hover-preview");
            document.body.appendChild(imageHoverPreview);
        }
        // 预览最大尺寸跟随画布缩放比率，保持与节点内容的视觉大小一致
        const canvasScale = app?.canvas?.ds?.scale || 1;
        const scale = Math.max(0.4, Math.min(canvasScale, 2.5));
        const maxW = 320 * scale;
        const maxH = 320 * scale;
        imageHoverPreview.style.maxWidth = maxW + "px";
        imageHoverPreview.style.maxHeight = maxH + "px";

        const r = anchorEl.getBoundingClientRect();
        // 按图片实际显示尺寸（保持宽高比）定位，避免横向/纵向图片偏离缩略图太远
        const positionPreview = () => {
            if (imageHoverPreview.style.display !== "block") return;
            const nw = imageHoverPreview.naturalWidth || maxW;
            const nh = imageHoverPreview.naturalHeight || maxH;
            const k = Math.min(1, maxW / nw, maxH / nh); // 不放大，仅按需缩小
            const dispW = nw * k;
            const dispH = nh * k;
            let left = r.left + r.width / 2 - dispW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - dispW - 8));
            let top = r.top - dispH - 10; // 默认显示在缩略图上方
            if (top < 8) top = r.bottom + 10; // 放不下则翻到下方
            imageHoverPreview.style.left = left + "px";
            imageHoverPreview.style.top = top + "px";
        };
        imageHoverPreview.onload = positionPreview;
        imageHoverPreview.src = src;
        imageHoverPreview.style.display = "block";
        // 缓存命中时 onload 不触发，complete 时立即定位
        if (imageHoverPreview.complete && imageHoverPreview.naturalWidth) {
            positionPreview();
        }
    }

    function hideImageHoverPreview() {
        if (imageHoverPreview) imageHoverPreview.style.display = "none";
    }

    function renderImageChips() {
        imageChipsRow.innerHTML = "";
        attachedImages.forEach((img, idx) => {
            const chip = mkEl("span", "rs-image-chip");

            const thumb = document.createElement("img");
            thumb.src = img.input ? inputViewUrl(img.input) : img.data;
            thumb.alt = `Image ${idx + 1}`;
            thumb.className = "rs-image-chip-thumb";
            // 悬停放大预览
            thumb.addEventListener("mouseenter", () => showImageHoverPreview(thumb.src, chip));
            thumb.addEventListener("mouseleave", hideImageHoverPreview);

            // 顺序编号 badge：显示该图的参数位 <Picture N>；无参数位（反推附件）不显示编号
            const controls = mkEl("span", "rs-image-controls");

            if (img.pictureNo != null) {
                const orderBadge = mkEl("span", "rs-image-order-badge");
                orderBadge.textContent = `${img.pictureNo}`;
                controls.appendChild(orderBadge);
            }

            // 删除按钮
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "✕";
            del.className = "rs-image-chip-del";
            del.title = "移除图片";
            del.addEventListener("click", () => {
                attachedImages.splice(idx, 1);
                renderImageChips();
            });

            controls.appendChild(del);
            chip.appendChild(thumb);
            chip.appendChild(controls);
            imageChipsRow.appendChild(chip);
        });
    }

    function clearImages() {
        attachedImages.length = 0;
        renderImageChips();
    }

    // input 目录图片的缩略图地址（ComfyUI /view 端点）
    function inputViewUrl(value) {
        const v = String(value).trim().replace(/\[[^\]]*\]$/, "");
        const i = v.lastIndexOf("/");
        const fname = i >= 0 ? v.slice(i + 1) : v;
        const sub = i >= 0 ? v.slice(0, i) : "";
        return `/view?filename=${encodeURIComponent(fname)}&subfolder=${encodeURIComponent(sub)}&type=input`;
    }

    // 图片判重键：去掉 [input]/[output] 标注并归一化
    function imageKey(value) {
        return String(value || "").replace(/\[[^\]]*\]\s*$/, "").trim();
    }

    // 以文件名形式附加图片（出队时由后端从 input/output 目录解析，无需连线）。
    // 判重：同一图片已附加则忽略，避免重复 chip / 编号错乱。
    // pictureNo：目标节点 IMAGE 输入参数序号；未连接的图片为 undefined（仅作反推附件）。
    function addImageInput(value, name, pictureNo) {
        const key = imageKey(value);
        if (!key) return;
        const dup = attachedImages.some(img => imageKey(img.input) === key);
        if (dup) return;
        attachedImages.push({ name: name || key.split("/").pop(), input: value, pictureNo });
        renderImageChips();
    }

    // 收集工作流上未禁用的 Load Image 节点图片（与 gallery 发送按钮同款过滤：跳过 BYPASS/禁用）。
    // pictureNo：图片输出连接到目标节点 IMAGE 输入槽的参数序号（1-based）；无连线为 null，仅能用于反推。
    function collectWorkflowLoadImages() {
        return (async () => {
            try {
                let nodes = null;
                let serializedLinks = null; // graphToPrompt 序列化格式的 links 数组
                if (typeof app?.graphToPrompt === "function") {
                    try {
                        const prompt = await app.graphToPrompt();
                        nodes = prompt?.workflow?.nodes || null;
                        serializedLinks = prompt?.workflow?.links || null;
                    } catch (e) {
                        console.warn("[Neo] graphToPrompt:", e);
                    }
                }
                if (!Array.isArray(nodes)) nodes = app.graph?._nodes || [];

                // linkId -> {origin_id, target_id, target_slot}
                const linkMap = new Map();
                if (Array.isArray(serializedLinks)) {
                    for (const l of serializedLinks) {
                        // [id, origin_id, origin_slot, target_id, target_slot, type]
                        if (Array.isArray(l)) linkMap.set(String(l[0]), { origin_id: l[1], target_id: l[3], target_slot: l[4] });
                    }
                } else {
                    const gl = app.graph?.links;
                    const iter = gl && typeof gl.forEach === "function" ? gl : Object.values(gl || {});
                    iter.forEach(l => {
                        if (l && l.target_id != null) linkMap.set(String(l.id), l);
                    });
                }
                const nodeById = new Map(nodes.map(n => [String(n.id), n]));

                // 该 load image 输出连到目标节点 IMAGE 输入槽的参数序号；无连线返回 null
                const computePictureNo = (n) => {
                    for (const o of (n.outputs || [])) {
                        const lids = Array.isArray(o.links) ? o.links : (o.link != null ? [o.link] : []);
                        for (const lid of lids) {
                            const link = linkMap.get(String(lid));
                            if (!link) continue;
                            const target = nodeById.get(String(link.target_id));
                            if (!target) continue;
                            let count = 0;
                            const slotIdx = Number(link.target_slot) || 0;
                            for (let i = 0; i < (target.inputs || []).length; i++) {
                                if (String(target.inputs[i].type).toUpperCase() !== "IMAGE") continue;
                                count++;
                                if (i === slotIdx) return count;
                            }
                        }
                    }
                    return null;
                };

                // 有参数位（pictureNo）的优先排在前面；两组内部保持工作流原有顺序
                const connected = [];
                const unconnected = [];
                const skipped = [];
                for (const n of nodes) {
                // 核心 LoadImage / LoadImageOutput 及各类加载器变体
                const cls = String(n.comfyClass || n.type || "");
                if (!/load.*image/i.test(cls)) continue;
                if (n.mode === 2 || n.mode === 4) continue; // NEVER / BYPASS
                // 新增/切换/粘贴加载的节点，其 widgets_values 可能滞后于当前 widget 值。
                // 与前端序列化一致：先把自己节点的 widget 当前值回填，避免 @ 读到旧图片。
                if (Array.isArray(n.widgets) && Array.isArray(n.widgets_values)) {
                    for (let i = 0; i < n.widgets.length; i++) {
                        const w = n.widgets[i];
                        if (w && w.value !== undefined) n.widgets_values[i] = w.value;
                    }
                }
                // widgets_values 里图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
                let raw;
                for (const entry of (n.widgets_values || [])) {
                    if (typeof entry === "string" || Array.isArray(entry)) { raw = entry; break; }
                    if (entry && typeof entry === "object" && (entry.name || entry.filename)) { raw = entry; break; }
                }
                let v = "";
                if (typeof raw === "string") v = raw.trim();
                else if (Array.isArray(raw)) v = String(raw[0] ?? "").trim();
                else if (raw && typeof raw === "object") v = String(raw.name ?? raw.filename ?? "").trim();
                if (!v) {
                    skipped.push(`节点#${n.id}: empty`);
                    continue;
                }
                // [input]/[output] 标注不参与扩展名判断
                const base = v.replace(/\[[^\]]*\]\s*$/, "").trim();
                if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(base)) {
                    skipped.push(`节点#${n.id}: ${v}`);
                    continue;
                }
                const pictureNo = computePictureNo(n);
                (pictureNo != null ? connected : unconnected).push({ value: v, nodeId: n.id, pictureNo });
            }
            if (skipped.length) console.info("[Neo] @ 图片选择器跳过的加载节点:", skipped);
            return [...connected, ...unconnected];
        } catch (e) {
            console.warn("collectWorkflowLoadImages:", e);
            return [];
        }
        })();
    }

    // 估算 textarea 光标距内容区左上角的像素坐标（用于把 @ 弹层定位到光标附近）
    function getCaretPixel(el) {
        const mirror = mkEl("div");
        const cs = window.getComputedStyle(el);
        for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle",
                         "letterSpacing", "lineHeight", "textTransform", "wordSpacing",
                         "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                         "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
                         "boxSizing", "width"]) {
            mirror.style[p] = cs[p];
        }
        mirror.style.position = "absolute";
        mirror.style.left = "-99999px";
        mirror.style.top = "0";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.wordWrap = "break-word";
        mirror.style.overflowWrap = "break-word";
        mirror.style.visibility = "hidden";
        const before = mkEl("span");
        before.textContent = el.value.slice(0, el.selectionStart);
        const marker = mkEl("span");
        marker.textContent = "\u200b"; // 零宽空格占位，测光标位置
        mirror.appendChild(before);
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const mRect = marker.getBoundingClientRect();
        const m0 = mirror.getBoundingClientRect();
        document.body.removeChild(mirror);
        return { x: mRect.left - m0.left, y: mRect.top - m0.top };
    }

    async function openAtImagePicker() {
        if (quickInputWrapper.querySelector(".rs-at-picker")) return;
        // @ 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入图片标记
        const sel = quickInput.selectionStart || 0;
        const atIndex = sel - 1;
        if (atIndex < 0 || quickInput.value[atIndex] !== "@") return;
        const images = await collectWorkflowLoadImages();
        // await 期间用户可能改动了输入：@ 不在原位置则放弃
        if (quickInput.value[atIndex] !== "@") return;

        // 点击行即插入：已附加的图片引用现有 <Picture N>，未附加的先添加再插入，然后关闭弹层
        const insertImageAtCaret = (img) => {
            if (!img || quickInput.value[atIndex] !== "@") { closePicker(); return; }
            // 无参数位（输出未连接）：仅作为反推附件附加，不占用 <Picture N> 编号
            if (img.pictureNo == null) {
                addImageInput(img.value); // 内部判重，已附加则忽略
                closePicker();
                return;
            }
            // 有参数位：确保已附加（chips 用于发送 payload），插入其参数序号标记
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (existIdx < 0) addImageInput(img.value, null, img.pictureNo);
            const marker = "<Picture " + img.pictureNo + ">";
            quickInput.value = quickInput.value.slice(0, atIndex) + marker + quickInput.value.slice(atIndex + 1);
            // 焦点回到输入框并停在插入标记之后，方便继续输入
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(atIndex + marker.length, atIndex + marker.length);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            closePicker();
        };

        const picker = mkEl("div", "rs-at-picker");
        const list = mkEl("div", "rs-at-picker-list");

        // 弹层无标题栏：无可用图片时在列表内给占位提示
        if (!images.length) {
            const empty = mkEl("div", "rs-at-picker-empty");
            empty.textContent = "工作流中没有可用的 Load Image 图片";
            list.appendChild(empty);
        }

        images.forEach(img => {
            const row = mkEl("div", "rs-at-picker-row");
            row.style.position = "relative";

            const thumb = mkEl("img", "rs-at-picker-thumb");
            thumb.src = inputViewUrl(img.value);

            row.addEventListener("click", () => insertImageAtCaret(img));

            // 徽章语义：
            // - 有参数位（pictureNo）：蓝色 #N，点击插入/引用 <Picture N>
            // - 无参数位但已附加：灰色 ✓，点击无操作（仅作反推附件）
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (img.pictureNo != null) {
                const picBadge = mkEl("span", "rs-picker-pic-badge");
                picBadge.textContent = `#${img.pictureNo}`;
                row.append(thumb, picBadge);
            } else if (existIdx >= 0) {
                const refBadge = mkEl("span", "rs-picker-ref-badge");
                refBadge.textContent = "✓";
                row.append(thumb, refBadge);
            } else {
                row.append(thumb);
            }
            list.appendChild(row);
        });

        picker.append(list);
        // 挂到 body 并用 fixed 定位：quickInputWrapper 的 overflow 会裁剪内部弹层
        document.body.appendChild(picker);

        // ==========================================
        // 键盘导航：↑/↓ 移动高亮，Enter 插入当前项，Esc 关闭
        // ==========================================
        picker.tabIndex = 0;
        let activeIndex = 0;
        const rowEls = Array.from(list.querySelectorAll(".rs-at-picker-row"));
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls.length - 1, idx));
            rowEls.forEach((r, i) => {
                r.classList.toggle("rs-picker-row-active", i === activeIndex);
            });
            const activeEl = rowEls[activeIndex];
            // 只滚动列表内部，避免 scrollIntoView 连带滚动祖先/页面导致弹层整体偏离
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) {
                    list.scrollTop = rowTop;
                } else if (rowBottom > listBottom) {
                    list.scrollTop = rowBottom - list.clientHeight;
                }
            }
        };
        rowEls.forEach((row, idx) => {
            row.classList.add("rs-picker-row");
            row.addEventListener("mousemove", () => setActiveRow(idx));
        });
        picker.addEventListener("keydown", (e) => {
            // 阻断冒泡，避免 ComfyUI 全局键盘处理器（画布平移等）响应这些按键导致弹层偏离输入框
            if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", " ", "Enter"].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
            switch (e.key) {
                case "ArrowDown":
                    setActiveRow(activeIndex + 1);
                    break;
                case "ArrowUp":
                    setActiveRow(activeIndex - 1);
                    break;
                case "Home":
                    setActiveRow(0);
                    break;
                case "End":
                    setActiveRow(rowEls.length - 1);
                    break;
                case "Enter":
                    insertImageAtCaret(images[activeIndex]);
                    break;
            }
        });
        // 打开后聚焦到 picker，让键盘立即可用，同时保留 Esc 全局处理
        picker.focus({ preventScroll: true });
        setTimeout(() => setActiveRow(0), 0);

        let handleEsc = null;
        let handleInputChange = null;
        const closePicker = () => {
            document.removeEventListener("mousedown", onOutside);
            if (handleEsc) document.removeEventListener("keydown", handleEsc);
            if (handleInputChange) quickInput.removeEventListener("input", handleInputChange);
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target)) closePicker();
        };
        setTimeout(() => document.addEventListener("mousedown", onOutside), 0);

        // 锚定到 @ 所在光标位置附近（支持在文本中间插入时跟随 @）。
        // 同步读取坐标并在同一次布局内计算定位，避免 rAF 延迟到下一帧导致缩放/布局变化偏移。
        const r = quickInput.getBoundingClientRect();
        const caret0 = getCaretPixel(quickInput);
        // 计算元素所在缩放容器的实际缩放比例：getBoundingClientRect 返回层叠后的屏幕坐标，
        // 而 getCaretPixel 的镜像测量返回 CSS 内容坐标。两者不一致时按比例校正，抵消画布缩放偏移。
        const elW = quickInput.offsetWidth || r.width;
        const elH = quickInput.offsetHeight || r.height;
        const scaleX = elW ? r.width / elW : 1;
        const scaleY = elH ? r.height / elH : scaleX;
        const caret = { x: caret0.x * scaleX, y: caret0.y * scaleY };
        const cs = window.getComputedStyle(quickInput);
        const bLeft = parseFloat(cs.borderLeftWidth) || 0;
        const bTop = parseFloat(cs.borderTopWidth) || 0;
        const pw = Math.min(Math.max(r.width, 50), 80); // 限制宽度在 50-80px 之间
        const estHeight = 260;
        let left = r.left + bLeft + caret.x - quickInput.scrollLeft;
        let top = r.top + bTop + caret.y + 20 - quickInput.scrollTop; // 默认在其下方
        // 水平：优先让弹层显示在 @ 右侧，超视口则靠右对齐
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
        // 垂直：下方放不下则翻到上方
        if (top + estHeight > window.innerHeight - 8) {
            top = r.top + bTop + caret.y - 14 - estHeight;
        }
        picker.style.left = Math.max(8, left) + "px";
        picker.style.top = Math.max(8, top) + "px";
        picker.style.width = pw + "px";

        // ESC 键关闭选择器
        handleEsc = (e) => {
            if (e.key === "Escape") closePicker();
        };
        document.addEventListener("keydown", handleEsc);

        // 监听输入框变化，如果 @ 被删除（选择器将失去对应锚点）则关闭
        handleInputChange = () => {
            if (quickInput.value[atIndex] !== "@") closePicker();
        };
        quickInput.addEventListener("input", handleInputChange);

        cancelBtn.addEventListener("click", closePicker);
        okBtn.addEventListener("click", () => {
            if (!selected.length) { closePicker(); return; }
            // 编号顺序由工作流 Load Image 节点参数顺序决定（images 顺序），而非点击顺序。
            // 已附加的图片只做引用（插入现有编号），未附加的才真正添加。
            const markers = [];
            images.forEach(img => {
                if (!selected.includes(img.value)) return;
                const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
                if (existIdx >= 0) {
                    markers.push("<Picture " + (existIdx + 1) + ">");
                    return;
                }
                addImageInput(img.value);
                markers.push("<Picture " + attachedImages.length + ">");
            });
            // 在 @ 所在位置替换成内联 <Picture N> 标记（编号与 chips 一致），用于描述图片间交互
            if (quickInput.value[atIndex] === "@" && markers.length) {
                const joined = markers.join(" ");
                quickInput.value = quickInput.value.slice(0, atIndex) + joined + quickInput.value.slice(atIndex + 1);
                // 光标放到插入标记之后
                quickInput.setSelectionRange(atIndex + joined.length, atIndex + joined.length);
                quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
            closePicker();
        });
    }

    // 图片选择按钮（+）
    const attachBtn = mkEl("button", "rs-attach-btn");
    attachBtn.textContent = "+";
    attachBtn.title = "附加图片（反推/多模态 skill）";
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        Array.from(fileInput.files || []).forEach(addImageFile);
        fileInput.value = "";
    });

    const CATEGORY_LABELS = {
        "vision": { label: "🖼️ 图像 / 反推", order: 0 },
        "task": { label: "⚙️ 任务", order: 1 },
        "style": { label: "🎨 风格模板", order: 2 },
        "custom": { label: "📝 自定义", order: 3 }
    };

    /** 从起始节点出发做 BFS，返回同一连通分量的所有节点 */
    function getConnectedNodes(startNode) {
        if (!startNode || !app.graph?._nodes) return null;
        const allNodes = app.graph._nodes;
        const visited = new Set();
        const queue = [startNode.id];
        visited.add(startNode.id);
        while (queue.length > 0) {
            const curId = queue.shift();
            const cur = allNodes.find(n => n.id === curId);
            if (!cur) continue;
            // 遍历输出 → 下游节点
            for (let si = 0; si < (cur.outputs || []).length; si++) {
                const links = cur.outputs[si].links || [];
                for (const linkId of links) {
                    const link = app.graph.links?.[linkId];
                    if (link && !visited.has(link.target_id)) {
                        visited.add(link.target_id);
                        queue.push(link.target_id);
                    }
                }
            }
            // 遍历输入 ← 上游节点
            for (let si = 0; si < (cur.inputs || []).length; si++) {
                const linkId = cur.inputs[si]?.link;
                if (linkId && app.graph.links?.[linkId]) {
                    const lnk = app.graph.links[linkId];
                    if (!visited.has(lnk.origin_id)) {
                        visited.add(lnk.origin_id);
                        queue.push(lnk.origin_id);
                    }
                }
            }
        }
        return allNodes.filter(n => visited.has(n.id));
    }

    /** 自动检测当前工作流的上下文（CLIP类型、模型类型），返回 context tags 集合 */
    function detectWorkflowContext(startNode) {
        const ctx = new Set();
        let nodes;
        if (startNode) {
            const connected = getConnectedNodes(startNode);
            nodes = connected || [startNode];
        } else {
            nodes = app.graph?._nodes;
        }
        nodes.forEach(node => {
            // CLIPLoader: widget "type" is the CLIP type (e.g. "krea2", "minimax")
            if (node.type === "CLIPLoader" || node.comfyClass === "CLIPLoader") {
                const typeWidget = node.widgets?.find(w => w.name === "type");
                if (typeWidget) ctx.add(String(typeWidget.value || "").toLowerCase());
            }
            // UNETLoader / VAELoader: collect model name widget value
            const modelNameWidget = node.widgets?.find(w => w.name === "model_name" || w.name === "vae_name" || w.name === "ckpt_name");
            if (modelNameWidget) {
                ctx.add(String(modelNameWidget.value || "").toLowerCase());
            }
            // Add the full node title for broader tag matching
            const title = String(node.title || "").trim();
            if (title && title !== node.type) {
                ctx.add(title.toLowerCase());
            }
        });
        return ctx;
    }

    // debounce: per-node timer to avoid duplicate calls from multiple init paths
    const _populateTimer = new Map();

    async function populateTemplateSelector(startNode = null) {
        const node = startNode;
        if (node && _populateTimer.has(node.id)) {
            clearTimeout(_populateTimer.get(node.id));
        }
        return new Promise(resolve => {
            _populateTimer.set(node.id, setTimeout(() => {
                _populateTimer.delete(node.id);
                Promise.resolve(doPopulate(startNode)).then(resolve, resolve);
            }, 50));
        });
    }

    async function doPopulate(startNode = null) {
        const skills = await listSkills();
        const currentVal = tplSelector.value;
        // 自动检测工作流上下文并预筛选/预选择最佳 skill
        const detectedCtx = detectWorkflowContext(startNode);
        let bestMatchId = null;
        if (detectedCtx.size > 0) {
            let bestScore = -1;
            skills.forEach(s => {
                const skillTags = (s.tags || []).map(t => String(t).toLowerCase());
                // 子串 + 分词双向匹配
                const matched = [];
                [...detectedCtx].forEach(tag => {
                    skillTags.forEach(st => {
                        if (tag.includes(st) || st.includes(tag)) {
                            if (!matched.includes(st)) matched.push(st);
                        } else {
                            const words = tag.split(/[\s\-_/\\]+/).filter(w => w.length > 0);
                            if (words.some(w => st.includes(w) || w.includes(st))) {
                                if (!matched.includes(st)) matched.push(st);
                            }
                        }
                    });
                });
                const score = matched.length;
                if (score > 0) {
                    console.log(`[PromptManager] skill=${s.id} matchTags=[${matched.join(",")}]`);
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestMatchId = s.id;
                }
            });
        }
        tplSelector.innerHTML = "";

        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "默认";
        tplSelector.appendChild(defaultOpt);

        if (skills) {
            // 按 category 分组
            const groups = {};
            skills.forEach(s => {
                const cat = CATEGORY_LABELS[s.category] ? s.category : "style";
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(s);
            });
            Object.keys(groups).sort((a, b) =>
                (CATEGORY_LABELS[a]?.order ?? 99) - (CATEGORY_LABELS[b]?.order ?? 99)
            ).forEach(cat => {
                const optgroup = document.createElement("optgroup");
                optgroup.label = CATEGORY_LABELS[cat].label;
                groups[cat].forEach(s => {
                    const opt = document.createElement("option");
                    opt.value = s.id;
                    const imgBadge = s.needs_image ? "📷 " : "";
                    const pin = s.source === "presets" ? " 📌" : "";
                    opt.textContent = `${imgBadge}${s.name || s.id}${pin}`;
                    optgroup.appendChild(opt);
                });
                tplSelector.appendChild(optgroup);
            });
        }

        if (currentVal && [...tplSelector.options].some(o => o.value === currentVal)) {
            tplSelector.value = currentVal;
        } else if (bestMatchId && [...tplSelector.options].some(o => o.value === bestMatchId)) {
            // 工作流上下文匹配到 skill，自动选中
            tplSelector.value = bestMatchId;
        }

        // Programmatic value assignment does not fire change events;
        // dispatch one so node listeners sync the template_id hidden input used by queue runs.
        tplSelector.dispatchEvent(new Event("change"));
    }
    
    const settingsBtn = mkEl("button", "rs-settings-btn");
    settingsBtn.textContent = "⚙️";
    settingsBtn.setAttribute("data-rs-tooltip", "Model settings");
    
    statusBar.appendChild(toggleWrapper);

    const randomBtn = mkEl("button", "rs-random-btn");
    randomBtn.textContent = "🎲";
    randomBtn.setAttribute("data-rs-tooltip", "Random prompt");

    const listBtn = mkEl("button", "rs-list-btn");
    listBtn.textContent = "☰";
    listBtn.setAttribute("data-rs-tooltip", "Preset list");

    const quickInputWrapper = mkEl("div", "rs-quick-input-wrapper");

    // Note: randomBtn, listBtn are NOT added to quickInputWrapper here.
    // They will be placed in topRightBtnGroup by createPromptManagerUI().

    const quickInput = document.createElement("textarea");
    quickInput.className = "rs-quick-input";
    quickInput.placeholder = 'Describe what you want... (Enter to generate, Shift+Enter for newline)';
    quickInput.rows = 2;

    let tipInterval = null;

    function startTipRotation() {
        stopTipRotation();
        tipInterval = setInterval(() => {
            if (!quickInput.value.trim()) {
                quickInput.placeholder = getRandomTip();
            }
        }, 5000);
    }

    function stopTipRotation() {
        if (tipInterval) {
            clearInterval(tipInterval);
            tipInterval = null;
        }
    }

    quickInput.addEventListener("focus", () => {
        quickInput.placeholder = getRandomTip();
        startTipRotation();
    });

    quickInput.addEventListener("blur", () => {
        stopTipRotation();
        if (!quickInput.value.trim()) {
            quickInput.placeholder = getRandomTip();
        }
    });

    // Create input toolbar (chat-like experience)
    const inputToolbar = mkEl("div", "rs-input-toolbar");

    const generateBtn = mkEl("button", "rs-generate-btn");
    generateBtn.textContent = "✨";
    generateBtn.setAttribute("data-rs-tooltip", "Generate from description");

    // Auto-generate checkbox (left of generate button)
    const autoGenerateWrapper = mkEl("div", "rs-auto-generate-wrapper");
    const autoGenerateCheckbox = document.createElement("input");
    autoGenerateCheckbox.type = "checkbox";
    autoGenerateCheckbox.className = "rs-auto-generate-checkbox";
    autoGenerateCheckbox.id = "rs-auto-generate";
    autoGenerateCheckbox.setAttribute("data-rs-tooltip", "Auto-generate prompt when workflow runs");
    const autoGenerateLabel = document.createElement("label");
    autoGenerateLabel.htmlFor = "rs-auto-generate";
    autoGenerateLabel.className = "rs-auto-generate-label";
    autoGenerateLabel.textContent = "自动生成";
    autoGenerateWrapper.appendChild(autoGenerateCheckbox);
    autoGenerateWrapper.appendChild(autoGenerateLabel);

    // Add elements to toolbar
    inputToolbar.appendChild(attachBtn);
    inputToolbar.appendChild(tplSelector);
    inputToolbar.appendChild(settingsBtn);
    const spacer = mkEl("div", "rs-spacer");
    inputToolbar.appendChild(spacer);
    inputToolbar.appendChild(autoGenerateWrapper);
    inputToolbar.appendChild(generateBtn);

    // Add input and toolbar to wrapper
    quickInputWrapper.appendChild(imageChipsRow);
    quickInputWrapper.appendChild(quickInput);
    quickInputWrapper.appendChild(inputToolbar);
    quickInputWrapper.appendChild(fileInput);

    // 粘贴图片直接附加（反推）
    quickInput.addEventListener("paste", (e) => {
        const files = imagesFromClipboard(e);
        if (files.length) {
            e.preventDefault();
            files.forEach(addImageFile);
        }
    });

    // 拖拽图片到输入框附加
    quickInputWrapper.addEventListener("dragover", (e) => e.preventDefault());
    quickInputWrapper.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        files.forEach(addImageFile);
    });

    // 输入 @ 唤起工作流图片选择器（支持在文本中间插入：看光标前一个字符）
    quickInput.addEventListener("input", () => {
        const caret = quickInput.selectionStart;
        if (caret > 0 && quickInput.value[caret - 1] === "@") openAtImagePicker();
    });

    const customTextarea = document.createElement("textarea");
    customTextarea.className = "comfy-multiline-input";
    customTextarea.placeholder = "Enter your prompt here...";

    const buttonsWrapper = mkEl("div", "rs-buttons-wrapper");
    
    const actionRow = mkEl("div", "rs-btn-row rs-action-row");

    const saveBtn = mkEl("button", "rs-btn rs-action-btn");
    saveBtn.textContent = "💾";
    saveBtn.setAttribute("data-rs-tooltip", "Save as preset");

    // Note: saveBtn is NOT added to actionRow here.
    // It will be placed in topRightBtnGroup by createPromptManagerUI().
    buttonsWrapper.appendChild(actionRow);

    return { statusBar, quickInputWrapper, randomBtn, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, settingsBtn, toggleSwitch, localTab, externalTab, tplSelector, populateTemplateSelector, actionRow, autoGenerateCheckbox, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker };
}

// ==========================================
// Main UI factory
// ==========================================

function createPromptManagerUI() {
    const { statusBar, quickInputWrapper, randomBtn, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, settingsBtn, toggleSwitch, localTab, externalTab, tplSelector, populateTemplateSelector, actionRow, autoGenerateCheckbox, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker } = createStatusBars();
    const { overlay: presetListOverlay, body: presetListBody, searchBar: presetSearchBar } = createOverlayWithSearch();
    const { modal: presetNameInput, aiStatus, field: inputField, tagsContainer, selectedTags, okBtn: inputOk, cancelBtn: inputCancel } = createInputModal();
    const { modal: deleteConfirmOverlay, textDiv: deleteText, okBtn: deleteOk, cancelBtn: deleteCancel } = createDeleteModal();
    const downloadModal = createDownloadModal();
    const settingsModal = createSettingsModal();

    const root = mkEl("div", "rs-root");

    root.appendChild(statusBar);
    // Preset list overlay - positioned as a centered panel (not dropdown)
    root.appendChild(presetListOverlay);

    // Create wrapper for custom textarea and buttons
    const customTextareaWrapper = mkEl("div", "rs-custom-textarea-wrapper");
    customTextareaWrapper.appendChild(customTextarea);
    
    // Create button group wrapper
    const buttonGroup = mkEl("div", "rs-button-group");
    buttonGroup.appendChild(randomBtn);
    buttonGroup.appendChild(listBtn);
    buttonGroup.appendChild(saveBtn);
    customTextareaWrapper.appendChild(buttonGroup);
    
    root.appendChild(customTextareaWrapper);

    root.appendChild(buttonsWrapper);
    // quickInputWrapper at the bottom of the node
    root.appendChild(quickInputWrapper);

    root.appendChild(presetNameInput);
    root.appendChild(deleteConfirmOverlay);
    root.appendChild(downloadModal.modal);
    root.appendChild(settingsModal.overlay);
    root.appendChild(settingsModal.modal);

    presetListBody.style.scrollbarWidth = "thin";
    presetListBody.style.scrollbarColor = "#5090cc #1a1a1a";

    let pendingDeleteName = null;
    let context = null;
    let isLoading = false;
    let isListOpen = false;


        function triggerTextChange() {
            if (customTextarea) {
                customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }

    function init(ctx) {
        context = ctx;
        const { node, graph, textWidget } = ctx;

        // 不再在这里触发，由 prompts.js 统一管理时序

        function handleSaveClick() {
            presetListOverlay.style.display = "none";
            deleteConfirmOverlay.style.display = "none";
            presetNameInput.style.display = "block";
            inputField.value = "";
            setTimeout(() => inputField.focus(), 50);

            selectedTags.clear();
            const tagButtons = tagsContainer.querySelectorAll(".rs-tag-btn");
            tagButtons.forEach(btn => {
                btn.classList.remove("rs-tag-selected");
            });

            const currentText = textWidget?.value || "";

            if (currentText.trim()) {
                saveBtn.disabled = true;
                aiStatus.className = "rs-ai-status processing";
                aiStatus.innerHTML = "⏳ AI 正在分析提示词...";

                Promise.all([
                    extractTitle(currentText),
                    extractClassify(currentText)
                ]).then(([dataTitle, dataClassify]) => {
                    if (dataTitle.status === "success") {
                        inputField.value = dataTitle.title;
                    }

                    if (dataClassify.status === "success" && dataClassify.classify) {
                        const classifyText = dataClassify.classify.trim();
                        const classifyList = classifyText.split(/[,，]/).map(s => s.trim()).filter(s => s);

                        tagButtons.forEach(btn => {
                            const btnText = btn.textContent.trim();
                            if (classifyList.includes(btnText)) {
                                selectedTags.add(btnText);
                                btn.classList.add("rs-tag-selected");
                            }
                        });
                        aiStatus.className = "rs-ai-status success";
                        aiStatus.innerHTML = "✅ AI 分析完成";
                    } else {
                        aiStatus.className = "rs-ai-status error";
                        aiStatus.innerHTML = "❌ AI 分析失败，请手动填写";
                    }
                }).catch(e => {
                    console.error("Auto-extract error:", e);
                }).finally(() => {
                    saveBtn.disabled = false;
                });
            }
        }

        function performSave() {
            const name = inputField.value.trim();
            if (!name) return;
            presetNameInput.style.display = "none";
            const tags = Array.from(selectedTags);
            savePrompt(name, textWidget ? textWidget.value : "", tags);
        }

        async function loadPresetDropdown() {
            if (isLoading) return;
            isLoading = true;
            
            presetListBody.innerHTML = "";

            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);

            try {
                const list = await listPrompts();

                if (loadingDiv.parentNode) loadingDiv.remove();

                if (!list.length) {
                    presetListBody.textContent = "No presets found";
                    isLoading = false;
                    return;
                }

                list.forEach(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    const source = typeof item === 'object' ? item.source : "custom";

                    const row = document.createElement("div");
                    row.className = "rs-preset-item";
                    row.dataset.name = name;

                    const leftDiv = mkEl("div", "rs-preset-left");
                    const contentSpan = mkEl("span", "rs-preset-content");
                    const displayText = tags && tags.length > 0 ? `${name} [${tags.join(", ")}]` : name;

                    if (tags && tags.length > 0) {
                        contentSpan.textContent = name;
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    } else {
                        contentSpan.textContent = name;
                    }

                    const sourceBadge = mkEl("span", "rs-source-badge");
                    sourceBadge.textContent = source === "presets" ? "SYS" : "USR";
                    sourceBadge.title = source === "presets" ? "System preset (cannot delete)" : "User preset";
                    contentSpan.appendChild(sourceBadge);

                    contentSpan.dataset.original = displayText;
                    row.dataset.original = displayText;
                    leftDiv.appendChild(contentSpan);
                    row.appendChild(leftDiv);

                    row.onclick = async (e) => {
                        if (e.target.closest(".rs-delete-icon")) return;

                        const data = await loadPrompt(name);

                        if (textWidget) {
                            textWidget.value = data.text || "";
                        }
                        if (customTextarea) {
                            customTextarea.value = data.text || "";
                            triggerTextChange();
                        }

                        const currentUid = node.properties.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                        // In-memory cache only - no localStorage

                        presetListOverlay.style.display = "none";
                        if (graph) graph.setDirtyCanvas(true, true);
                    };

                    if (source === "custom") {
                        const deleteBtn = mkEl("span", "rs-delete-icon");
                        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                        deleteBtn.setAttribute("aria-label", "Delete preset");
                        deleteBtn.onclick = async (e) => {
                            e.stopPropagation();
                            pendingDeleteName = name;
                            deleteText.textContent = `Delete "${name}"?`;
                            deleteConfirmOverlay.style.display = "block";
                        };
                        row.appendChild(deleteBtn);
                    }

                    presetListBody.appendChild(row);
                });
            } catch (e) {
                presetListBody.textContent = "Error loading";
            } finally {
                isLoading = false;
            }
        }

        function filterDropdownByInput(query) {
            presetListBody.innerHTML = "";

            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Searching...";
            presetListBody.appendChild(loadingDiv);

            setTimeout(async () => {
                if (loadingDiv.parentNode) loadingDiv.remove();

                const list = await listPrompts();
                const queryLower = query.toLowerCase();
                const matched = list.filter(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    return name.toLowerCase().includes(queryLower) || 
                           tags.some(t => t.toLowerCase().includes(queryLower));
                });

                if (!matched.length) {
                    presetListBody.innerHTML = "";
                    return;
                }

                matched.forEach(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    const source = typeof item === 'object' ? item.source : "custom";

                    const row = document.createElement("div");
                    row.className = "rs-preset-item";
                    row.dataset.name = name;

                    const leftDiv = mkEl("div", "rs-preset-left");
                    const contentSpan = mkEl("span", "rs-preset-content");
                    const displayText = tags && tags.length > 0 ? `${name} [${tags.join(", ")}]` : name;

                    if (tags && tags.length > 0) {
                        contentSpan.textContent = name;
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    } else {
                        contentSpan.textContent = name;
                    }

                    const regex = new RegExp(`(${query})`, "gi");
                    const highlightedName = name.replace(regex, '<span class="rs-match-highlight">$1</span>');
                    contentSpan.innerHTML = highlightedName;

                    if (tags && tags.length > 0) {
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    }

                    contentSpan.dataset.original = displayText;
                    row.dataset.original = displayText;
                    leftDiv.appendChild(contentSpan);
                    row.appendChild(leftDiv);

                    row.onclick = async (e) => {
                        if (e.target.closest(".rs-delete-icon")) return;

                        const data = await loadPrompt(name);

                        if (textWidget) {
                            textWidget.value = data.text || "";
                        }
                        if (customTextarea) {
                            customTextarea.value = data.text || "";
                            triggerTextChange();
                        }

                        const currentUid = node.properties.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                        // In-memory cache only - no localStorage

                        presetListOverlay.style.display = "none";
                        if (graph) graph.setDirtyCanvas(true, true);
                    };

                    if (source === "custom") {
                        const deleteBtn = mkEl("span", "rs-delete-icon");
                        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                        deleteBtn.setAttribute("aria-label", "Delete preset");
                        deleteBtn.onclick = async (e) => {
                            e.stopPropagation();
                            pendingDeleteName = name;
                            deleteText.textContent = `Delete "${name}"?`;
                            deleteConfirmOverlay.style.display = "block";
                        };
                        row.appendChild(deleteBtn);
                    }

                    presetListBody.appendChild(row);
                });
            }, 100);
        }

        async function loadPromptList() {
            presetNameInput.style.display = "none";
            deleteConfirmOverlay.style.display = "none";
            presetListBody.innerHTML = "";
            presetListOverlay.style.display = "flex";

            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);

            try {
                const list = await listPrompts();

                if (loadingDiv.parentNode) loadingDiv.remove();

                if (!list.length) {
                    presetListBody.textContent = "No presets found";
                    return;
                }

                list.forEach(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    const source = typeof item === 'object' ? item.source : "custom";

                    const row = document.createElement("div");
                    row.className = "rs-preset-item";
                    row.dataset.name = name;

                    const leftDiv = mkEl("div", "rs-preset-left");
                    const contentSpan = mkEl("span", "rs-preset-content");
                    const displayText = tags && tags.length > 0 ? `${name} [${tags.join(", ")}]` : name;

                    if (tags && tags.length > 0) {
                        contentSpan.textContent = name;
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    } else {
                        contentSpan.textContent = name;
                    }

                    const sourceBadge = mkEl("span", "rs-source-badge");
                    sourceBadge.textContent = source === "presets" ? "SYS" : "USR";
                    sourceBadge.title = source === "presets" ? "System preset (cannot delete)" : "User preset";
                    contentSpan.appendChild(sourceBadge);

                    contentSpan.dataset.original = displayText;
                    row.dataset.original = displayText;
                    leftDiv.appendChild(contentSpan);
                    row.appendChild(leftDiv);

                    row.onclick = async (e) => {
                        if (e.target.closest(".rs-delete-icon")) return;

                        const data = await loadPrompt(name);

                        if (textWidget) {
                            textWidget.value = data.text || "";
                        }
                        if (customTextarea) {
                            customTextarea.value = data.text || "";
                            triggerTextChange();
                        }

                        const currentUid = node.properties.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                        // In-memory cache only - no localStorage

                        presetListOverlay.style.display = "none";
                        if (graph) graph.setDirtyCanvas(true, true);
                    };

                    if (source === "custom") {
                        const deleteBtn = mkEl("span", "rs-delete-icon");
                        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                        deleteBtn.setAttribute("aria-label", "Delete preset");
                        deleteBtn.onclick = async (e) => {
                            e.stopPropagation();
                            pendingDeleteName = name;
                            deleteText.textContent = `Delete "${name}"?`;
                            deleteConfirmOverlay.style.display = "block";
                        };
                        row.appendChild(deleteBtn);
                    }

                    presetListBody.appendChild(row);
                });
            } catch (e) {
                presetListBody.textContent = "Error loading";
            }
        }

        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            handleSaveClick();
        }, true);

        // Preset list search bar - filter items in real-time
        presetSearchBar.addEventListener("input", () => {
            const query = presetSearchBar.value.trim().toLowerCase();
            if (!query) {
                // Show all items
                const items = presetListBody.querySelectorAll(".rs-preset-item");
                items.forEach(item => item.style.display = "");
                return;
            }
            const items = presetListBody.querySelectorAll(".rs-preset-item");
            items.forEach(item => {
                const name = (item.querySelector(".rs-preset-content")?.textContent || "").toLowerCase();
                item.style.display = name.includes(query) ? "" : "none";
            });
        });

        listBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (presetListOverlay.style.display === "flex") {
                presetListOverlay.style.display = "none";
                isListOpen = false;
            } else {
                loadPresetDropdown();
                presetListOverlay.style.display = "flex";
                isListOpen = true;
            }
        });

        document.addEventListener("mousedown", (e) => {
            if (!buttonGroup.contains(e.target) && !presetListOverlay.contains(e.target)) {
                presetListOverlay.style.display = "none";
                isListOpen = false;
            }
        });

        inputOk.addEventListener("click", performSave);
        inputCancel.addEventListener("click", () => {
            presetNameInput.style.display = "none";
        });
        inputField.addEventListener("keydown", (e) => {
            if (e.key === "Enter") performSave();
            if (e.key === "Escape") presetNameInput.style.display = "none";
        });

        deleteOk.addEventListener("click", async () => {
            if (pendingDeleteName) {
                await deletePrompt(pendingDeleteName);
                deleteConfirmOverlay.style.display = "none";
                if (!quickInput.value.trim()) {
                    loadPresetDropdown();
                }
                pendingDeleteName = null;
            }
        });

        deleteCancel.addEventListener("click", () => {
            deleteConfirmOverlay.style.display = "none";
            pendingDeleteName = null;
        });

        downloadModal.downloadBtn.addEventListener("click", async () => {
            downloadModal.downloadBtn.disabled = true;
            downloadModal.downloadBtn.textContent = "⏳ Starting...";
            
            const result = await downloadModel("model");
            if (result.error) {
                downloadModal.statusText.textContent = "Failed to start download: " + result.error;
                downloadModal.statusText.style.color = "#f87171";
                downloadModal.downloadBtn.disabled = false;
                downloadModal.downloadBtn.textContent = "🔄 Retry Download";
                return;
            }
            
            downloadModal.progressContainer.style.display = "block";
            downloadModal.downloadBtn.style.display = "none";
            downloadModal.cancelBtn.style.display = "none";
            downloadModal.closeBtn.style.display = "none";
            downloadModal.statusText.textContent = "Download started...";
            downloadModal.statusText.style.color = "#999";
            
            monitorDownloadProgress(downloadModal, statusBar);
        });

        downloadModal.cancelBtn.addEventListener("click", () => {
            downloadModal.modal.style.display = "none";
        });

        downloadModal.closeBtn.addEventListener("click", () => {
            downloadModal.modal.style.display = "none";
        });

        let downloadPollInterval = null;
        
        function stopDownloadPolling() {
            if (downloadPollInterval) {
                clearInterval(downloadPollInterval);
                downloadPollInterval = null;
            }
        }
        
        async function loadModelsIntoSettings() {
            try {
                stopDownloadPolling();
                if (settingsModal.stopLocalModelStatusPoller) {
                    settingsModal.stopLocalModelStatusPoller();
                }
                const modelsData = await getAvailableModels();
                const allModelsStatus = await checkAllModels();
                const currentModelStatus = await checkModel();
                
                // Update settings modal status text if it exists
                if (settingsModal && settingsModal.statusText) {
                    settingsModal.modelList = settingsModal.modelList || document.createElement('div');
                }
            } catch (e) {
                console.error("Failed to load models:", e);
            }
        }

        settingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            
            if (settingsModal.modal.style.display === "flex") {
                settingsModal.modal.style.display = "none";
                settingsModal.overlay.style.display = "none";
                return;
            }
            
            let accumulatedTop = 0;
            let accumulatedLeft = 0;
            let currentEl = settingsBtn;
            
            while (currentEl && currentEl !== root) {
                accumulatedTop += currentEl.offsetTop || 0;
                accumulatedLeft += currentEl.offsetLeft || 0;
                currentEl = currentEl.offsetParent;
            }
            
            const btnHeight = settingsBtn.offsetHeight || 24;
            const modalHeight = settingsModal.modal.offsetHeight || 400;
            const topPos = accumulatedTop + (btnHeight / 2) - (modalHeight / 2);

            const leftPos = accumulatedLeft + settingsBtn.offsetWidth + 5;

            settingsModal.modal.style.position = "fixed";
            settingsModal.modal.style.zIndex = "999999";
            settingsModal.modal.style.top = topPos + "px";
            settingsModal.modal.style.left = leftPos + "px";
            settingsModal.modal.style.transform = "none";
            settingsModal.modal.style.margin = "0";
            settingsModal.modal.style.justifyContent = "flex-start";
            settingsModal.modal.style.alignItems = "flex-start";
            settingsModal.modal.style.opacity = "1";
            settingsModal.modal.style.visibility = "visible";

            settingsModal.overlay.style.display = "block";
            settingsModal.modal.style.display = "flex";
            
            loadModelsIntoSettings();
            loadRemoteLLMConfig(settingsModal);
        });
        
        settingsModal.overlay.addEventListener("click", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });
        
        settingsModal.modal.addEventListener("click", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        }, true);
        
        const closeSettingsModal = async () => {
            if (settingsModal.stopLocalModelStatusPoller) {
                settingsModal.stopLocalModelStatusPoller();
            }
            if (settingsModal.autoSaveConfig) {
                settingsModal.autoSaveConfig();
            }
            await new Promise(resolve => setTimeout(resolve, 350));
            settingsModal.modal.style.display = "none";
            settingsModal.overlay.style.display = "none";
        };
        
        const handleCloseClick = (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            closeSettingsModal();
        };
        
        settingsModal.closeBtn.addEventListener("mousedown", handleCloseClick, true);
        settingsModal.closeBtn.addEventListener("click", handleCloseClick, true);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && settingsModal.modal.style.display === "flex") {
                closeSettingsModal();
            }
        });

        return {
            statusBar,
            quickInputWrapper,
            generateBtn,
            randomBtn,
            listBtn,
            quickInput,
            customTextarea,
            settingsBtn,
            toggleSwitch,
            localTab,
            externalTab,
            saveBtn,
            presetListOverlay,
            presetNameInput,
            deleteConfirmOverlay,
            downloadModal,
            settingsModal,
            loadModelsIntoSettings,
            tplSelector,
            populateTemplateSelector,
            autoGenerateCheckbox,
            attachedImages,
            addImageFile,
            clearImages,
            attachBtn,
            imageChipsRow,
            openAtImagePicker
        };
    }

    return {
        root,
        init
    };
}

export {
    mkEl,
    createPromptManagerUI,
    createSettingsModal,
    loadRemoteLLMConfig
};
