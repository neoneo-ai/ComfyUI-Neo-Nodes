// 测试环境入口：注册模块钩子、建 jsdom、装桩。插件模块必须在导入本模块之后动态 import。
import { installHooks } from "./hooks.mjs";

installHooks();

import { JSDOM } from "jsdom";
import {
    installGlobals,
    installDeterminism,
    installMediaStub,
    installObserverStub,
    installRectStub,
    resetDeterminism,
} from "./helpers/env.mjs";
import { installDialogs, resetDialogs, setConfirmAnswer, dialogs } from "./helpers/dialogs.mjs";
import { installFetch, mockRoute, clearRoutes, resetFetchLog, fetchLog, missingRoutes, jsonResponse, sseResponse } from "./helpers/fetch.mjs";

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "http://test.local/",
});

export const window = dom.window;

installGlobals(dom.window);
installDeterminism(dom.window);
installMediaStub(dom.window);
installObserverStub(dom.window);
installRectStub(dom.window);
installDialogs(dom.window);
installFetch();

export { mockRoute, clearRoutes, resetFetchLog, fetchLog, missingRoutes, jsonResponse, sseResponse };
export { dialogs, setConfirmAnswer, resetDialogs };
export { resetDeterminism };
export { assertGolden, serializeDom, domSnapshot, fire, click, keydown, inputText, changeValue, makeFile, pasteClipboard, dropFiles, clearBody, flush, sleep } from "./helpers/dom.mjs";
export * as graph from "./helpers/fake-graph.mjs";

export function resetEnv() {
    resetDeterminism();
    resetDialogs();
    resetFetchLog();
    document.body.innerHTML = "";
}
