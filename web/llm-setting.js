/**
 * llm-setting.js
 * LLM 配置表单：provider / model / API key / base URL / temperature / 本地模型目录 / 自动卸载。
 * 原设置弹窗的 “LLM Settings” 标签内容，现整体挂到「自动增强」菜单内。
 * createModelConfigForm() 返回 { el, load, save, isDirty }：
 *   el      —— 表单 DOM（追加到宿主容器）
 *   load    —— 读取已保存配置并回填（打开时调用），resolve 时模型列表已填充完毕
 *   save    —— 立即落盘当前表单值（💾 按钮 / 「保存并关闭」调用），返回是否成功
 *   isDirty —— 加载窗口内恒 false，此后表示有未保存改动（快照对比）
 */

import { attachComboBox } from "./combo-box.js";
import { setCurrentModel } from "./prompt-service.js";
import { mkEl } from "./dom-utils.js";

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
    // 选项由 loadModelConfig 从后端 provider_list 动态填充
    providerSelect.innerHTML = `<option value="local">Loading...</option>`;
    
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

    // Temperature input row (remote providers only - hidden by default)
    const temperatureRow = mkEl("div", "rs-config-row");
    const temperatureLabel = mkEl("label", "rs-form-label");
    temperatureLabel.textContent = "Temperature";

    const temperatureInput = mkEl("input", "rs-form-input rs-remote-temperature");
    temperatureInput.type = "number";
    temperatureInput.id = "rs-remote-temperature";
    temperatureInput.min = "0";
    temperatureInput.max = "2";
    temperatureInput.step = "0.1";

    const temperatureHint = mkEl("div", "rs-form-hint");
    temperatureHint.style.cssText = 'font-size:10px;color:#888;margin-top:2px;line-height:1.3;';
    temperatureHint.innerHTML = "采样温度；填 0 则不发送，使用服务端/模型默认值";

    temperatureRow.appendChild(temperatureLabel);
    temperatureRow.appendChild(temperatureInput);
    temperatureRow.appendChild(temperatureHint);

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

    remoteForm.append(remoteInfoText, providerRow, localDirRow, modelRowWrapper, apiKeyRow, baseUrlRow, temperatureRow, providerSaveStatusText);
    // 自动卸载本地模型设置放在设置页最底部
    remoteForm.appendChild(localUnloadRow);

    // 显式保存按钮：替代防抖自动保存（单模型下拉不触发 change、blur 时序难排查，落盘时机不可靠）
    const saveBtn = mkEl("button", "rs-gen-save");
    saveBtn.type = "button";
    saveBtn.textContent = "💾 保存设置";
    let saveResetTimer = null;
    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        const ok = await saveForm();
        saveBtn.disabled = false;
        saveBtn.textContent = ok ? "✓ 已保存" : "✕ 保存失败";
        clearTimeout(saveResetTimer);
        saveResetTimer = setTimeout(() => { saveBtn.textContent = "💾 保存设置"; }, 1600);
    });
    const saveRow = mkEl("div", "rs-config-row");
    saveRow.appendChild(saveBtn);
    remoteForm.appendChild(saveRow);

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
            // 需要鉴权的 provider（show_api_key=true）附带 API Key
            const def = getProviderDef(providerSelect.value);
            if (def.show_api_key) {
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
        const def = getProviderDef(provider);
        if (def.type === 'local') {
            return localModelSelectEl.value || '';
        } else if (def.model_mode === 'hybrid') {
            // 在线列表拉取成功时以下拉为准，否则以手动输入框为准
            const dropdownVisible = modelSelectEl.style.display !== 'none';
            return dropdownVisible ? (modelSelectEl.value || '') : modelInput.value;
        } else {
            // dropdown 模式：下拉框为准，未加载时为空（不回填其它 provider 的 model）
            return modelSelectEl ? modelSelectEl.value : '';
        }
    };

    // hybrid 模式：尝试从 /v1/models 在线拉取列表；成功用下拉选择，失败回退手动输入
    const refreshOpenAIModelUI = async () => {
        const provider = providerSelect.value;
        const savedModel = savedRemoteConfig?.providers?.[provider]?.model || '';
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

    // provider 元数据从后端 /rs_prompts/remote_llm_config 的 provider_list 字段获取
    let providerDefs = [];  // [{id, name, type, default_base_url, append_v1, show_api_key, model_mode}]
    const getProviderDef = (id) => providerDefs.find(p => p.id === id) || {};

    let savedRemoteConfig = null;

    const handleProviderChange = async () => {
        const provider = providerSelect.value;
        const def = getProviderDef(provider);

        // Load this provider's own saved config so switching providers never overwrites each other
        const fullConfig = await window.NeoNodes?.getRemoteLLMConfig?.() || {};
        savedRemoteConfig = fullConfig;
        const saved = (fullConfig.providers && fullConfig.providers[provider]) || {};
        const mask = (v) => (v === '***' ? '' : (v || ''));
        
        if (def.type === 'local') {
            // Local GGUF: show dir input + local model select, hide everything else
            apiKeyRow.style.display = "none";
            baseUrlRow.style.display = "none";
            modelInput.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'block', 'important');
            localDirRow.style.display = "flex";
            temperatureRow.style.display = "none";
            localDirInput.value = saved.models_dir || "";

            // 恢复/显示自动卸载复选框（配置顶层字段）
            localUnloadCheckbox.checked = !!fullConfig.auto_unload_local;
            localUnloadRow.style.display = "flex";

            // 拉取并回填本地模型列表；await 让 load 在列表填充完成后再结束，
            // 避免「列表晚到 → loading 已解除 → 程序化改动逃过加载窗口」的竞态
            await fetchLocalModels();
        } else if (def.model_mode === 'hybrid') {
            // OpenAI Compatible：手动输入 + 可选在线下拉
            apiKeyRow.style.display = def.show_api_key ? "flex" : "none";
            baseUrlRow.style.display = "flex";
            if (def.show_api_key) {
                apiKeyInput.placeholder = saved.api_key ? "sk-..." : "API key (optional)";
                apiKeyInput.value = mask(saved.api_key);
            }
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            localDirRow.style.display = "none";
            localUnloadRow.style.display = "none";
            baseUrlInput.value = saved.base_url || (def.default_base_url || "");
            temperatureRow.style.display = "flex";
            temperatureInput.value = saved.temperature ?? 0;
            // 先恢复手动输入值（作为拉取失败的回退内容），再尝试在线拉取模型列表
            modelInput.value = saved.model || "";
            await refreshOpenAIModelUI();
        } else {
            // dropdown 模式（LM Studio / Ollama / OpenRouter / Unsloth 等）
            apiKeyRow.style.display = def.show_api_key ? "flex" : "none";
            if (def.show_api_key) {
                apiKeyInput.placeholder = "API key";
                apiKeyInput.value = mask(saved.api_key);
            }
            modelInput.style.setProperty('display', 'none', 'important');
            localModelSelectEl.style.setProperty('display', 'none', 'important');
            modelSelectEl.style.setProperty('display', 'block', 'important');
            localDirRow.style.display = "none";
            localUnloadRow.style.display = "none";
            baseUrlRow.style.display = "flex";
            const defaultBaseUrl = def.default_base_url || "";
            baseUrlInput.value = saved.base_url || defaultBaseUrl;
            temperatureRow.style.display = "flex";
            temperatureInput.value = saved.temperature ?? 0;
            await fetchModelsFromUrl(baseUrlInput.value.trim(), modelSelectEl);
            applyRemoteSavedModel(saved.model);
        }
    };

    // Provider 切换只负责 UI 显隐与加载对应配置，落盘统一走 💾 按钮
    providerSelect.addEventListener("change", () => handleProviderChange());

    // ==========================================
    // 显式保存：💾 按钮 / 关菜单「保存并关闭」，不再防抖自动保存
    // （自动保存漏掉单模型下拉不触发 change 的场景，且落盘时机难排查）
    // ==========================================
    // 加载窗口标记：loadModelConfig 回填期间 saveForm 不落盘、isDirty 恒 false
    let loading = false;
    // load/save 完成后的表单快照，用于脏检查（同生图设置做法）
    let snapshot = null;
    const collectFormValues = () => ({
        provider: providerSelect.value,
        model: getModelValue(),
        api_key: apiKeyInput.value,
        base_url: baseUrlInput.value,
        temperature: parseFloat(temperatureInput.value) || 0,
        models_dir: localDirInput.value.trim(),
        auto_unload_local: localUnloadCheckbox.checked,
    });

    const saveForm = async () => {
        if (loading) return false;
        // 先读已保存的当前模型做对比（成功保存会清缓存，此处拿到的是本次保存前的值）
        const cfg = await window.NeoNodes?.getRemoteLLMConfig?.() || {};
        const provider = providerSelect.value;
        const def = getProviderDef(provider);
        // 只持久化当前 provider 相关字段，避免把隐藏字段的残留值（如本地模式下的 base_url）写进配置
        const config = {
            enabled: def.type !== 'local',
            provider: provider
        };
        if (def.type === 'local') {
            config.models_dir = localDirInput.value.trim();
            config.auto_unload_local = localUnloadCheckbox.checked;
            // 以下拉当前选中项为准；列表为空 / 加载失败时 value 为空，不覆盖已保存的模型
            const localModelValue = localModelSelectEl.value;
            if (localModelValue && localModelValue !== '__loading__') config.model = localModelValue;
        } else {
            config.api_key = apiKeyInput.value;
            config.base_url = baseUrlInput.value;
            const modelValue = getModelValue();
            const tempValue = parseFloat(temperatureInput.value);
            config.temperature = isNaN(tempValue) ? 0 : tempValue;
            // 远程模型下拉为空（加载失败或未选择）时不覆盖已保存的 model；
            // hybrid 模式仅在在线列表模式下走同样的保护，手动输入模式始终保存
            if (def.model_mode === 'dropdown') {
                if (modelValue) config.model = modelValue;
            } else if (def.model_mode === 'hybrid' && modelSelectEl.style.display !== 'none') {
                if (modelValue) config.model = modelValue;
            } else {
                config.model = modelValue;
            }
        }

        const result = await window.NeoNodes?.saveRemoteLLMConfig?.(config);
        if (!result || !result.success) return false;

        // 本地模式：额外经 set_model 持久化 + 切换常驻模型（覆盖单模型不触发 change 的场景）；
        // 与已保存的当前模型一致时跳过，避免无谓重载模型
        if (def.type === 'local' && config.model && cfg.providers?.local?.model !== config.model) {
            try {
                const setResult = await setCurrentModel(config.model);
                if (!setResult || !setResult.success) {
                    setLocalStatusMsg("❌ Model switch failed: " + (setResult?.error || config.model), "#dc2626");
                    return false;
                }
            } catch (e) {
                console.error("Failed to switch local model:", e);
                setLocalStatusMsg("❌ " + (e.message || "Model switch failed"), "#dc2626");
                return false;
            }
        }

        snapshot = collectFormValues();
        return true;
    };

    const isDirty = () => {
        if (loading) return false;
        return snapshot !== null && JSON.stringify(collectFormValues()) !== JSON.stringify(snapshot);
    };

    // base URL 变化时自动拉取模型列表，只读不保存
    const fetchModelsForBaseUrl = async () => {
        const provider = providerSelect.value;
        const def = getProviderDef(provider);
        if (def.type === 'local') return;
        if (def.model_mode === 'dropdown') {
            const url = baseUrlInput.value.trim();
            if (!url) return;
            await fetchModelsFromUrl(url, modelSelectEl);
            applyRemoteSavedModel(savedRemoteConfig?.providers?.[provider]?.model);
        } else if (def.model_mode === 'hybrid' && baseUrlInput.value.trim()) {
            await refreshOpenAIModelUI();
        }
    };
    baseUrlInput.addEventListener("change", fetchModelsForBaseUrl);
    baseUrlInput.addEventListener("blur", fetchModelsForBaseUrl);

    function setLocalStatusMsg(msg, color, autoHide = true) {
        providerSaveStatusText.textContent = msg;
        providerSaveStatusText.style.display = "block";
        providerSaveStatusText.style.color = color || "#999";
        if (autoHide) {
            setTimeout(() => { providerSaveStatusText.style.display = "none"; }, 2500);
        }
    }

    localDirInput.addEventListener("change", async () => {
        // 先落盘再刷新，确保服务端按新目录扫描（唯一保留的即时写：列表刷新依赖后端已存目录）
        await window.NeoNodes?.saveRemoteLLMConfig?.({
            enabled: false,
            provider: "local",
            models_dir: localDirInput.value.trim()
        });
        await fetchLocalModels();
    });

    // 读取已保存配置并回填（原 loadRemoteLLMConfig，改用本模块局部变量）
    const loadModelConfig = async () => {
        loading = true;
        try {
            const config = await window.NeoNodes?.getRemoteLLMConfig?.() || {};
            // 从后端获取 provider 定义列表，动态构建下拉选项
            if (config.provider_list && Array.isArray(config.provider_list)) {
                providerDefs = config.provider_list;
                providerSelect.innerHTML = '';
                providerDefs.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name || p.id;
                    providerSelect.appendChild(opt);
                });
            }
            let providerValue = config.active_provider || 'local';
            const validIds = providerDefs.map(p => p.id);
            if (!validIds.includes(providerValue)) {
                providerValue = validIds.includes('openai') ? 'openai' : (validIds[0] || 'local');
            }
            if (config.enabled === false) {
                providerValue = 'local';
            }
            providerSelect.value = providerValue;
            await handleProviderChange();
        } finally {
            loading = false;
            snapshot = collectFormValues(); // 初始化完成（含模型列表异步回填），脏检查基线
        }
    };

    return { el: remoteForm, load: loadModelConfig, save: saveForm, isDirty };
}