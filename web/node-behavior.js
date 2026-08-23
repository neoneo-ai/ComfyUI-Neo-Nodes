/**
 * node-behavior.js
 * 共享的节点行为逻辑 - 消除 NeoPromptSimple 和 NeoPrompts 之间的代码重复
 */

import { checkModelAndPrompt, enhancePromptStream, translatePromptStream, smartPromptStream, randomPrompt, sseStream, invokePromptStream } from "./prompt-service.js";

// ==========================================
// 工具函数
// ==========================================

// @ 标记 -> skill id 路由（与后端 _SKILL_MARKERS 保持一致）
const AT_SKILL_MARKERS = {
    "图": "reverse_prompt",
    "图片": "reverse_prompt",
    "反推": "reverse_prompt",
    "image": "reverse_prompt",
    "img": "reverse_prompt",
    "全参考": "minimax_h3_ref",
    "参考": "minimax_h3_ref",
    "minimax": "minimax_h3_ref",
};

// 匹配文本中的 @ 标记，返回 skill id 或空串
// 注意：不能用 \b（JS 中中文字符不属于 \w，中文之间永远不存在词边界）
function matchSkillMarker(text) {
    if (!text) return "";
    const m = text.match(/@(图片|全参考|参考|反推|minimax|image|img|图)/);
    return m ? (AT_SKILL_MARKERS[m[1]] || "") : "";
}

// 去除文本中的 @ 标记（标记只用于路由，不进入提示词）
function stripSkillMarkers(text) {
    return (text || "").replace(/@(图片|全参考|参考|反推|minimax|image|img|图)/g, "").trim();
}

// 追踪节点 image 输入插槽的上游节点（如 LoadImage），取其图片文件名
// 返回 {kind:"input", value:"<filename>"} 或 null
function resolveConnectedImageSource(node) {
    try {
        const slot = node.inputs?.find(i => i.name === "image");
        if (!slot || slot.link == null) return null;
        const links = node.graph?.links;
        const link = typeof links?.get === "function" ? links.get(slot.link) : links?.[slot.link];
        if (!link) return null;
        const srcNode = node.graph.getNodeById(link.origin_id);
        if (!srcNode) return null;
        // widgets_values 里的图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
        for (const w of (srcNode.widgets_values || [])) {
            let v = "";
            if (typeof w === "string") v = w.trim();
            else if (Array.isArray(w)) v = String(w[0] ?? "").trim();
            else if (w && typeof w === "object") v = String(w.name ?? w.filename ?? "").trim();
            if (v && /\.(png|jpe?g|webp|bmp|gif)$/i.test(v)) {
                return { kind: "input", value: v };
            }
        }
        console.warn("image input connected but no image filename found on upstream node:", srcNode.type);
    } catch (e) {
        console.warn("resolveConnectedImageSource failed:", e);
    }
    return null;
}

// 标记快捷输入已被生成消费：出队时后端跳过拼接；重新编辑输入即自动复位
function markQuickInputConsumed(node) {
    const widget = node?.widgets?.find(w => w.name === "quick_input_used");
    if (widget) widget.value = true;
    if (node?.properties) node.properties.rs_quick_input_used = true;
}

function resetQuickInputConsumed(node) {
    const widget = node?.widgets?.find(w => w.name === "quick_input_used");
    if (widget) widget.value = false;
    if (node?.properties) node.properties.rs_quick_input_used = false;
}

/**
 * 获取实例 UID
 */
function getInstanceUid(node) {
    if (node.properties?.rs_instance_uid) {
        return node.properties.rs_instance_uid;
    }
    const uidWidget = node.widgets?.find(w => w.name === "instance_uid");
    if (uidWidget?.value) {
        return uidWidget.value;
    }
    return 'rs_inst_' + crypto.randomUUID().replace(/-/g, '');
}

/**
 * 获取文本键（已废弃，保留用于兼容性）
 */
function getTextKey(instanceUid) {
    return `rs_prompt_${instanceUid}`;
}

/**
 * Set textarea value and dispatch synthetic "input" event (triggers auto-switch from EXTERNAL to LOCAL)
 */
