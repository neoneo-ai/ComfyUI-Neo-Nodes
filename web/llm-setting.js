/**
 * llm-setting.js
 * LLM 配置表单：provider / model / API key / base URL / 本地模型目录 / 自动卸载。
 * 原设置弹窗的 “LLM Settings” 标签内容，现整体挂到「自动增强」菜单内。
 * createModelConfigForm() 返回 { el, load, save }：
 *   el   —— 表单 DOM（追加到宿主容器）
 *   load —— 读取已保存配置并回填（打开时调用）
 *   save —— 防抖保存当前表单值（关闭时调用）
 */

import { attachComboBox } from "./combo-box.js";
import { setCurrentModel } from "./prompt-service.js";

// DOM 元素工厂（与 prompt-manager.js 同实现，独立一份避免循环依赖）
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

// 字节数转人类可读大小（本地模型列表显示用）
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(bytes);
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    const rounded = i === 0 ? String(Math.round(size)) : Math.round(size * 10) / 10;
    return rounded + ' ' + units[i];
}

export function createModelConfigForm() {
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
    providerSelect.innerHTML = `
        <option value="local">Local GGUF (llama.cpp)</option>
        <option value="openai">OpenAI Compatible</option>
        <option value="lmstudio">LM Studio</option>
        <option value="ollama">Ollama</option>
        <option value="openrouter">OpenRouter</option>
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

    // 可搜索下拉已抽离为独立组件（web/combo-box.js）：原生 <select> 屏幕外作数据源，
    // 组件自动跟随其显隐/选项/取值变化；此处仅挂接两个模型选择器。
    const remoteModelBox = attachComboBox(modelSelectEl).box;
    const localModelBox = attachComboBox(localModelSelectEl).box;

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

    // Local models directory row (for Local GGUF - hidden by default)
    const localDirRow = mkEl("div", "rs-config-row");
    const localDirLabel = mkEl("label", "rs-form-label");
    localDirLabel.textContent = "LLM Models Dir";

    const localDirInput = mkEl("input", "rs-form-input rs-local-models-dir");
    localDirInput.type = "text";
    localDirInput.id = "rs-local-models-dir";
    localDirInput.placeholder = "Default: ComfyUI/models/LLM";

        localDirRow.appendChild(localDirLabel);
    localDirRow.appendChild(localDirInput);

    // Path convention hint
    const localDirHint = mkEl("div", "rs-form-hint");
    localDirHint.innerHTML = "📁 供应商(可选)/模型名称/模型文件(.gguf) · 同目录 mmproj 自动匹配";
    localDirHint.style.cssText = 'font-size:10px;color:#888;margin-top:2px;line-height:1.3;';
    localDirRow.appendChild(localDirHint);

    // 本地自动卸载复选框（工作流运行时本节点执行完成后可用）
    const localUnloadCheckbox = mkEl("input", "rs-form-checkbox");
    localUnloadCheckbox.type = "checkbox";
    localUnloadCheckbox.id = "rs-local-auto-unload";
    const localUnloadLabel = mkEl("label", "rs-form-label");
    localUnloadLabel.htmlFor = "rs-local-auto-unload";
    localUnloadLabel.textContent = "本节点执行完自动卸载本地模型";

    // 复选框与标签在同一行（rs-config-row 默认纵向布局，用内层 flex 行对齐）
    const localUnloadRow = mkEl("div", "rs-config-row rs-local-unload");
    const localUnloadLine = mkEl("div", "rs-local-unload-line");
    localUnloadLine.appendChild(localUnloadCheckbox);
    localUnloadLine.appendChild(localUnloadLabel);
    localUnloadRow.appendChild(localUnloadLine);

    const localUnloadHint = mkEl("div", "rs-form-hint");
    localUnloadHint.style.cssText = 'font-size:10px;color:#888;margin-top:2px;line-height:1.3;';
    localUnloadRow.appendChild(localUnloadHint);

    localDirRow.style.display = 'none';

    localUnloadRow.style.display = 'none';

    // Model row - contains text input, remote select, and local select
    const modelRowWrapper = mkEl("div", "rs-config-row");
    modelRowWrapper.id = "rs-model-input-wrapper";
    const modelLabel = mkEl("label", "rs-form-label");
    modelLabel.textContent = "Model";
    modelRowWrapper.appendChild(modelLabel);
    modelRowWrapper.appendChild(modelInput);
    modelRowWrapper.appendChild(remoteModelBox);
    // Append localModelSelectEl to DOM (hidden by default, shown for Local GGUF)
    modelRowWrapper.appendChild(localModelBox);

    // Provider save status indicator
    const providerSaveStatusText = mkEl("div", "rs-provider-save-status");
    providerSaveStatusText.textContent = "";
    providerSaveStatusText.style.display = "none";
    providerSaveStatusText.style.fontSize = "11px";
    providerSaveStatusText.style.color = "#999";

    remoteForm.append(remoteInfoText, providerRow, localDirRow, modelRowWrapper, apiKeyRow, baseUrlRow, providerSaveStatusText);
    // 自动卸载本地模型设置放在设置页最底部
    remoteForm.appendChild(localUnloadRow);

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
            const body = { base_url: baseUrl };
            // OpenAI Compatible / OpenRouter 的列表接口可能需要鉴权
            if (providerSelect.value === 'openai' || providerSelect.value === 'openrouter') {
                const key = apiKeyInput.value.trim();
                if (key) body.api_key = key;
            }
            const resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
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
            targetSelect.innerHTML = '<option value="">❌ 未加载</option>';
        } finally {
            targetSelect.disabled = false;
        }
    };

    // LM Studio / Ollama：根据远端模型列表回填/占位。未加载或加载失败时显示「未加载」，
    // 不回填可能来自其它 provider 的旧值（如 gpt-4o-mini）。
    const realRemoteOptions = () => Array.from(modelSelectEl.options).filter(o => o.value && o.value !== '__loading__');
    const applyRemoteSavedModel = (savedModel) => {
        const real = realRemoteOptions();
        if (!real.length) {
            modelSelectEl.innerHTML = '<option value="">❌ 未加载</option>';
            modelSelectEl.value = '';
            return;
        }
        const match = real.find(o => o.value === savedModel);
        modelSelectEl.value = match ? match.value : real[0].value;
    };

    const getModelValue = () => {
        const provider = providerSelect.value;
        if (provider === 'local') {
            return localModelSelectEl.value || '';
        } else if (provider === 'openai') {
            // 在线列表拉取成功时以下拉为准，否则以手动输入框为准
            const dropdownVisible = modelSelectEl.style.display !== 'none';
            return dropdownVisible ? (modelSelectEl.value || '') : modelInput.value;
        } else {
            // LM Studio / Ollama：下拉框为准，未加载时为空（不回填其它 provider 的 model）
            return modelSelectEl ? modelSelectEl.value : '';
        }
    };

    // OpenAI Compatible：尝试从 /v1/models 在线拉取列表；成功用下拉选择，失败回退手动输入
    const refreshOpenAIModelUI = async () => {
        const savedModel = savedRemoteConfig?.providers?.openai?.model || '';
        // base_url 为空时按官方 API 处理
        const baseUrl = baseUrlInput.value.trim() || 'https://api.openai.com/v1';
        await fetchModelsFromUrl(baseUrl, modelSelectEl);
        const real = realRemoteOptions();
        if (real.length) {
            const match = savedModel && real.find(o => o.value === savedModel);
            modelSelectEl.value = match ? match.value : real[0].value;
            modelSelectEl.style.setProperty('display', 'block', 'important');
            modelInput.style.setProperty('display', 'none', 'important');
        } else {
            // 拉取失败（网络/鉴权/非标准端点）：保留手动输入及已保存值
            modelSelectEl.style.setProperty('display', 'none', 'important');
            modelInput.style.setProperty('display', '', '');
            modelInput.value = savedModel;
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
                    const sz = m.file_size > 0 ? formatFileSize(m.file_size) : '';
                    opt.textContent = (m.name || m.key) + (sz ? `  (${sz})` : '') + (m.multimodal ? ' 🖼️' : '');
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
        ollama: { baseUrl: "http://localhost:11430/v1" },
        openrouter: { baseUrl: "https://openrouter.ai/api/v1" }
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
            // Local GGUF: show dir input + local model select, hide everything else
            apiKeyRow.style.display = "none";
            baseUrlRow.style.display = "none";
            modelInput.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'block', 'important');
            localDirRow.style.display = "flex";
            localDirInput.value = saved.models_dir || "";

            // 恢复/显示自动卸载复选框（配置顶层字段）
            localUnloadCheckbox.checked = !!fullConfig.auto_unload_local;
            localUnloadRow.style.display = "flex";

            // Fetch available local models
            fetchLocalModels();
        } else if (provider === 'openai') {
            apiKeyRow.style.display = "flex";
            baseUrlRow.style.display = "flex";
            apiKeyInput.placeholder = "sk-... (optional for cloud)";
            modelInput.placeholder = "e.g., gpt-4o-mini";
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            localDirRow.style.display = "none";
            localUnloadRow.style.display = "none";
            apiKeyInput.value = mask(saved.api_key);
            baseUrlInput.value = saved.base_url || "";
            // 先恢复手动输入值（作为拉取失败的回退内容），再尝试在线拉取模型列表
            modelInput.value = saved.model || "";
            await refreshOpenAIModelUI();
        } else if (provider === 'lmstudio' || provider === 'ollama' || provider === 'openrouter') {
            // OpenRouter 为云端服务需要 API Key；LM Studio / Ollama 本地服务不需要
            apiKeyRow.style.display = provider === 'openrouter' ? "flex" : "none";
            if (provider === 'openrouter') {
                apiKeyInput.placeholder = "sk-or-...";
                apiKeyInput.value = mask(saved.api_key);
                baseUrlRow.style.display = "flex";
            }
            modelInput.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'block', 'important');
            localDirRow.style.display = "none";
            localUnloadRow.style.display = "none";
            const defaultBaseUrl = REMOTE_PROVIDER_DEFAULTS[provider].baseUrl;
            baseUrlInput.value = saved.base_url || defaultBaseUrl;
            await fetchModelsFromUrl(baseUrlInput.value.trim(), modelSelectEl);
            applyRemoteSavedModel(saved.model);
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
            if (provider === 'local') {
                config.models_dir = localDirInput.value.trim();
                config.auto_unload_local = localUnloadCheckbox.checked;
            }
            // 远程模型下拉为空（加载失败或未选择）时不覆盖已保存的 model；
            // OpenAI Compatible 仅在在线列表模式下走同样的保护，手动输入模式始终保存
            if (provider === 'lmstudio' || provider === 'ollama' || provider === 'openrouter') {
                if (modelValue) config.model = modelValue;
            } else if (provider === 'openai' && modelSelectEl.style.display !== 'none') {
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
    // Auto-fetch models when the base URL field changes (LM Studio / Ollama / OpenRouter / OpenAI)
    const fetchModelsForBaseUrl = async () => {
        const provider = providerSelect.value;
        if (provider === 'lmstudio' || provider === 'ollama' || provider === 'openrouter') {
            const url = baseUrlInput.value.trim();
            if (!url) return;
            await fetchModelsFromUrl(url, modelSelectEl);
            applyRemoteSavedModel(savedRemoteConfig?.providers?.[provider]?.model);
        } else if (provider === 'openai' && baseUrlInput.value.trim()) {
            await refreshOpenAIModelUI();
        }
    };
    baseUrlInput.addEventListener("change", fetchModelsForBaseUrl);
    baseUrlInput.addEventListener("blur", fetchModelsForBaseUrl);
    modelInput.addEventListener("blur", autoSaveConfig);
    modelSelectEl.addEventListener("change", autoSaveConfig);

    function setLocalStatusMsg(msg, color, autoHide = true) {
        providerSaveStatusText.textContent = msg;
        providerSaveStatusText.style.display = "block";
        providerSaveStatusText.style.color = color || "#999";
        if (autoHide) {
            setTimeout(() => { providerSaveStatusText.style.display = "none"; }, 2500);
        }
    }

    localModelSelectEl.addEventListener("change", async () => {
        autoSaveConfig();
        const modelKey = localModelSelectEl.value;

        try {
            const setResult = await setCurrentModel(modelKey);
            if (!setResult || !setResult.success) {
                setLocalStatusMsg("❌ Model switch failed: " + (setResult?.error || modelKey), "#dc2626");
                return;
            }
        } catch (e) {
            console.error("Failed to switch local model:", e);
            setLocalStatusMsg("❌ " + (e.message || "Model switch failed"), "#dc2626");
        }
    });

    localDirInput.addEventListener("change", async () => {
        // 先落盘再刷新，确保服务端按新目录扫描
        await window.NeoNodes?.saveRemoteLLMConfig?.({
            enabled: false,
            provider: "local",
            models_dir: localDirInput.value.trim()
        });
        await fetchLocalModels();
    });

    // 自动卸载复选框：切换即落盘（仅对 Local GGUF 有意义）
    localUnloadCheckbox.addEventListener("change", async () => {
        await window.NeoNodes?.saveRemoteLLMConfig?.({
            enabled: false,
            provider: "local",
            models_dir: localDirInput.value.trim(),
            auto_unload_local: localUnloadCheckbox.checked
        });
    });

    // 读取已保存配置并回填（原 loadRemoteLLMConfig，改用本模块局部变量）
    const loadModelConfig = async () => {
        const config = await window.NeoNodes?.getRemoteLLMConfig?.() || {};
        let providerValue = config.active_provider || 'local';
        if (!['local', 'openai', 'lmstudio', 'ollama', 'openrouter'].includes(providerValue)) {
            providerValue = 'openai';
        }
        if (config.enabled === false) {
            providerValue = 'local';
        }
        providerSelect.value = providerValue;
        await handleProviderChange();
    };

    return { el: remoteForm, load: loadModelConfig, save: autoSaveConfig };
}