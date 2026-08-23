/**
 * prompt-service.js
 * API 调用和数据处理模块
 */

// ==========================================
// 远程 LLM 配置缓存
// ==========================================
let remoteLLMConfigCache = null;
let remoteLLMConfigCacheTime = 0;
const REMOTE_LLM_CONFIG_CACHE_TTL = 10000; // 10秒缓存

/**
 * 获取远程 LLM 配置
 * @returns {Promise<Object>}
 */
async function getRemoteLLMConfig() {
    const now = Date.now();
    if (remoteLLMConfigCache && (now - remoteLLMConfigCacheTime) < REMOTE_LLM_CONFIG_CACHE_TTL) {
        return remoteLLMConfigCache;
    }
    
    try {
        const res = await fetch("/rs_prompts/remote_llm_config");
        const config = await res.json();
        remoteLLMConfigCache = config;
        remoteLLMConfigCacheTime = now;
        return config;
    } catch (e) {
        console.error("Failed to get remote LLM config:", e);
        return {
            enabled: false,
            active_provider: "openai",
            providers: {
                openai: { api_key: "", base_url: "", model: "gpt-4o-mini", max_tokens: 500, temperature: 0.0, timeout: 60 },
                lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "", max_tokens: 500, temperature: 0.0, timeout: 60 },
                ollama: { api_key: "", base_url: "http://localhost:11430/v1", model: "", max_tokens: 500, temperature: 0.0, timeout: 60 }
            }
        };
    }
}

/**
 * 保存远程 LLM 配置
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>}
 */
