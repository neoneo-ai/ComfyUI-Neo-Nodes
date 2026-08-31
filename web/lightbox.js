/**
 * lightbox.js — Neo-Nodes 通用 Lightbox 组件（自包含、可复用）。
 *
 * 全屏媒体查看：深色遮罩 + 居中卡片；图片滚轮缩放(0.5–5x) + 拖拽平移；
 * ←/→ 翻页（箭头按钮 + i/n 计数）；Esc 关闭/退出全屏；F 键全屏；点遮罩关闭。
 * 单例：同一时刻只有一个实例，再次 open() 会替换当前实例并清理其监听器。
 *
 * 用法：
 *   Lightbox.open({
 *     items: [{ kind: 'image'|'video'|'audio', url, title }],
 *     index: 0,   // 可选：起始项
 *     actions: (item, index) => [{ label, title, onClick(item, li) }], // 函数按项定额外按钮；也接受普通数组
 *   });
 */
import { $el } from "../../../../scripts/ui.js";

// 组件自带样式（幂等注入，调用方无需单独加载 CSS）
if (!document.getElementById('neo-lightbox-css')) {
    const link = document.createElement('link');
    link.id = 'neo-lightbox-css';
    link.rel = 'stylesheet';
    link.href = '/extensions/ComfyUI-Neo-Nodes/lightbox.css';
    document.head.appendChild(link);
}

export class Lightbox {
    static get instance() {
        if (!this._instance) this._instance = new Lightbox();
        return this._instance;
    }

    /** 打开 Lightbox；重复调用会替换当前实例。options: { items, index, actions }。 */
    static open(options) { return Lightbox.instance.open(options); }

    static close() { return Lightbox.instance.close(); }

    constructor() {
        this.items = [];
        this.index = 0;
        this.actionsProvider = null;

        this._root = null;      // 遮罩
        this._box = null;       // 卡片
        this._stage = null;     // 媒体区
        this._media = null;     // 当前媒体元素
        this._caption = null;
        this._counter = null;
        this._toolbar = null;
        this._prevBtn = null;
        this._nextBtn = null;
        this._fullBtn = null;
        this._closeBtn = null;

        // 图片缩放/平移状态
        this._scale = 1;
        this._panX = 0;
        this._panY = 0;
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._zoomHandlers = null;

        this._onKey = null;
        this._onFsChange = null;
    }

    open({ items = [], index = 0, actions = null } = {}) {
        this.close();
        if (!items.length) return this;

        this.items = items;
        this.actionsProvider = actions;
        this.index = Math.max(0, Math.min(index, items.length - 1));

        this._root = $el('div', {
            className: 'neo-lightbox',
            onclick: (e) => { if (e.target === this._root) this.close(); }
        });

        this._closeBtn = $el('button', {
            className: 'neo-lightbox-close', textContent: '×',
            title: '关闭（Esc）',
            onclick: (e) => { e.stopPropagation(); this.close(); }
        });
        this._prevBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-prev', textContent: '‹',
            title: '上一张（←）',
            onclick: (e) => { e.stopPropagation(); this.navigate(-1); }
        });
        this._nextBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-next', textContent: '›',
            title: '下一张（→）',
            onclick: (e) => { e.stopPropagation(); this.navigate(1); }
        });
        this._fullBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-full', textContent: '⛶',
            title: '全屏（F）',
            onclick: (e) => { e.stopPropagation(); this.toggleFullscreen(); }
        });

        this._stage = $el('div', { className: 'neo-lightbox-stage' });
        this._caption = $el('div', { className: 'neo-lightbox-caption' });
        this._counter = $el('span', { className: 'neo-lightbox-counter' });
        this._toolbar = $el('div', { className: 'neo-lightbox-toolbar' });
        const meta = $el('div', { className: 'neo-lightbox-meta' }, [this._counter, this._caption, this._toolbar]);

        this._box = $el('div', { className: 'neo-lightbox-box' }, [
            this._stage,
            meta,
            this._closeBtn,
            this._prevBtn,
            this._nextBtn,
            this._fullBtn
        ]);
        this._root.appendChild(this._box);
        document.body.appendChild(this._root);
        this._render();

        this._onKey = (e) => {
            switch (e.key) {
                case 'ArrowLeft': this.navigate(-1); break;
                case 'ArrowRight': this.navigate(1); break;
                case 'Escape':
                    if (document.fullscreenElement) document.exitFullscreen();
                    else this.close();
                    break;
                case 'f':
                case 'F':
                    // 视频项不响应 F 全屏（用原生控件全屏）
                    if (this.items[this.index]?.kind !== 'video') this.toggleFullscreen();
                    break;
            }
        };
        document.addEventListener('keydown', this._onKey);

        this._onFsChange = () => {
            if (!document.fullscreenElement) {
                this._box?.classList.remove('fullscreen-mode');
                this._root?.classList.remove('neo-lightbox-fullscreen');
            }
        };
        document.addEventListener('fullscreenchange', this._onFsChange);
        return this;
    }

