/**
 * prompts.js
 * 主入口 - 节点注册、生命周期、增强/翻译
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { mkEl, createPromptManagerUI } from "./prompt-manager.js";
import { 
    enhancePrompt, translatePrompt, randomPrompt as randomPromptAPI
} from "./prompt-service.js";


// 导入 NodeBehaviors
import NodeBehaviors from "./node-behavior.js";

// ==========================================
// 本地模型自动卸载由后端在生成完成时处理：
// - 工作流自动生成：prompts.py 两条 auto-generate 路径
// - 手动 ✨ 生成：llm.py handle_llm_api_stream
// 均按 local 模式 + auto_unload_local 配置判断，无需前端监听执行事件。
// ==========================================

// ==========================================
// 共享的节点生命周期处理器工厂
// ==========================================

/**
 * 创建通用的 onConfigure 处理器
 */
function createOnConfigureHandler(node, promptUI) {
    return function(data) {
        if (this.widgets) {
            const disableWidget = this.widgets.find(w => w.name === "disable_text_input");
            if (disableWidget && this.properties?.rs_disable_state !== undefined) {
                disableWidget.value = this.properties.rs_disable_state;
            }
        }
        if (this.widgets) {
            const uidWidget = this.widgets.find(w => w.name === "instance_uid");
            if (uidWidget && this.properties?.rs_instance_uid !== undefined) {
                uidWidget.value = this.properties.rs_instance_uid;
            }
        }
        setTimeout(() => {
            if (this.restoreFromProperties) {
                this.restoreFromProperties();
            }
        }, 100);
    };
}

/**
 * 创建通用的 serialize 处理器
 */
function createSerializeHandler() {
    return function() {
        if (this.properties && this.widgets) {
            const uidWidget = this.widgets.find(w => w.name === "instance_uid");
            if (uidWidget && uidWidget.value) {
                this.properties.rs_instance_uid = uidWidget.value;
            }
        }
        if (this.widgets) {
            const disableWidget = this.widgets.find(w => w.name === "disable_text_input");
            if (disableWidget && this.properties) {
                this.properties.rs_disable_state = disableWidget.value;
            }
        }
    };
}

/**
 * 创建通用的 restoreFromProperties 处理器
 */
function createRestoreHandler(node, textWidget, customTextarea) {
    return function() {
        // In-memory cache only - no localStorage
        const instanceUid = NodeBehaviors.getInstanceUid(node);
        if (textWidget && textWidget.value) {
            if (customTextarea) customTextarea.value = textWidget.value;
        }
    };
}

/**
 * 创建通用的初始化处理器（设置基本属性）
 */
function createBasicNodeInitializer(node, instanceUid) {
    return function() {
        if (!node.properties) {
            node.properties = {};
        }
        // rs_disable_state 不在这里设置默认值，由调用方根据是否有 text_input 连接来决定
        if (node.properties.rs_waiting_prompt === undefined) {
            node.properties.rs_waiting_prompt = "";
        }
        if (node.properties.rs_waiting_timestamp === undefined) {
            node.properties.rs_waiting_timestamp = 0;
        }
    };
}