function setTextAndTrigger(customTextarea, value) {
    if (!customTextarea) return;
    customTextarea.value = value;
    customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 保存文本到 widget（in-memory cache）
 */
function saveTextToStorage(node, textWidget, customTextarea, forceSave = false) {
    const instanceUid = getInstanceUid(node);
    const text = customTextarea?.value ?? textWidget?.value ?? "";
    
    if (textWidget && (forceSave || textWidget.value !== text)) {
        textWidget.value = text;
    }
    if (customTextarea && customTextarea.value !== text) {
        customTextarea.value = text;
    }
    // In-memory cache only - no localStorage
    return text;
}

/**
 * 从 widget 恢复文本（in-memory cache）
 */
function restoreTextFromStorage(node, textWidget, customTextarea) {
    // In-memory cache only - use widget value
    if (textWidget && textWidget.value) {
        if (customTextarea) customTextarea.value = textWidget.value;
        return textWidget.value;
    }
    return null;
}

/**
 * 创建通用的初始化处理器（设置基本属性）
 */
function createBasicNodeInitializer(node) {
    return function() {
        if (!node.properties) {
            node.properties = {};
        }
        if (node.properties.rs_disable_state === undefined) {
            node.properties.rs_disable_state = false;
        }
        if (node.properties.rs_waiting_prompt === undefined) {
            node.properties.rs_waiting_prompt = "";
        }
        if (node.properties.rs_waiting_timestamp === undefined) {
            node.properties.rs_waiting_timestamp = 0;
        }
    };
}

// ==========================================
// 按钮操作工厂函数
// ==========================================

/**
 * 创建生成提示词的处理函数 - 使用选中的模板或 LLM 智能判断
 */
function createGenerateHandler(promptUI) {
    return async () => {
        console.log("createGenerateHandler called with promptUI keys:", Object.keys(promptUI));
        const { generateBtn, quickInput, customTextarea, textWidget, node, graph, downloadModal, statusBar, tplSelector, attachedImages = [], clearImages } = promptUI;

        const quickText = quickInput.value.trim();
        const currentPrompt = customTextarea?.value?.trim() || "";

        // If quickInput is empty, use customTextarea content as the message
        const messageToLLM = quickText || currentPrompt;

        // @ 标记、附加图片、节点 image 输入连接 -> skill 路由（反推等 vision skill）
        const slotImage = resolveConnectedImageSource(node);
        const imagesPayload = [
            ...(slotImage ? [slotImage] : []),
            ...attachedImages.map(img => img.input
                ? { kind: "input", value: img.input }
                : { kind: "data", data: img.data }),
        ];
        const hasImages = imagesPayload.length > 0;
        const markerSkillId = matchSkillMarker(messageToLLM);

        if (!messageToLLM && !hasImages) {
            alert("Please enter a quick description or attach an image first.");
            return;
        }

        // 检查是否选择了模板
        const selectedTemplateId = tplSelector?.value || "";
        console.log("Template selector value:", selectedTemplateId, "tplSelector:", tplSelector, "tplSelector.value:", tplSelector?.value, "tplSelector.options:", tplSelector?.options?.length);

        const modelOk = await checkModelAndPrompt(downloadModal, statusBar);
        if (!modelOk) return;

        generateBtn.disabled = true;
        generateBtn.textContent = "⏳";

        let rafId = null;
        try {
            let accumulated = "";

            if (hasImages || markerSkillId) {
                // 图片 / @ 标记 -> skill 路由（反推等 vision skill，流式）
                if (markerSkillId && !hasImages) {
                    alert("该 skill 需要图片：输入 @ 从工作流图片中选择、连接 image 输入或粘贴图片后再生成。");
                    return;
                }

                generateBtn.textContent = "🖼️ Processing image...";

                const skillId = markerSkillId
                    || (selectedTemplateId && selectedTemplateId !== "reverse_prompt" ? selectedTemplateId : "")
                    || "reverse_prompt";

                const payload = {
                    text: stripSkillMarkers(messageToLLM),
                    skillId,
                    templateId: markerSkillId ? "" : selectedTemplateId,
                    images: imagesPayload,
                    description: quickText || currentPrompt
                };
                console.log("Skill invoke request:", { ...payload, images: payload.images.length + " image(s)" });

                await invokePromptStream(payload, {
                    onChunk: (chunk) => {
                        if (chunk.text) {
                            accumulated += chunk.text;
                            if (!rafId) {
                                rafId = requestAnimationFrame(() => {
                                    customTextarea.value = accumulated;
                                    customTextarea.scrollTop = customTextarea.scrollHeight;
                                    rafId = null;
                                });
                            }
                        }
                    },
                    onDone: () => {
                        if (rafId) cancelAnimationFrame(rafId);
                        if (textWidget) textWidget.value = accumulated;
                        saveTextToStorage(node, textWidget, customTextarea);
                        clearImages?.();
                        markQuickInputConsumed(node);
                    },
                    onError: (err) => {
                        console.error("Skill invoke error:", err);
                        alert("Failed to process prompt: " + err);
                    }
                });
            } else if (selectedTemplateId) {
                // 使用选中的模板进行生成（流式）
                generateBtn.textContent = "🤖 Processing with template...";

                // If quickInput has content, combine with currentPrompt; otherwise use currentPrompt alone
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;

                console.log("Template stream request:", {
                    text: userPrompt,
                    templateId: selectedTemplateId,
                    description: quickText || currentPrompt
                });

                // 使用流式API，传入templateId
                await sseStream("/rs_prompts/stream_generate_prompt", {
                    onChunk: (chunk) => {
                        if (chunk.text) {
                            accumulated += chunk.text;
                            if (!rafId) {
                                rafId = requestAnimationFrame(() => {
                                    customTextarea.value = accumulated;
                                    customTextarea.scrollTop = customTextarea.scrollHeight;
                                    rafId = null;
                                });
                            }
                        }
                    },
                    onDone: () => {
                        if (rafId) cancelAnimationFrame(rafId);
                        if (textWidget) textWidget.value = accumulated;
                        saveTextToStorage(node, textWidget, customTextarea);
                        markQuickInputConsumed(node);
                    },
                    onError: (err) => {
                        console.error("Template stream error:", err);
                        alert("Failed to process prompt: " + err);
                    }
                }, { 
                    text: userPrompt, 
                    templateId: selectedTemplateId,
                    description: quickText || currentPrompt 
                });
            } else {
                // 使用 LLM 智能判断（流式）：LLM 直接判断用户意图并生成/改写
                generateBtn.textContent = "🤖 Processing...";
                // 拼接 currentPrompt 和 quickText（与选择了模版时保持一致）
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;
                await smartPromptStream(userPrompt, "", {
                    onChunk: (chunk) => {
                        if (chunk.text) {
                            accumulated += chunk.text;
                            if (!rafId) {
                                rafId = requestAnimationFrame(() => {
                                    customTextarea.value = accumulated;
                                    customTextarea.scrollTop = customTextarea.scrollHeight;
                                    rafId = null;
                                });
                            }
                        }
                    },
                    onDone: () => {
                        if (rafId) cancelAnimationFrame(rafId);
                        if (textWidget) textWidget.value = accumulated;
                        saveTextToStorage(node, textWidget, customTextarea);
                        markQuickInputConsumed(node);
                    },
                    onError: (err) => {
                        console.error("Smart prompt stream error:", err);
                        alert("Failed to process prompt: " + err);
                    }
                });
            }
        } catch (e) {
            console.error("Network Error:", e);
            alert("Network error during processing: " + e.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "✨";
        }
    };
}

/**
 * 创建随机生成提示词的处理函数（纯本地操作，不需要大模型）
 */
function createRandomHandler(promptUI) {
    return async () => {
        const { randomBtn, customTextarea, textWidget, node, graph } = promptUI;

        randomBtn.disabled = true;

        try {
            const data = await randomPrompt();
            if (data.status === "success") {
                setTextAndTrigger(customTextarea, data.prompt);
                saveTextToStorage(node, textWidget, customTextarea);
                if (graph) graph.setDirtyCanvas(true, true);
            } else {
                console.error("Random prompt failed:", data);
                alert("Failed to generate random prompt: " + (data.error || "Unknown error"));
            }
        } catch (e) {
            console.error("Network Error:", e);
            alert("Network error during random prompt generation.");
        } finally {
            randomBtn.disabled = false;
        }
    };
}

// ==========================================
// 事件监听器管理
// ==========================================

/**
 * 创建弹窗自动关闭的事件监听器
 */
function createPopupCloser(promptUIElements) {
    return (e) => {
        const { presetListOverlay, presetNameInput, deleteConfirmOverlay, saveBtn, quickInputWrapper } = promptUIElements;
        
        // Check if click is inside our custom UI root
        const clickedRoot = e.target.closest(".rs-root");
        
        if (presetListOverlay) {
            // 点击 overlay 内部不关闭
            if (presetListOverlay.contains(e.target)) {
                return;
            }
            // 点击 quickInputWrapper 内部（包括 quickInput、listBtn、randomBtn、generateBtn）不关闭
            if (quickInputWrapper && quickInputWrapper.contains(e.target)) {
                return;
            }
            // 点击外部（不在 rs-root 内）才关闭
            if (!clickedRoot) {
                presetListOverlay.style.display = "none";
            }
        }
        if (presetNameInput && !presetNameInput.contains(e.target)) {
            // Don't close if clicking inside the same rs-root or on the save button
            if (clickedRoot && (!saveBtn || !saveBtn.contains(e.target))) {
                presetNameInput.style.display = "none";
            }
        }
        if (deleteConfirmOverlay && !deleteConfirmOverlay.contains(e.target)) {
            // Don't close if clicking inside the same rs-root
            if (clickedRoot) {
                deleteConfirmOverlay.style.display = "none";
            }
        }
    };
}

/**
 * 创建处理 rs.prompt.update 事件的处理函数
 */
function createPromptUpdateHandler(promptUI) {
    return (event) => {
        const { customTextarea, textWidget, node, graph } = promptUI;
        const currentUid = getInstanceUid(node);
        
        if (event.detail.instance_uid === currentUid) {
            setTimeout(() => {
                customTextarea.value = event.detail.prompt;
                if (textWidget) {
                    textWidget.value = event.detail.prompt;
                    // In-memory cache only - no localStorage
                }
                if (graph) graph.setDirtyCanvas(true, true);
            }, 10);
        }
    };
}

/**
 * 创建 beforeunload 事件处理函数
 */
function createBeforeUnloadHandler(node, textWidget) {
    return () => {
        // In-memory cache only - no localStorage
        const disableWidget = node.widgets?.find(w => w.name === "disable_text_input");
        if (disableWidget) node.properties.rs_disable_state = disableWidget.value;
    };
}

// ==========================================
// 定时器管理
// ==========================================

/**
 * 创建节点行为管理器
 */
function createNodeBehaviorManager() {
    const intervals = new WeakMap();
    const timeouts = new WeakMap();
    
    /**
     * 启动强制执行定时器
     */
    function startEnforcement(node, updateStatusAndUI) {
        if (!intervals.has(node)) {
            const intervalId = setInterval(() => {
                let needsRedraw = false;
                const disableWidget = node.widgets?.find(w => w.name === "disable_text_input");
                
                if (disableWidget && disableWidget.value !== node.properties.rs_disable_state) {
                    disableWidget.value = node.properties.rs_disable_state;
                    needsRedraw = true;
                }
                
                if (needsRedraw && node.graph) {
                    node.graph.setDirtyCanvas(true, true);
                }
            }, 200);
            intervals.set(node, intervalId);
        }
    }
    
    /**
     * 停止强制执行定时器
     */
    function stopEnforcement(node) {
        const intervalId = intervals.get(node);
        if (intervalId) {
            clearInterval(intervalId);
            intervals.delete(node);
        }
        
        // 清理所有待执行的 timeout
        const timeIds = timeouts.get(node);
        if (timeIds) {
            timeIds.forEach(id => clearTimeout(id));
            timeouts.delete(node);
        }
    }
    
    /**
     * 注册定时器
     */
    function registerTimeout(node, fn, delay) {
        if (!timeouts.has(node)) {
            timeouts.set(node, []);
        }
        const timeId = setTimeout(() => {
            fn();
            const ids = timeouts.get(node);
            if (ids) {
                const idx = ids.indexOf(timeId);
                if (idx > -1) ids.splice(idx, 1);
            }
        }, delay);
        timeouts.get(node).push(timeId);
    }
    
    return { startEnforcement, stopEnforcement, registerTimeout };
}

// ==========================================
// 文本变更回调
// ==========================================

/**
 * 创建文本变更回调 - 当本地操作修改了 customText 时自动切换到 LOCAL PROMPT 状态
 */
function createOnTextChangeCallback(statusBar, updateStatusAndUI, node) {
    return function() {
        if (!statusBar) return;
        
        const statusTextEl = statusBar.querySelector("span");
        if (statusTextEl && statusTextEl.textContent.includes("EXTERNAL INPUT")) {
            // 自动切换到 LOCAL PROMPT 状态 - set rs_disable_state to true so updateStatusAndUI applies green theme
            if (node) node.properties.rs_disable_state = true;
            const disableWidget = node?.widgets?.find(w => w.name === "disable_text_input");
            if (disableWidget) disableWidget.value = true;
            
            // 自动切换状态并更新 UI
            if (updateStatusAndUI) updateStatusAndUI();
            
            // 显示切换提示
            statusTextEl.textContent = "⚡ Switched to LOCAL PROMPT";
            statusBar.style.background = "#1a3a1a";
            statusBar.style.color = "#4ade80";
            
            setTimeout(() => {
                if (statusTextEl) {
                    statusTextEl.textContent = "🟢 LOCAL PROMPT";
                }
                statusBar.style.background = "";
                statusBar.style.color = "";
            }, 1500);
        }
    };
}

// ==========================================
// 导出
// ==========================================

export const NodeBehaviors = {
    // 工具函数
    getInstanceUid,
    getTextKey,
    setTextAndTrigger,
    saveTextToStorage,
    restoreTextFromStorage,

    // 节点初始化器工厂
    createBasicNodeInitializer,

    // 按钮处理器工厂
    createGenerateHandler,
    createRandomHandler,

    // 快捷输入消费标记
    markQuickInputConsumed,
    resetQuickInputConsumed,

    // 文本变更回调
    createOnTextChangeCallback,

    // 事件监听器
    createPopupCloser,
    createPromptUpdateHandler,
    createBeforeUnloadHandler,

    // 定时器管理
    createNodeBehaviorManager,
};

export default NodeBehaviors;