_render() {
        if (!this._stage) return;
        const item = this.items[this.index];
        if (!item) return;

        this._removeZoom();
        if (this._media) { this._media.remove(); this._media = null; }

        const tag = item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'img';
        const media = document.createElement(tag);
        media.className = `neo-lightbox-media neo-lightbox-${item.kind || 'image'}`;
        media.draggable = false;
        media.src = item.url;
        if (tag === 'video') { media.controls = true; media.autoplay = true; media.loop = true; }
        else if (tag === 'audio') { media.controls = true; }
        else { media.alt = item.title || ''; }
        this._stage.appendChild(media);
        this._media = media;
        this._attachZoom();

        this._caption.textContent = item.title || '';
        this._counter.textContent = this.items.length > 1 ? `${this.index + 1} / ${this.items.length}` : '';
        this._prevBtn.disabled = this.index <= 0;
        this._nextBtn.disabled = this.index >= this.items.length - 1;
        // 视频原生控件自带全屏按钮，隐藏自定义全屏按钮
        this._fullBtn.classList.toggle('neo-lightbox-hidden', item.kind === 'video');

        // 动作按钮：函数可按当前项定制，数组则所有项相同
        this._toolbar.innerHTML = '';
        const actions = typeof this.actionsProvider === 'function'
            ? (this.actionsProvider(item, this.index) || [])
            : (this.actionsProvider || []);
        for (const a of actions) {
            this._toolbar.appendChild($el('button', {
                className: 'neo-lightbox-action',
                textContent: a.label,
                title: a.title || a.label,
                onclick: (e) => { e.stopPropagation(); a.onClick?.(item, this); }
            }));
        }
        this._root.classList.toggle('neo-lightbox-single', this.items.length <= 1);
    }

    navigate(direction) {
        const next = this.index + direction;
        if (next < 0 || next >= this.items.length) return;
        this.index = next;
        this._render();
    }

    // ===== 图片缩放 / 拖拽平移 =====

    _attachZoom() {
        if (!this._media || this._media.tagName !== 'IMG' || !this._stage) return;
        const stage = this._stage;
        const handlers = {};

        handlers.wheel = (e) => {
            e.preventDefault(); e.stopPropagation();
            this._scale = Math.max(0.5, Math.min(5, this._scale + (e.deltaY > 0 ? -0.1 : 0.1)));
            this._applyTransform();
        };
        handlers.down = (e) => {
            if (this._scale <= 1) return;
            e.preventDefault(); e.stopPropagation();
            this._dragging = true;
            this._dragStartX = e.clientX - this._panX;
            this._dragStartY = e.clientY - this._panY;
        };
        handlers.move = (e) => {
            if (!this._dragging) return;
            e.preventDefault(); e.stopPropagation();
            this._panX = e.clientX - this._dragStartX;
            this._panY = e.clientY - this._dragStartY;
            this._applyTransform();
        };
        handlers.up = () => { this._dragging = false; this._applyTransform(); };
        handlers.leave = () => { this._dragging = false; this._applyTransform(); };

        stage.addEventListener('wheel', handlers.wheel, { passive: false });
        stage.addEventListener('mousedown', handlers.down);
        stage.addEventListener('mousemove', handlers.move);
        stage.addEventListener('mouseup', handlers.up);
        stage.addEventListener('mouseleave', handlers.leave);
        this._zoomHandlers = handlers;
    }

    _removeZoom() {
        if (!this._zoomHandlers || !this._stage) return;
        const { wheel, down, move, up, leave } = this._zoomHandlers;
        this._stage.removeEventListener('wheel', wheel);
        this._stage.removeEventListener('mousedown', down);
        this._stage.removeEventListener('mousemove', move);
        this._stage.removeEventListener('mouseup', up);
        this._stage.removeEventListener('mouseleave', leave);
        this._zoomHandlers = null;
        this._scale = 1;
        this._panX = 0;
        this._panY = 0;
        this._dragging = false;
    }

    _applyTransform() {
        if (!this._media) return;
        if (this._scale === 1) {
            this._media.style.transform = 'none';
            this._media.style.cursor = 'default';
        } else {
            this._media.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._scale})`;
            this._media.style.cursor = this._dragging ? 'grabbing' : 'grab';
        }
    }

// ===== 全屏 =====

    toggleFullscreen() {
        if (!this._box) return;
        if (!document.fullscreenElement) {
            this._box.classList.add('fullscreen-mode');
            this._root?.classList.add('neo-lightbox-fullscreen');
            this._box.requestFullscreen?.();
        } else {
            this._box.classList.remove('fullscreen-mode');
            this._root?.classList.remove('neo-lightbox-fullscreen');
            document.exitFullscreen?.();
        }
    }

    close() {
        this._removeZoom();
        if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
        if (this._onFsChange) { document.removeEventListener('fullscreenchange', this._onFsChange); this._onFsChange = null; }
        if (this._root) { this._root.remove(); this._root = null; }
        this.items = [];
        this.index = 0;
        this.actionsProvider = null;
    }
}