// ==========================================
// NeoPromptAgent Node Extension
// A simple prompt generator node - same as NeoPromptEncoder but without statusbar/toggle
// Only outputs STRING (the prompt text)
// ==========================================
app.registerExtension({
    name: "NeoPromptAgent",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoPromptAgent" && nodeData.name !== "NeoPromptGenerator") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnConfigure = nodeType.prototype.onConfigure;
        const origSerialize = nodeType.prototype.serialize;
        const origOnRemoved = nodeType.prototype.onRemoved;

        const _origOnConfigure = origOnConfigure || function() {};
        const _origSerialize = origSerialize || function() { return {}; };
        const _origOnRemoved = origOnRemoved;

        nodeType.prototype.onConfigure = function(data) {
            const result = _origOnConfigure.apply(this, arguments);
            const node = this;

            if (this.widgets) {
                const uidWidget = this.widgets.find(w => w.name === "instance_uid");
                if (uidWidget && this.properties?.rs_instance_uid !== undefined) {
                    uidWidget.value = this.properties.rs_instance_uid;
                }
            }
            if (this.widgets) {
                const disableWidget = this.widgets.find(w => w.name === "disable_text_input");
                if (disableWidget && this.properties?.rs_disable_state !== undefined) {
                    disableWidget.value = this.properties.rs_disable_state;
                }
                // Restore quick_input and auto_generate state
                const quickInputWidget = this.widgets.find(w => w.name === "quick_input");
                if (quickInputWidget && this.properties?.rs_quick_input !== undefined) {
                    quickInputWidget.value = this.properties.rs_quick_input;
                }
                const usedWidget = this.widgets.find(w => w.name === "quick_input_used");
                if (usedWidget && this.properties?.rs_quick_input_used !== undefined) {
                    usedWidget.value = this.properties.rs_quick_input_used;
                }
                const autoGenWidget = this.widgets.find(w => w.name === "auto_generate");
                if (autoGenWidget && this.properties?.rs_auto_generate !== undefined) {
                    autoGenWidget.value = this.properties.rs_auto_generate;
                }
                const randEnWidget = this.widgets.find(w => w.name === "random_enabled");
                const randCnWidget = this.widgets.find(w => w.name === "random_count");
                const rndProp = this.properties?.rs_runtime_random;
                if (randEnWidget && rndProp && typeof rndProp === "object") {
                    randEnWidget.value = !!rndProp.enabled;
                    if (randCnWidget) randCnWidget.value = Math.max(1, Math.min(rndProp.count || 1, 16));
                }
            }
            setTimeout(() => {
                if (this.restoreFromProperties) this.restoreFromProperties();
            }, 100);
            return result;
        };

        nodeType.prototype.serialize = function() {
            const node = this;
            if (node.properties && node.widgets) {
                const uidWidget = node.widgets.find(w => w.name === "instance_uid");
                if (uidWidget && uidWidget.value) node.properties.rs_instance_uid = uidWidget.value;
                const disableWidget = node.widgets.find(w => w.name === "disable_text_input");
                if (disableWidget && node.properties) node.properties.rs_disable_state = disableWidget.value;
                // Save quick_input and auto_generate state
                const quickInputWidget = node.widgets.find(w => w.name === "quick_input");
                if (quickInputWidget && node.properties) node.properties.rs_quick_input = quickInputWidget.value;
                const usedWidget = node.widgets.find(w => w.name === "quick_input_used");
                if (usedWidget && node.properties) node.properties.rs_quick_input_used = !!usedWidget.value;
                const autoGenWidget = node.widgets.find(w => w.name === "auto_generate");
                if (autoGenWidget && node.properties) node.properties.rs_auto_generate = autoGenWidget.value;
                const randEnWidget = node.widgets.find(w => w.name === "random_enabled");
                if (randEnWidget && node.properties) node.properties.rs_runtime_random = {
                    enabled: !!randEnWidget.value,
                    count: Math.max(1, Math.min(node.widgets.find(w => w.name === "random_count")?.value || 1, 16)),
                };
            }
            return _origSerialize.apply(this, arguments);
        };

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            NodeBehaviors.createBasicNodeInitializer(node)();

            let instanceUid = NodeBehaviors.getInstanceUid(node);
            node.properties.rs_instance_uid = instanceUid;

            // 初始化 rs_disable_state：默认为 LOCAL PROMPT (true)
            node.properties.rs_disable_state = true;

            const textWidget = node.widgets?.find(w => w.name === "prompt");
            const disableWidget = node.widgets?.find(w => w.name === "disable_text_input");
            const uidWidget = node.widgets?.find(w => w.name === "instance_uid");

            if (uidWidget) {
                uidWidget.value = instanceUid;
                uidWidget.hidden = true;
                uidWidget.serializeValue = () => node.properties.rs_instance_uid;
            }
            if (textWidget) textWidget.hidden = true;
            if (disableWidget) {
                disableWidget.value = node.properties.rs_disable_state;
                disableWidget.hidden = true;
            }

            // Create prompt manager UI FIRST
            const promptUI = createPromptManagerUI();
            const root = promptUI.root;

            // Add the custom DOM widget - this will contain all visible UI elements
            const widget = node.addDOMWidget("prompt_ui", "custom", root);

            // Set root element width to fill node
            root.style.width = "100%";
            root.style.maxWidth = "none";

            // Function to update widget width
            const updateWidgetWidth = () => {
                if (widget && node.size) {
                    widget.width = node.size[0];
                }
            };

            // Update width on resize
            node.onResize = node.onResize || function() {};
            const originalOnResize = node.onResize;
            node.onResize = function() {
                updateWidgetWidth();
                originalOnResize.apply(this, arguments);
            };

            // Initial width update
            updateWidgetWidth();

            node.setSize([370, 280]);
            node.minWidth = 370;
            node.minHeight = 260;

            // Initialize prompt manager - get UI elements and settings button
            // Pass textWidget so save handler can read current prompt text for AI extraction
            // allowRecipe: 在 💾 保存弹窗中启用「保存配方」按钮
            const {
                generateBtn, randomBtn, quickInput,
                customTextarea, statusBar, settingsBtn, toggleSwitch, localTab, externalTab,
                presetListOverlay, presetNameInput, deleteConfirmOverlay,
                quickInputWrapper, populateTemplateSelector, tplSelector, autoGenerateCheckbox,
                attachedImages, clearImages, refreshMarkdownPreviewAuto
            } = promptUI.init({ node, graph: node.graph, textWidget, allowRecipe: true });

            // Populate template selector, restore last selection and sync to hidden widget
            if (populateTemplateSelector) {
                setTimeout(async () => {
                    await populateTemplateSelector(node);
                    if (node.properties?.rs_selected_template) {
                        tplSelector.value = node.properties.rs_selected_template;
                    }
                    const tplWidget = node.widgets?.find(w => w.name === "template_id");
                    if (tplWidget) tplWidget.value = tplSelector.value;
                }, 100);
            }

            // Sync template selection so backend auto-generate uses the selected template
            tplSelector.addEventListener("change", () => {
                if (!node.properties) node.properties = {};
                node.properties.rs_selected_template = tplSelector.value;
                const tplWidget = node.widgets?.find(w => w.name === "template_id");
                if (tplWidget) tplWidget.value = tplSelector.value;
            });

            // Expose for rs.templates.updated listener to refresh this selector
            node._populateTemplateSelector = populateTemplateSelector;

            // Restore quickInput content from properties
            if (node.properties?.rs_quick_input !== undefined) {
                quickInput.value = node.properties.rs_quick_input;
            }

            // Node lifecycle management
            const behaviorManager = NodeBehaviors.createNodeBehaviorManager();

            // Save references for cleanup
            node._promptUIElements = { presetListOverlay, presetNameInput, deleteConfirmOverlay };

            const hasTextInputConnection = () => {
                return node.inputs?.some(i => i.name === "text_input" && i.link !== null) || false;
            };

            // Hide status bar if no text_input connection (no external input possible)
            let _hasTextInput = hasTextInputConnection();
            if (!_hasTextInput) {
                statusBar.style.display = "none";
            }

            // NeoPromptAgent UI update function (with toggle support)
            const updateStatusAndUI = (() => {
                const applyTheme = (isExternal) => {
                    if (isExternal) {
                        statusBar.style.background = "";
                        root.classList.remove("rs-theme-local");
                        root.classList.add("rs-theme-external");
                    } else {
                        statusBar.style.background = "";
                        root.classList.remove("rs-theme-external");
                        root.classList.add("rs-theme-local");
                    }
                };

                return () => {
                    const isDisabled = node.properties.rs_disable_state;

                    customTextarea.style.border = "1px solid #444";

                    // Update status bar visibility based on text_input connection
                    const hasConn = hasTextInputConnection();
                    if (hasConn && !statusBar.style.display) {
                        statusBar.style.display = "";
                        _hasTextInput = true;
                    } else if (!hasConn && statusBar.style.display !== "none") {
                        statusBar.style.display = "none";
                        _hasTextInput = false;
                    }

                    applyTheme(!isDisabled);

                    if (toggleSwitch && localTab && externalTab) {
                        if (isDisabled) {
                            // LOCAL PROMPT: local tab active (blue)
                            localTab.classList.add('active');
                            externalTab.classList.remove('active');
                        } else {
                            // EXTERNAL INPUT: external tab active (green)
                            localTab.classList.remove('active');
                            externalTab.classList.add('active');
                        }
                    }

                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };
            })();

            // Toggle switch click handler - tab-style
            if (localTab && externalTab) {
                localTab.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    node.properties.rs_disable_state = true; // LOCAL PROMPT
                    if (disableWidget) disableWidget.value = true;
                    updateStatusAndUI();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });

                externalTab.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const currentState = node.properties.rs_disable_state;
                    const newState = !currentState;

                    if (!newState && !hasTextInputConnection()) {
                        statusBar.style.background = "";
                        updateStatusAndUI();
                        setTimeout(() => updateStatusAndUI(), 1500);
                        return;
                    }

                    node.properties.rs_disable_state = newState;
                    if (disableWidget) disableWidget.value = node.properties.rs_disable_state;
                    updateStatusAndUI();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });
            }


            // Connection change handler - show/hide status bar when text_input is connected/disconnected
            node.onConnectionsChange = function(type, inputInfo) {
                // Always defer to next tick so link property has time to update
                setTimeout(() => {
                    const hasConn = node.inputs?.some(i => i.name === "text_input" && i.link !== null);
                    if (hasConn && statusBar.style.display === "none") {
                        statusBar.style.display = "";
                        _hasTextInput = true;
                        updateStatusAndUI();
                    } else if (!hasConn && statusBar.style.display !== "none") {
                        statusBar.style.display = "none";
                        _hasTextInput = false;
                        updateStatusAndUI();
                    }
                }, 0);
            };

            // Node removal cleanup
            node.onRemoved = function() {
                stopEnforcement();
                randomBtn._rsRuntime?.destroy?.();
                presetListOverlay.remove();
                presetNameInput.remove();
                deleteConfirmOverlay.remove();
                _origOnRemoved?.apply(this, arguments);
            };

            // Restore logic - use shared method
            node.restoreFromProperties = () => {
                NodeBehaviors.restoreTextFromStorage(node, textWidget, customTextarea);
                // Restore quick input content and auto-generate checkbox (runs after workflow configure)
                const quickInputWidget = node.widgets?.find(w => w.name === "quick_input");
                if (quickInput) {
                    const v = quickInputWidget ? quickInputWidget.value : node.properties?.rs_quick_input;
                    if (v !== undefined) quickInput.value = v;
                }
                if (autoGenerateCheckbox) {
                    const autoGenWidget = node.widgets?.find(w => w.name === "auto_generate");
                    const v = autoGenWidget ? autoGenWidget.value : node.properties?.rs_auto_generate;
                    if (v !== undefined) {
                    autoGenerateCheckbox.checked = !!v;
                    autoGenerateCheckbox.dispatchEvent(new Event("change"));
                }
                }
                updateStatusAndUI();
            };

            // 启动强制执行定时器
            let enforcementInterval = null;
            const startEnforcement = () => {
                if (enforcementInterval) clearInterval(enforcementInterval);
                enforcementInterval = setInterval(() => {
                    let needsRedraw = false;
                    if (disableWidget && disableWidget.value !== node.properties.rs_disable_state) {
                        disableWidget.value = node.properties.rs_disable_state;
                        needsRedraw = true;
                    }
                    if (needsRedraw && node.graph) node.graph.setDirtyCanvas(true, true);
                }, 200);
            };

            const stopEnforcement = () => {
                if (enforcementInterval) {
                    clearInterval(enforcementInterval);
                    enforcementInterval = null;
                }
                behaviorManager.stopEnforcement(node);
            };

            // Initialize
            setTimeout(() => {
                NodeBehaviors.restoreTextFromStorage(node, textWidget, customTextarea);

                if (disableWidget) {
                    const originalDisableCallback = disableWidget.callback;
                    disableWidget.callback = function(v) {
                        node.properties.rs_disable_state = v;
                        originalDisableCallback?.apply(this, arguments);
                        updateStatusAndUI();
                    };
                }

                // Force toggle to OFF state (LOCAL PROMPT) on initial creation
                if (toggleSwitch && localTab && externalTab) {
                    localTab.classList.add('active');
                    externalTab.classList.remove('active');
                }

                startEnforcement();
                updateStatusAndUI();
            }, 100);

            // Text input event - use shared method + auto-switch from EXTERNAL to LOCAL
            const onTextChange = NodeBehaviors.createOnTextChangeCallback(statusBar, updateStatusAndUI, node);
            customTextarea.addEventListener("input", () => {
                if (textWidget) textWidget.value = customTextarea.value;
                NodeBehaviors.saveTextToStorage(node, textWidget, customTextarea);
                onTextChange();
                if (node.graph) node.graph.setDirtyCanvas(true, true);
            });

            // Sync quickInput to backend hidden widget
            const quickInputWidget = node.widgets?.find(w => w.name === "quick_input");
            quickInput.addEventListener("input", () => {
                if (quickInputWidget) {
                    quickInputWidget.value = quickInput.value;
                    NodeBehaviors.resetQuickInputConsumed(node);
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                }
            });

            // ==========================================
            // Use shared button handlers (same as NeoPrompts)
            // ==========================================
            const promptUIRef = {
                generateBtn, randomBtn, quickInput,
                customTextarea, textWidget, node, graph: node.graph, statusBar: null,
                attachedImages, clearImages, refreshMarkdownPreviewAuto
            };

            const handleGeneratePrompt = NodeBehaviors.createGenerateHandler(
                { ...promptUIRef, quickInput, tplSelector });
            generateBtn.addEventListener("click", handleGeneratePrompt);
            // Enter to generate, Shift+Enter for newline
            quickInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleGeneratePrompt();
                }
            });

            randomBtn.addEventListener("click", NodeBehaviors.createRandomHandler(promptUIRef));

            // 运行时随机（🎲 ▾ 菜单）：状态持久化到 properties 与隐藏控件
            NodeBehaviors.wireRuntimeRandom(node, randomBtn);

            // ==========================================
            // Auto-generate checkbox handler
            // ==========================================
            if (autoGenerateCheckbox) {
                // Restore state from node properties
                if (node.properties?.rs_auto_generate !== undefined) {
                    autoGenerateCheckbox.checked = node.properties.rs_auto_generate;
                }

                autoGenerateCheckbox.addEventListener("change", () => {
                    if (!node.properties) node.properties = {};
                    node.properties.rs_auto_generate = autoGenerateCheckbox.checked;
                    // Update hidden widget if exists
                    const autoGenWidget = node.widgets?.find(w => w.name === "auto_generate");
                    if (autoGenWidget) {
                        autoGenWidget.value = autoGenerateCheckbox.checked;
                    }
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });

                // Listen for auto_generate_update event from backend (streaming)
                api.addEventListener("rs.prompt.auto_generate_update", (event) => {
                    const currentUid = node.properties?.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                    if (event.detail.instance_uid === currentUid) {
                        const promptText = event.detail.prompt || "";
                        // Update customTextarea with streaming text
                        if (customTextarea) {
                            customTextarea.value = promptText;
                            customTextarea.scrollTop = customTextarea.scrollHeight;
                        }
                        // Update textWidget
                        if (textWidget) {
                            textWidget.value = promptText;
                        }
                        // Update storage
                        NodeBehaviors.saveTextToStorage(node, textWidget, customTextarea);
                        // Redraw canvas
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                    }
                });
            }

            // ==========================================
            // Use shared event listeners
            // ==========================================
            document.addEventListener("click", NodeBehaviors.createPopupCloser({
                presetListOverlay, presetNameInput, deleteConfirmOverlay, saveBtn: null, listBtn: null, quickInputWrapper
            }));

            api.addEventListener("rs.prompt.update", NodeBehaviors.createPromptUpdateHandler(
                { customTextarea, textWidget, node, graph: node.graph, randomBtn }
            ));

            window.addEventListener("beforeunload", NodeBehaviors.createBeforeUnloadHandler(node, textWidget));

            // Expose node reference for external apps (like gallery)
            node._rsPromptUIElements = { customTextarea, textWidget };




            return result;
        };
    }
});