async function saveRemoteLLMConfig(config) {
    try {
        const res = await fetch("/rs_prompts/remote_llm_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        });
        const result = await res.json();
        if (result.success) {
            // 清除缓存
            remoteLLMConfigCache = null;
            remoteLLMConfigCacheTime = 0;
        }
        return result;
    } catch (e) {
        console.error("Failed to save remote LLM config:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 获取当前 LLM 模式
 * @returns {Promise<string>} - "local" 或 "remote"
 */
async function getLLMMode() {
    try {
        const res = await fetch("/rs_prompts/llm_mode");
        const data = await res.json();
        return data.mode || "local";
    } catch (e) {
        console.error("Failed to get LLM mode:", e);
        return "local";
    }
}

// ==========================================
// 模型状态缓存
// ==========================================
let modelStatusCache = null;
let modelStatusCacheTime = 0;
const MODEL_STATUS_CACHE_TTL = 5000; // 5秒缓存，下载时频繁检查

let allModelsStatusCache = null;
let allModelsStatusCacheTime = 0;

/**
 * 检查 LLM 模型是否已下载
 * @returns {Promise<{model_available: boolean, mmproj_available: boolean, model_repo_id: string, model_filename: string, download_status: object}>}
 */
async function checkModel() {
    // 使用缓存减少请求
    const now = Date.now();
    if (modelStatusCache && (now - modelStatusCacheTime) < MODEL_STATUS_CACHE_TTL) {
        return modelStatusCache;
    }

    try {
        const res = await fetch("/rs_prompts/check_model");
        modelStatusCache = await res.json();
        modelStatusCacheTime = now;
        return modelStatusCache;
    } catch (e) {
        console.error("Failed to check model status:", e);
        return {
            model_available: false,
            mmproj_available: false,
            download_status: {
                model: { downloading: false, progress: 0, error: null },
                mmproj: { downloading: false, progress: 0, error: null }
            }
        };
    }
}

/**
 * 检查所有模型的状态
 * @returns {Promise<{models: Array<{key: string, name: string, filename: string, model_dir: string, available: boolean}>, current_model: string}>}
 */
async function checkAllModels() {
    // 使用缓存减少请求
    const now = Date.now();
    if (allModelsStatusCache && (now - allModelsStatusCacheTime) < MODEL_STATUS_CACHE_TTL) {
        return allModelsStatusCache;
    }

    try {
        const res = await fetch("/rs_prompts/check_all_models");
        allModelsStatusCache = await res.json();
        allModelsStatusCacheTime = now;
        return allModelsStatusCache;
    } catch (e) {
        console.error("Failed to check all models status:", e);
        return {
            models: [],
            current_model: ""
        };
    }
}

/**
 * 清除模型状态缓存
 */
function clearModelStatusCache() {
    modelStatusCache = null;
    modelStatusCacheTime = 0;
    allModelsStatusCache = null;
    allModelsStatusCacheTime = 0;
}

/**
 * 启动模型下载
 * @param {string} fileType - "model" 或 "mmproj"
 * @returns {Promise<{status: string}>}
 */
async function downloadModel(fileType) {
    try {
        const res = await fetch("/rs_prompts/download_model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file_type: fileType })
        });
        return await res.json();
    } catch (e) {
        console.error("Failed to start download:", e);
        return { error: e.message };
    }
}

/**
 * 检查模型并自动下载（如果未下载）
 * 下载在后台进行，不阻塞前端
 * @param {Object} downloadModal - 下载模态框引用
 * @param {Object} statusBar - 状态栏引用（可选）
 * @returns {Promise<boolean>} - 返回 true 表示可以继续操作，false 表示模型未就绪
 */
async function checkModelAndPrompt(downloadModal = null, statusBar = null) {
    // Only check/download model in local mode
    const mode = await getLLMMode();
    if (mode !== "local") {
        return true; // Skip model check for remote providers
    }

    const status = await checkModel();

    if (!status.model_available) {
        // 检查是否正在下载
        const downloadStatus = status.download_status?.model;

        if (downloadStatus && downloadStatus.downloading) {
            // 正在下载，提示用户等待
            if (downloadModal) {
                showDownloadModal(downloadModal, status, true, null, statusBar);
            } else {
                alert(`⏳ 模型正在后台下载中... (${downloadStatus.progress || 0}%)
                
请在下载完成后重试此操作。`);
            }
            return false;
        }

        // 检查是否有下载错误
        if (downloadStatus && downloadStatus.error) {
            if (downloadModal) {
                showDownloadModal(downloadModal, status, false, downloadStatus.error, statusBar);
            } else {
                alert("下载失败: " + downloadStatus.error + "\n\n请重试或手动下载模型。");
            }
            return false;
        }

        // 显示下载模态框
        if (downloadModal) {
            showDownloadModal(downloadModal, status, false, null, statusBar);
            return false;
        }

        // 询问用户是否下载
        const msg = [
            "⚠️ LLM 模型未下载",
            "",
            "需要下载以下模型文件：",
            `📦 ${status.model_filename || "Qwen3.5-0.8B-Q4_K_M.gguf"}`,
            "",
            `从 HuggingFace 仓库：`,
            `🔗 ${status.model_repo_id || "lmstudio-community/Qwen3.5-0.8B-GGUF"}`,
            "",
            "是否现在启动后台下载？\n（下载将在后台进行，下载完成后请重试此操作）"
        ].join("\n");

        if (!confirm(msg)) {
            return false;
        }

        // 启动下载（非阻塞）
        const result = await downloadModel("model");
        if (result.error) {
            alert("启动下载失败: " + result.error);
            return false;
        }

        // 提示用户下载已启动
        alert("✅ 下载已启动！\n\n模型将在后台下载，下载完成后请重试此操作。\n\n您可以在控制台查看下载进度。");

        // 开始后台进度监控（不阻塞）
        monitorDownloadProgress();

        return false; // 返回 false，让用户知道需要重试
    }

    return true;
}

/**
 * 显示下载模态框
 * @param {Object} downloadModal - 下载模态框引用
 * @param {Object} status - 模型状态
 * @param {boolean} isDownloading - 是否正在下载
 * @param {string} error - 错误信息
 * @param {Object} statusBar - 状态栏引用（可选）
 */
function showDownloadModal(downloadModal, status, isDownloading = false, error = null, statusBar = null) {
    const { modal, modelInfo, progressContainer, progressFill, progressText, statusText, downloadBtn, cancelBtn, closeBtn } = downloadModal;
    
    // 更新模型信息
    const modelName = status.model_filename || "Qwen3.5-0.8B-Q4_K_M.gguf";
    const repoId = status.model_repo_id || "lmstudio-community/Qwen3.5-0.8B-GGUF";
    modelInfo.innerHTML = `
        <div class="rs-download-model-name">${modelName}</div>
        <div class="rs-download-repo">${repoId}</div>
    `;
    
    if (isDownloading) {
        // 正在下载状态
        progressContainer.style.display = "block";
        const progress = status.download_status?.model?.progress || 0;
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${progress}%`;
        statusText.textContent = "Downloading in progress...";
        downloadBtn.style.display = "none";
        cancelBtn.style.display = "none";
        closeBtn.style.display = "block";
        modal.style.display = "block";
        
        // 更新状态栏
        if (statusBar) {
            statusBar.classList.add("rs-status-downloading");
            statusBar.innerHTML = `⏳ Downloading ${progress}%`;
        }
        
        // 开始监控进度
        monitorDownloadProgress(downloadModal, statusBar);
    } else if (error) {
        // 错误状态
        progressContainer.style.display = "none";
        statusText.textContent = "Download failed: " + error;
        statusText.style.color = "#f87171";
        downloadBtn.style.display = "block";
        downloadBtn.textContent = "🔄 Retry Download";
        cancelBtn.style.display = "block";
        closeBtn.style.display = "none";
        modal.style.display = "block";
        
        // 恢复状态栏
        if (statusBar) {
            statusBar.classList.remove("rs-status-downloading");
        }
    } else {
        // 初始状态
        progressContainer.style.display = "none";
        statusText.textContent = "Ready to download";
        statusText.style.color = "#999";
        downloadBtn.style.display = "block";
        downloadBtn.textContent = "🚀 Start Download";
        cancelBtn.style.display = "block";
        closeBtn.style.display = "none";
        modal.style.display = "block";
        
        // 恢复状态栏
        if (statusBar) {
            statusBar.classList.remove("rs-status-downloading");
        }
    }
}

/**
 * 后台监控下载进度（不阻塞）
 */
let downloadMonitorInterval = null;

function monitorDownloadProgress(downloadModal = null, statusBar = null) {
    if (downloadMonitorInterval) {
        return; // 已经在监控
    }

    downloadMonitorInterval = setInterval(async () => {
        const status = await checkModel();
        const downloadStatus = status.download_status?.model;

        if (!downloadStatus || !downloadStatus.downloading) {
            // 下载完成或失败，停止监控
            clearInterval(downloadMonitorInterval);
            downloadMonitorInterval = null;

            if (status.model_available) {
                console.log("✅ 模型下载完成！");
                if (downloadModal) {
                    const { modal, progressContainer, progressFill, progressText, statusText, downloadBtn, cancelBtn, closeBtn } = downloadModal;
                    progressFill.style.width = "100%";
                    progressText.textContent = "100%";
                    statusText.textContent = "Download completed successfully!";
                    statusText.style.color = "#4ade80";
                    downloadBtn.style.display = "none";
                    cancelBtn.style.display = "none";
                    closeBtn.style.display = "block";
                    closeBtn.textContent = "✓ Done";
                    
                    // 恢复状态栏
                    if (statusBar) {
                        statusBar.classList.remove("rs-status-downloading");
                        statusBar.innerHTML = "🟢 LOCAL PROMPT";
                    }
                    
                    // 3秒后自动关闭
                    setTimeout(() => {
                        modal.style.display = "none";
                    }, 3000);
                }
            } else if (downloadStatus && downloadStatus.error) {
                console.error("❌ 模型下载失败:", downloadStatus.error);
                if (downloadModal) {
                    const { modal, progressContainer, progressFill, progressText, statusText, downloadBtn, cancelBtn, closeBtn } = downloadModal;
                    progressContainer.style.display = "none";
                    statusText.textContent = "Download failed: " + downloadStatus.error;
                    statusText.style.color = "#f87171";
                    downloadBtn.style.display = "block";
                    downloadBtn.textContent = "🔄 Retry Download";
                    cancelBtn.style.display = "block";
                    closeBtn.style.display = "none";
                    
                    // 恢复状态栏
                    if (statusBar) {
                        statusBar.classList.remove("rs-status-downloading");
                    }
                }
            }
        } else {
            const progress = downloadStatus.progress || 0;
            console.log(`⏳ 模型下载进度: ${progress}%`);
            if (downloadModal) {
                const { progressFill, progressText, statusText } = downloadModal;
                progressFill.style.width = `${progress}%`;
                progressText.textContent = `${progress}%`;
                statusText.textContent = "Downloading in progress...";
            }
            // 更新状态栏
            if (statusBar) {
                statusBar.classList.add("rs-status-downloading");
                statusBar.innerHTML = `⏳ Downloading ${progress}%`;
            }
        }
    }, 2000); // 每 2 秒检查一次
}

// ==========================================
// API 服务
// ==========================================

/**
 * 增强提示词（非流式）
 * @param {string} text - 原始提示词
 * @returns {Promise<{status: string, enhanced: string, error?: string}>}
 */
async function enhancePrompt(text) {
    const res = await fetch("/rs_prompts/enhance_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 通用 SSE 流式请求
 * @param {string} url - 请求 URL
 * @param {Object} options - 回调选项
 * @param {Function} options.onChunk - 收到数据块时回调
 * @param {Function} options.onDone - 完成时回调
 * @param {Function} options.onError - 错误时回调
 * @param {Object} body - 请求体（可选）
 * @returns {Promise<void>}
 */
async function sseStream(url, options = {}, body = null) {
    const { onChunk, onDone, onError } = options;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            onError?.(err.error || "Request failed");
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6);
                if (data === "[DONE]") {
                    onDone?.();
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    onChunk?.(parsed);
                } catch {
                    onChunk?.({ text: data });
                }
            }
        }
        onDone?.();
    } catch (e) {
        onError?.(e.message);
    }
}

/**
 * 翻译提示词（非流式）
 * @param {string} text - 原始提示词
 * @returns {Promise<{status: string, translated: string, error?: string}>}
 */
async function translatePrompt(text) {
    const res = await fetch("/rs_prompts/translate_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 增强提示词（流式）
 */
async function enhancePromptStream(text, options = {}) {
    return sseStream("/rs_prompts/stream_enhance_prompt", options, { text });
}

/**
 * 翻译提示词（流式）
 */
async function translatePromptStream(text, options = {}) {
    return sseStream("/rs_prompts/stream_translate_prompt", options, { text });
}

/**
 * 保存提示词
 * @param {string} name - 提示词名称
 * @param {string} text - 提示词内容
 * @param {string[]} tags - 标签列表
 * @returns {Promise<Response>}
 */
async function savePrompt(name, text, tags = []) {
    return await fetch("/rs_prompts/save_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text, tags })
    });
}

/**
 * 加载提示词
 * @param {string} name - 提示词名称
 * @returns {Promise<{text: string}>}
 */
async function loadPrompt(name) {
    const res = await fetch("/rs_prompts/load_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    return await res.json();
}

/**
 * 列出所有提示词
 * @returns {Promise<Array<{name: string, tags: string[]}|string>}
 */
async function listPrompts() {
    const res = await fetch("/rs_prompts/list_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    return await res.json();
}

/**
 * 删除提示词
 * @param {string} name - 提示词名称
 * @returns {Promise<Response>}
 */
async function deletePrompt(name) {
    return await fetch("/rs_prompts/delete_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
}

/**
 * 提取标题（非流式）
 * @param {string} text - 提示词内容
 * @returns {Promise<{status: string, title: string, error?: string}>}
 */
async function extractTitle(text) {
    const res = await fetch("/rs_prompts/extract_title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 提取分类（非流式）
 * @param {string} text - 提示词内容
 * @returns {Promise<{status: string, classify: string, error?: string}>}
 */
async function extractClassify(text) {
    const res = await fetch("/rs_prompts/extract_classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 智能提示词 - LLM 直接判断用户意图并生成/改写（非流式）
 * @param {string} text - 原始提示词（可选，为空则从头生成）
 * @param {string} description - 用户描述
 * @returns {Promise<{status: string, prompt: string, error?: string}>}
 */
async function smartPrompt(text, description) {
    const res = await fetch("/rs_prompts/smart_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text || "", description })
    });
    return await res.json();
}

/**
 * 智能提示词 - 流式
 */
async function smartPromptStream(text, description, options = {}) {
    return sseStream("/rs_prompts/stream_generate_prompt", options, { text: text || "", description });
}

/**
 * 随机生成文生图提示词（从 preset list 中随机选择一个）
 * @returns {Promise<{status: string, prompt: string, error?: string}>}
 */
async function randomPrompt() {
    const res = await fetch("/rs_prompts/list_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    const list = await res.json();
    
    if (!list || list.length === 0) {
        return { status: "error", prompt: "", error: "No presets available" };
    }
    
    // 随机选择一个
    const randomIndex = Math.floor(Math.random() * list.length);
    const selectedItem = list[randomIndex];
    const name = typeof selectedItem === 'string' ? selectedItem : selectedItem.name;
    
    // 加载该 preset 的完整内容
    const loadRes = await fetch("/rs_prompts/load_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    const data = await loadRes.json();
    
    return {
        status: "success",
        prompt: data.text || ""
    };
}

/**
 * 获取可用模型列表
 * @returns {Promise<{current_model: string, models: Array<{key: string, name: string, filename: string, model_dir: string}>}>}
 */
async function getAvailableModels() {
    try {
        const res = await fetch("/rs_prompts/get_models");
        return await res.json();
    } catch (e) {
        console.error("Failed to get available models:", e);
        return {
            current_model: "Qwen3.5-0.8B",
            models: []
        };
    }
}

/**
 * 设置当前模型
 * @param {string} modelKey - 模型键值
 * @returns {Promise<{success: boolean, current_model?: string, error?: string}>}
 */
async function setCurrentModel(modelKey) {
    try {
        const res = await fetch("/rs_prompts/set_model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model_key: modelKey })
        });
        const data = await res.json();
        if (res.ok) {
            // 清除模型状态缓存，强制重新检查
            clearModelStatusCache();
        }
        return data;
    } catch (e) {
        console.error("Failed to set current model:", e);
        return { success: false, error: e.message };
    }
}

// ==========================================
// 提示词模版（System Prompt Template）API
// ==========================================

/**
 * 列出所有提示词模版
 * @returns {Promise<Array<{id: string, name: string, source: string, tags: string[], content: string}>>}
 */
async function listTemplates() {
    try {
        const res = await fetch("/rs_prompts/list_templates");
        return await res.json();
    } catch (e) {
        console.error("Failed to list templates:", e);
        return [];
    }
}

/**
 * 加载单个模版内容
 * @param {string} id - 模版 ID
 * @returns {Promise<{id: string, name: string, source: string, tags: string[], content: string}>}
 */
async function loadTemplate(id) {
    try {
        const res = await fetch("/rs_prompts/load_template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        if (!res.ok) {
            const text = await res.text();
            return { error: text };
        }
        return await res.json();
    } catch (e) {
        console.error("Failed to load template:", e);
        return { error: e.message };
    }
}

/**
 * 保存/更新模版
 * @param {Object} template - 模版对象 {id, name, content, tags?, source?}
 * @returns {Promise<{success: boolean}>}
 */
async function saveTemplate(template) {
    try {
        const res = await fetch("/rs_prompts/save_template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(template)
        });
        return await res.json();
    } catch (e) {
        console.error("Failed to save template:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 删除模版（预设不可删）
 * @param {string} id - 模版 ID
 * @returns {Promise<{success: boolean}>}
 */
async function deleteTemplate(id) {
    try {
        const res = await fetch("/rs_prompts/delete_template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        return await res.json();
    } catch (e) {
        console.error("Failed to delete template:", e);
        return { success: false, error: e.message };
    }
}

// ==========================================
// Skills (统一任务/模板/图片输入元数据)
// ==========================================

/**
 * 列出所有 skill（任务 + 模板统一元数据）
 * @returns {Promise<Array<{id, name, category, source, inputs, needs_image, markers, tags, description}>>}
 */
async function listSkills() {
    try {
        const res = await fetch("/rs_prompts/skills");
        return await res.json();
    } catch (e) {
        console.error("Failed to list skills:", e);
        return [];
    }
}

/**
 * 将图片文件缩放并转为 base64 data URI
 * @param {File} file - 图片文件
 * @param {number} maxSide - 最长边限制
 * @returns {Promise<{data: string, name: string}>}
 */
function fileToBase64(file, maxSide = 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.max(img.width, img.height) > maxSide
                    ? maxSide / Math.max(img.width, img.height)
                    : 1;
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve({ data: canvas.toDataURL("image/png"), name: file.name });
            };
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * 从剪贴板事件提取图片文件列表
 * @param {ClipboardEvent} e
 * @returns {File[]}
 */
function imagesFromClipboard(e) {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) files.push(f);
        }
    }
    return files;
}

/**
 * 以 skill 形式调用流式生成接口（支持 text + images + skillId）
 * `payload = { text, skillId（或 templateId）, images: [{kind:"data", data: base64Uri}] }`。
 */
async function invokePromptStream(payload, options = {}) {
    return sseStream("/rs_prompts/stream_generate_prompt", options, payload);
}

// ==========================================
// 提示词服务包装器 - 为节点行为模块提供统一的 API 调用接口
// ==========================================

/**
 * 创建提示词服务包装器
 * 将原有的 API 函数包装成便于测试和使用的接口
 */
function createPromptService() {
    return {
        /**
         * 增强提示词（非流式）
         */
        async enhance(text) {
            return await enhancePrompt(text);
        },

        /**
         * 增强提示词（流式）
         */
        async enhanceStream(text, options) {
            return await enhancePromptStream(text, options);
        },

        /**
         * 翻译提示词（非流式）
         */
        async translate(text) {
            return await translatePrompt(text);
        },

        /**
         * 翻译提示词（流式）
         */
        async translateStream(text, options) {
            return await translatePromptStream(text, options);
        },

        /**
         * 智能提示词 - LLM 直接判断用户意图并生成/改写（非流式）
         */
        async smart(text, description) {
            return await smartPrompt(text, description);
        },

        /**
         * 智能提示词 - 流式
         */
        async smartStream(text, description, options) {
            return await smartPromptStream(text, description, options);
        },

        /**
         * 随机生成提示词
         */
        async random() {
            return await randomPrompt();
        }
    };
}

// 创建单例实例
const promptService = createPromptService();

// ==========================================
// 导出
// ==========================================

export {
    checkModel,
    checkAllModels,
    clearModelStatusCache,
    downloadModel,
    checkModelAndPrompt,
    showDownloadModal,
    monitorDownloadProgress,
    enhancePrompt,
    enhancePromptStream,
    translatePrompt,
    translatePromptStream,
    savePrompt,
    loadPrompt,
    listPrompts,
    deletePrompt,
    extractTitle,
    extractClassify,
    randomPrompt,
    smartPrompt,
    smartPromptStream,
    sseStream,
    getAvailableModels,
    setCurrentModel,
    createPromptService,
    // 远程 LLM 配置相关
    getRemoteLLMConfig,
    saveRemoteLLMConfig,
    getLLMMode,
    // 提示词模版管理
    listTemplates,
    loadTemplate,
    saveTemplate,
    deleteTemplate,
    // Skills 统一元数据
    listSkills,
    fileToBase64,
    imagesFromClipboard,
    invokePromptStream
};

export default promptService;

// ==========================================
// 暴露到全局 window 对象 (供模态框使用)
// ==========================================
if (typeof window !== 'undefined') {
    // Namespace to avoid conflicts with other extensions
    if (!window.NeoNodes) {
        window.NeoNodes = {};
    }
    window.NeoNodes.getRemoteLLMConfig = getRemoteLLMConfig;
    window.NeoNodes.saveRemoteLLMConfig = saveRemoteLLMConfig;
    window.NeoNodes.getLLMMode = getLLMMode;
    // 提示词模版管理
    window.NeoNodes.listTemplates = listTemplates;
    window.NeoNodes.loadTemplate = loadTemplate;
    window.NeoNodes.saveTemplate = saveTemplate;
    window.NeoNodes.deleteTemplate = deleteTemplate;
}
