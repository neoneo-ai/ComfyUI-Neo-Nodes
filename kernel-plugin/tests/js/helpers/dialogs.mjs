// alert/confirm/prompt 拦截：jsdom 的内置实现会抛 "not implemented"，必须替换并记录消息。
export const dialogs = {
    alerts: [],
    confirms: [],
    prompts: [],
    confirmAnswer: true,
    promptAnswer: "",
};

function defineOn(targets, name, value) {
    for (const target of targets) {
        Object.defineProperty(target, name, { value, configurable: true, writable: true });
    }
}

export function installDialogs(win) {
    const targets = [globalThis, win];
    defineOn(targets, "alert", (msg) => {
        dialogs.alerts.push(String(msg));
    });
    defineOn(targets, "confirm", (msg) => {
        dialogs.confirms.push(String(msg));
        return dialogs.confirmAnswer;
    });
    defineOn(targets, "prompt", (msg) => {
        dialogs.prompts.push(String(msg));
        return dialogs.promptAnswer;
    });
}

export function setConfirmAnswer(answer) {
    dialogs.confirmAnswer = answer;
}

export function resetDialogs() {
    dialogs.alerts.length = 0;
    dialogs.confirms.length = 0;
    dialogs.prompts.length = 0;
    dialogs.confirmAnswer = true;
    dialogs.promptAnswer = "";
}

export function dialogTrace() {
    return [
        ...dialogs.alerts.map((m) => `alert: ${m}`),
        ...dialogs.confirms.map((m) => `confirm(${dialogs.confirmAnswer}): ${m}`),
    ].join("\n");
}