// ==========================================
// Listen for gallery prompt send events
// ==========================================
let _sentPromptCount = 0;

// Use document.addEventListener to receive events from gallery
document.addEventListener("gallery.send.prompt", (event) => {
    const { prompt, nodeIds } = event.detail;
    if (!prompt) return;

    console.log('[gallery.send.prompt] Received event:', { prompt, nodeIds });

    // If nodeIds specified, send to those nodes only
    if (nodeIds && nodeIds.length > 0) {
        for (const nodeId of nodeIds) {
            const node = app.graph.getNodeById(nodeId);
            console.log('[gallery.send.prompt] Looking for node:', nodeId, 'found:', node);
            if (node && node._rsPromptUIElements) {
                const { customTextarea, textWidget } = node._rsPromptUIElements;
                if (customTextarea) {
                    customTextarea.value = prompt;
                    if (textWidget) textWidget.value = prompt;
                    // Trigger input event to update storage
                    customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
                    console.log('[gallery.send.prompt] Sent to node', nodeId);
                }
            }
        }
        return;
    }

    // Otherwise, find the first available NeoPromptEncoder or NeoPromptAgent node
    let sent = false;
    app.graph._nodes.forEach(node => {
        if (sent) return;
        if (node._rsPromptUIElements) {
            const { customTextarea, textWidget } = node._rsPromptUIElements;
            if (customTextarea) {
                customTextarea.value = prompt;
                if (textWidget) textWidget.value = prompt;
                customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
                sent = true;
                console.log('[gallery.send.prompt] Sent to node', node.id);
            }
        }
    });

    if (!sent) {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(prompt);
    }
});

// Refresh template selectors on all Neo prompt nodes when templates change
// (dispatched by the settings window after save/copy/delete)
document.addEventListener("rs.templates.updated", () => {
    app.graph?._nodes?.forEach(node => {
        if (typeof node._populateTemplateSelector === "function") {
            node._populateTemplateSelector(node);
        }
    });
});

window.addEventListener("beforeunload", NodeBehaviors.createBeforeUnloadHandler);

// ==========================================
// Reference external CSS file
// ==========================================
const cssLink = document.createElement('link');
cssLink.rel = 'stylesheet';
cssLink.href = "/extensions/ComfyUI-Neo-Nodes/prompts.css";
document.head.appendChild(cssLink);

// ==========================================
// Main Node Logic for NeoPromptEncoder
// ==========================================

app.registerExtension({
    name: "NeoPromptEncoder",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoPromptEncoder") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnConfigure = nodeType.prototype.onConfigure;
        const origSerialize = nodeType.prototype.serialize;
        const origOnRemoved = nodeType.prototype.onRemoved;

        const _origOnConfigure = origOnConfigure || function() {};
        const _origSerialize = origSerialize || function() { return {}; };
        const _origOnRemoved = origOnRemoved;

        // 重写 onConfigure - 共享逻辑
        nodeType.prototype.onConfigure = function(data) {
            const result = _origOnConfigure.apply(this, arguments);
            const node = this;

            if (this.properties?.rs_instance_uid && this.widgets) {
                const uidWidget = this.widgets.find(w => w.name === "instance_uid");
                if (uidWidget) uidWidget.value = this.properties.rs_instance_uid;
            }
            if (this.widgets) {
                const disableWidget = this.widgets.find(w => w.name === "disable_text_input");
                if (disableWidget && this.properties?.rs_disable_state !== undefined) {
                    disableWidget.value = this.properties.rs_disable_state;
                }
                // Restore quick_input and auto_generate state
                const quickInputWidget = this.widgets.find(w => w.name === "quick_input");
                if (quickInputWidget && this.properties?.rs_quick_input !== undefined) {
                    quickInputWidget.value = this.properties.rs_quick_input;
                }
                const usedWidget = this.widgets.find(w => w.name === "quick_input_used");
                if (usedWidget && this.properties?.rs_quick_input_used !== undefined) {
                    usedWidget.value = this.properties.rs_quick_input_used;
                }
                const autoGenWidget = this.widgets.find(w => w.name === "auto_generate");
                if (autoGenWidget && this.properties?.rs_auto_generate !== undefined) {
                    autoGenWidget.value = this.properties.rs_auto_generate;
                }
                const randEnWidget = this.widgets.find(w => w.name === "random_enabled");
                const randCnWidget = this.widgets.find(w => w.name === "random_count");
                const rndProp = this.properties?.rs_runtime_random;
                if (randEnWidget && rndProp && typeof rndProp === "object") {
                    randEnWidget.value = !!rndProp.enabled;
                    if (randCnWidget) randCnWidget.value = Math.max(1, Math.min(rndProp.count || 1, 16));
                }
            }
            setTimeout(() => {
                if (this.restoreFromProperties) this.restoreFromProperties();
            }, 100);
            return result;
        };

        // 重写 serialize - 共享逻辑
        nodeType.prototype.serialize = function() {
            const node = this;
            if (node.properties && node.widgets) {
                const uidWidget = node.widgets.find(w => w.name === "instance_uid");
                if (uidWidget && uidWidget.value) node.properties.rs_instance_uid = uidWidget.value;
                const disableWidget = node.widgets.find(w => w.name === "disable_text_input");
                if (disableWidget && node.properties) node.properties.rs_disable_state = disableWidget.value;
                // Save quick_input and auto_generate state
                const quickInputWidget = node.widgets.find(w => w.name === "quick_input");
                if (quickInputWidget && node.properties) node.properties.rs_quick_input = quickInputWidget.value;
                const usedWidget = node.widgets.find(w => w.name === "quick_input_used");
                if (usedWidget && node.properties) node.properties.rs_quick_input_used = !!usedWidget.value;
                const autoGenWidget = node.widgets.find(w => w.name === "auto_generate");
                if (autoGenWidget && node.properties) node.properties.rs_auto_generate = autoGenWidget.value;
                const randEnWidget = node.widgets.find(w => w.name === "random_enabled");
                if (randEnWidget && node.properties) node.properties.rs_runtime_random = {
                    enabled: !!randEnWidget.value,
                    count: Math.max(1, Math.min(node.widgets.find(w => w.name === "random_count")?.value || 1, 16)),
                };
            }
            return _origSerialize.apply(this, arguments);
        };

        // 重写 onNodeCreated
        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            NodeBehaviors.createBasicNodeInitializer(node)();

            let instanceUid = NodeBehaviors.getInstanceUid(node);
            node.properties.rs_instance_uid = instanceUid;

            // 初始化 rs_disable_state：默认为 LOCAL PROMPT (true)
            node.properties.rs_disable_state = true;

            const textWidget = node.widgets?.find(w => w.name === "text");
            const disableWidget = node.widgets?.find(w => w.name === "disable_text_input");
            const uidWidget = node.widgets?.find(w => w.name === "instance_uid");

            if (uidWidget) {
                uidWidget.value = instanceUid;
                uidWidget.hidden = true;
                uidWidget.serializeValue = () => node.properties.rs_instance_uid;
            }
            if (textWidget) textWidget.hidden = true;
            if (disableWidget) {
                disableWidget.value = node.properties.rs_disable_state;
                disableWidget.hidden = true;
            }

            // 隐藏虚拟插槽
            const hidePhantomSlot = () => {
                if (node.inputs) {
                    const textInput = node.inputs.find(i => i.name === "text");
                    if (textInput) {
                        textInput.disabled = true;
                        textInput.color_on = "transparent";
                        textInput.color_off = "transparent";
                        textInput.pos = [-1000, -1000];
                    }
                }
            };
            setTimeout(hidePhantomSlot, 0);

            // 创建提示词管理 UI
            const promptUI = createPromptManagerUI();
            const root = promptUI.root;
            const widget = node.addDOMWidget("prompt_ui", "custom", root);

            // Set root element width to fill node
            root.style.width = "100%";
            root.style.maxWidth = "none";

            // Function to update widget width
            const updateWidgetWidth = () => {
                if (widget && node.size) {
                    widget.width = node.size[0];
                }
            };

            // Update width on resize
            node.onResize = node.onResize || function() {};
            const originalOnResize = node.onResize;
            node.onResize = function() {
                updateWidgetWidth();
                originalOnResize.apply(this, arguments);
            };

            // Initial width update
            updateWidgetWidth();
            node.setSize([370, 280]);
            node.minWidth = 370;
            node.minHeight = 260;

            // 初始化提示词管理器
            const {
                generateBtn, randomBtn, quickInput,
                customTextarea, statusBar, settingsBtn, toggleSwitch, localTab, externalTab,
                presetListOverlay, presetNameInput, deleteConfirmOverlay,
                quickInputWrapper, populateTemplateSelector, tplSelector, autoGenerateCheckbox,
                attachedImages, clearImages, refreshMarkdownPreviewAuto
            } = promptUI.init({ node, graph: node.graph, textWidget, allowRecipe: true });

            // Populate template selector, restore last selection and sync to hidden widget
            if (populateTemplateSelector) {
                setTimeout(async () => {
                    await populateTemplateSelector(node);
                    if (node.properties?.rs_selected_template) {
                        tplSelector.value = node.properties.rs_selected_template;
                    }
                    const tplWidget = node.widgets?.find(w => w.name === "template_id");
                    if (tplWidget) tplWidget.value = tplSelector.value;
                }, 100);
            }

            // Sync template selection so backend auto-generate uses the selected template
            tplSelector.addEventListener("change", () => {
                if (!node.properties) node.properties = {};
                node.properties.rs_selected_template = tplSelector.value;
                const tplWidget = node.widgets?.find(w => w.name === "template_id");
                if (tplWidget) tplWidget.value = tplSelector.value;
            });

            // Expose for rs.templates.updated listener to refresh this selector
            node._populateTemplateSelector = populateTemplateSelector;

            // Restore quickInput content from properties
            if (node.properties?.rs_quick_input !== undefined) {
                quickInput.value = node.properties.rs_quick_input;
            }

            // 节点生命周期管理 - 使用共享的 behaviorManager
            const behaviorManager = NodeBehaviors.createNodeBehaviorManager();
            let enforcementInterval = null;
            let waitingOverlay = null;

            // NeoPromptEncoder 特有的功能
            const removeWaitingOverlay = () => {
                if (waitingOverlay && waitingOverlay.parentNode) {
                    waitingOverlay.remove();
                    waitingOverlay = null;
                }
            };

            const showWaitingOverlay = () => {
                removeWaitingOverlay();
                waitingOverlay = mkEl("div", "rs-waiting-overlay");
                const messageDiv = mkEl("div", "rs-waiting-message");
                messageDiv.innerHTML = `
                    <div style="color:#fbbf24; font-size:14px; margin-bottom:10px; font-weight:bold;">✏️ EDITING MODE</div>
                    <div style="color:#ccc; font-size:12px;">Edit the prompt below and click APPROVE</div>
                `;
                waitingOverlay.appendChild(messageDiv);
                const domWidget = node.domWidgets?.find(w => w.name === "prompt_ui");
                if (domWidget && domWidget.element) {
                    domWidget.element.appendChild(waitingOverlay);
                }
            };

            const hasTextInputConnection = () => {
                return node.inputs?.some(i => i.name === "text_input" && i.link !== null) || false;
            };

            // Hide status bar if no text_input connection (no external input possible)
            let _hasTextInput = hasTextInputConnection();
            if (!_hasTextInput) {
                statusBar.style.display = "none";
            }

            // 保存引用用于清理
            node._promptUIElements = { presetListOverlay, presetNameInput, deleteConfirmOverlay };

            // NeoPromptEncoder 特有的 UI 更新函数（包含 toggle switch 逻辑）
            const updateStatusAndUI = (() => {
                const applyTheme = (isExternal) => {
                    if (isExternal) {
                        statusBar.style.background = "";
                        root.classList.remove("rs-theme-local");
                        root.classList.add("rs-theme-external");
                    } else {
                        statusBar.style.background = "";
                        root.classList.remove("rs-theme-external");
                        root.classList.add("rs-theme-local");
                    }
                };

                return () => {
                    const isDisabled = node.properties.rs_disable_state;
                    removeWaitingOverlay();

                    customTextarea.style.border = "1px solid #444";

                    // Update status bar visibility based on text_input connection
                    const hasConn = hasTextInputConnection();
                    if (hasConn && !statusBar.style.display) {
                        statusBar.style.display = "";
                        _hasTextInput = true;
                    } else if (!hasConn && statusBar.style.display !== "none") {
                        statusBar.style.display = "none";
                        _hasTextInput = false;
                    }

                    applyTheme(!isDisabled);

                    if (toggleSwitch && localTab && externalTab) {
                        if (isDisabled) {
                            // LOCAL PROMPT: local tab active (blue)
                            localTab.classList.add('active');
                            externalTab.classList.remove('active');
                        } else {
                            // EXTERNAL INPUT: external tab active (green)
                            localTab.classList.remove('active');
                            externalTab.classList.add('active');
                        }
                    }

                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };
            })();

            // 启动强制执行定时器（NeoPromptEncoder 特有：检查 disableWidget）
            const startEnforcement = () => {
                if (enforcementInterval) clearInterval(enforcementInterval);
                enforcementInterval = setInterval(() => {
                    let needsRedraw = false;
                    if (disableWidget && disableWidget.value !== node.properties.rs_disable_state) {
                        disableWidget.value = node.properties.rs_disable_state;
                        needsRedraw = true;
                    }
                    if (needsRedraw && node.graph) node.graph.setDirtyCanvas(true, true);
                }, 200);
            };

            const stopEnforcement = () => {
                if (enforcementInterval) {
                    clearInterval(enforcementInterval);
                    enforcementInterval = null;
                }
                behaviorManager.stopEnforcement(node);
            };

            // Toggle switch click handler - NeoPromptEncoder 特有功能 (tab-style)
            if (localTab && externalTab) {
                localTab.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    node.properties.rs_disable_state = true; // LOCAL PROMPT
                    if (disableWidget) disableWidget.value = true;
                    updateStatusAndUI();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });

                externalTab.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const currentState = node.properties.rs_disable_state;
                    const newState = !currentState;

                    if (!newState && !hasTextInputConnection()) {
                        statusBar.style.background = "";
                        statusBar.style.color = "#fbbf24";
                        // 保持当前状态不变，更新 UI
                        updateStatusAndUI();
                        setTimeout(() => updateStatusAndUI(), 1500);
                        return;
                    }

                    node.properties.rs_disable_state = newState;
                    if (disableWidget) disableWidget.value = node.properties.rs_disable_state;
                    updateStatusAndUI();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });
            }


            // Connection change handler - show/hide status bar when text_input is connected/disconnected
            node.onConnectionsChange = function(type, inputInfo) {
                // Always defer to next tick so link property has time to update
                setTimeout(() => {
                    const hasConn = node.inputs?.some(i => i.name === "text_input" && i.link !== null);
                    if (hasConn && statusBar.style.display === "none") {
                        statusBar.style.display = "";
                        _hasTextInput = true;
                        updateStatusAndUI();
                    } else if (!hasConn && statusBar.style.display !== "none") {
                        statusBar.style.display = "none";
                        _hasTextInput = false;
                        updateStatusAndUI();
                    }
                }, 0);
            };

            // Node removal cleanup
            node.onRemoved = function() {
                stopEnforcement();
                randomBtn._rsRuntime?.destroy?.();
                presetListOverlay.remove();
                presetNameInput.remove();
                deleteConfirmOverlay.remove();
                _origOnRemoved?.apply(this, arguments);
            };

            // 恢复逻辑 - 使用共享方法
            node.restoreFromProperties = () => {
                NodeBehaviors.restoreTextFromStorage(node, textWidget, customTextarea);
                // 恢复 quick_input 内容和自动生成勾选状态（在工作流 configure 之后调用）
                const quickInputWidget = node.widgets?.find(w => w.name === "quick_input");
                if (quickInput) {
                    const v = quickInputWidget ? quickInputWidget.value : node.properties?.rs_quick_input;
                    if (v !== undefined) quickInput.value = v;
                }
                if (autoGenerateCheckbox) {
                    const autoGenWidget = node.widgets?.find(w => w.name === "auto_generate");
                    const v = autoGenWidget ? autoGenWidget.value : node.properties?.rs_auto_generate;
                    if (v !== undefined) {
                    autoGenerateCheckbox.checked = !!v;
                    autoGenerateCheckbox.dispatchEvent(new Event("change"));
                }
                }
                updateStatusAndUI();
            };

            // 初始化
            setTimeout(() => {
                NodeBehaviors.restoreTextFromStorage(node, textWidget, customTextarea);

                if (disableWidget) {
                    const originalDisableCallback = disableWidget.callback;
                    disableWidget.callback = function(v) {
                        node.properties.rs_disable_state = v;
                        originalDisableCallback?.apply(this, arguments);
                        updateStatusAndUI();
                    };
                }

                // Force toggle to OFF state (LOCAL PROMPT) on initial creation
                if (toggleSwitch && localTab && externalTab) {
                    localTab.classList.add('active');
                    externalTab.classList.remove('active');
                }

                startEnforcement();
                updateStatusAndUI();
            }, 100);

            // 文本输入事件 - 使用共享方法 + auto-switch from EXTERNAL to LOCAL
            const onTextChange = NodeBehaviors.createOnTextChangeCallback(statusBar, updateStatusAndUI, node);
            customTextarea.addEventListener("input", () => {
                if (textWidget) textWidget.value = customTextarea.value;
                NodeBehaviors.saveTextToStorage(node, textWidget, customTextarea);
                onTextChange();
                if (node.graph) node.graph.setDirtyCanvas(true, true);
            });

            // Sync quickInput to backend hidden widget
            const quickInputWidget = node.widgets?.find(w => w.name === "quick_input");
            quickInput.addEventListener("input", () => {
                if (quickInputWidget) {
                    quickInputWidget.value = quickInput.value;
                    NodeBehaviors.resetQuickInputConsumed(node);
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                }
            });

            // ==========================================
            // 使用共享的按钮处理器（与 NeoPromptAgent 相同）
            // ==========================================
            const promptUIRef = {
                generateBtn, randomBtn, quickInput,
                customTextarea, textWidget, node, graph: node.graph, statusBar,
                attachedImages, clearImages, refreshMarkdownPreviewAuto
            };

            const handleGeneratePrompt = NodeBehaviors.createGenerateHandler(
                { ...promptUIRef, quickInput, tplSelector });
            generateBtn.addEventListener("click", handleGeneratePrompt);
            // Enter to generate, Shift+Enter for newline
            quickInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleGeneratePrompt();
                }
            });

            randomBtn.addEventListener("click", NodeBehaviors.createRandomHandler(promptUIRef));

            // 运行时随机（🎲 ▾ 菜单）：状态持久化到 properties 与隐藏控件
            NodeBehaviors.wireRuntimeRandom(node, randomBtn);

            // ==========================================
            // Auto-generate checkbox handler
            // ==========================================
            if (autoGenerateCheckbox) {
                // Restore state from node properties
                if (node.properties?.rs_auto_generate !== undefined) {
                    autoGenerateCheckbox.checked = node.properties.rs_auto_generate;
                }

                autoGenerateCheckbox.addEventListener("change", () => {
                    if (!node.properties) node.properties = {};
                    node.properties.rs_auto_generate = autoGenerateCheckbox.checked;
                    // Update hidden widget if exists
                    const autoGenWidget = node.widgets?.find(w => w.name === "auto_generate");
                    if (autoGenWidget) {
                        autoGenWidget.value = autoGenerateCheckbox.checked;
                    }
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });

                // Listen for auto_generate_update event from backend (streaming)
                api.addEventListener("rs.prompt.auto_generate_update", (event) => {
                    const currentUid = node.properties?.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                    if (event.detail.instance_uid === currentUid) {
                        const promptText = event.detail.prompt || "";
                        // Update customTextarea with streaming text
                        if (customTextarea) {
                            customTextarea.value = promptText;
                            customTextarea.scrollTop = customTextarea.scrollHeight;
                        }
                        // Update textWidget
                        if (textWidget) {
                            textWidget.value = promptText;
                        }
                        // Update storage
                        NodeBehaviors.saveTextToStorage(node, textWidget, customTextarea);
                        // Redraw canvas
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                    }
                });
            }

            // ==========================================
            // Use shared event listeners
            // ==========================================
            document.addEventListener("click", NodeBehaviors.createPopupCloser({
                presetListOverlay, presetNameInput, deleteConfirmOverlay, saveBtn: null, listBtn: null, quickInputWrapper
            }));

            api.addEventListener("rs.prompt.update", NodeBehaviors.createPromptUpdateHandler(
                { customTextarea, textWidget, node, graph: node.graph, randomBtn }
            ));

            window.addEventListener("beforeunload", NodeBehaviors.createBeforeUnloadHandler(node, textWidget));

            // Expose node reference for external apps (like gallery)
            node._rsPromptUIElements = { customTextarea, textWidget };

            return result;
        };
    }
});
