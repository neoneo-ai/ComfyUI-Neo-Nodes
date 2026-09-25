/**
 * Gallery Utilities - Constants and helper functions
 */
import { $el } from "../../../../scripts/ui.js";

// Constants
export const PAGE_SIZE = 100;
export const RESERVED_SPACE_WITH_LABEL = 52;
export const RESERVED_SPACE_WITHOUT_LABEL = 36;
export const MAX_COVER_IMAGES = 2;
export const MAX_ROOT_IMAGES = 20;
export const THUMBNAIL_SIZE_MIN = 150;
export const THUMBNAIL_SIZE_MAX = 500;
export const THUMBNAIL_SIZE_STEP = 25;
export const THUMBNAIL_SIZE_DEFAULT = 320;
export const THUMBNAIL_CACHE_SIZE = 320; // Fixed thumbnail cache size

/**
 * Get reserved space based on label display setting
 */
export function getReservedSpace(displayLabels) {
    return displayLabels ? RESERVED_SPACE_WITH_LABEL : RESERVED_SPACE_WITHOUT_LABEL;
}

/**
 * Calculate image height for thumbnail
 */
export function getImageHeight(maxThumbnailSize, displayLabels) {
    const reservedSpace = getReservedSpace(displayLabels);
    return Math.max(maxThumbnailSize - reservedSpace, 40);
}

/**
 * Calculate card height for directory cards
 */
export function getCardHeight(gallery) {
    const reservedSpace = getReservedSpace(gallery.displayLabels);
    return Math.max(gallery.maxThumbnailSize - reservedSpace, 40);
}

/**
 * Check if filename is an image
 */
export function isImageFile(filename) {
    return /\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i.test(filename);
}

/**
 * Check if filename is a video
 */
export function isVideoFile(filename) {
    return /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(filename);
}

/**
 * Check if filename is an audio file
 */
export function isAudioFile(filename) {
    return /\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)$/i.test(filename);
}

/**
 * Get video source URL
 */
export function getVideoSrc(video, subfolder) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
}

/**
 * Get audio source URL (waveform decode + playback + lightbox)
 */
export function getAudioSrc(audio, subfolder) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/audio?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
}

/**
 * Get image source URL
 */
export function getImageSrc(image, subfolder) {
    const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
    return image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
}

/**
 * Get thumbnail source URL (cached, optimized for display)
 */
export function getThumbnailSrc(image, subfolder, size = THUMBNAIL_CACHE_SIZE) {
    const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
    return `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}&size=${size}${categoryParam}`;
}

/**
 * Debounce function
 */
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

/**
 * Create pagination UI with load more button
 */
export function createPaginationUI(container, items, renderPage, gallery) {
    const displayedCount = Math.min(PAGE_SIZE, items.length);
    
    renderPage(displayedCount);
    
    if (displayedCount < items.length) {
        const createLoadMoreBtn = () => {
            const btn = $el("div", {
                className: "neo-gallery-load-more-btn",
                textContent: `Load more (${items.length - displayedCount} remaining)`
            });
            btn.onclick = () => {
                btn.remove();
                renderPage(PAGE_SIZE);
                const remaining = items.length - gallery._renderedCount;
                if (remaining > 0) {
                    container.appendChild(createLoadMoreBtn());
                }
            };
            return btn;
        };
        container.appendChild(createLoadMoreBtn());
    }
}

/**
 * Deterministic decorative waveform heights seeded from a string (FNV-1a + LCG).
 * The same seed always yields the same bars, so a tile looks stable across renders.
 */
export function decorativeHeights(seedStr) {
    const s = String(seedStr || "");
    const n = 60;
    let seed = 2166136261;
    for (let i = 0; i < s.length; i++) {
        seed ^= s.charCodeAt(i);
        seed = Math.imul(seed, 16777619) >>> 0;
    }
    const phase = (seed % 628) / 100;
    const heights = new Array(n);
    for (let i = 0; i < n; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const rnd = seed / 4294967296;
        const t = i / n;
        const base = 0.25 + 0.5 * Math.abs(Math.sin(t * Math.PI * 3 + phase));
        heights[i] = Math.min(1, base * (0.55 + rnd * 0.8));
    }
    return heights;
}

/**
 * Draw a bar waveform onto a canvas. `progress` (0..1) fills the played portion.
 */
export function renderWaveform(canvas, heights, progress = 0) {
    const dpr = window.devicePixelRatio || 1;
    // 布局前 clientWidth/Height 为 0，回退到默认尺寸；布局后按实际显示尺寸绘制更清晰
    const W = canvas.clientWidth || 240;
    const H = canvas.clientHeight || 72;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const n = heights.length;
    const gap = W / n;
    for (let i = 0; i < n; i++) {
        const bh = Math.max(2, Math.min(1, heights[i]) * H * 0.9);
        const played = progress > 0 && (i + 0.5) / n <= progress;
        ctx.fillStyle = played ? "#8b5cf6" : "rgba(148, 163, 184, 0.45)";
        ctx.fillRect(i * gap, (H - bh) / 2, Math.max(1, gap - 1), bh);
    }
}

/**
 * Cover entries carry a `kind` ("image" | "video" | "audio"). Audio renders as a
 * dedicated tile; anything else (or a legacy entry without kind) is an <img>.
 */
export function getCoverTileKind(cover) {
    return cover && cover.kind === "audio" ? "audio" : "media";
}

function _coverImgSrc(cover) {
    if (cover && cover.url) return cover.url;
    return getThumbnailSrc(cover, (cover && cover.subfolder) || "");
}

/** Generic placeholder tile for an empty or failed non-audio cover. */
export function buildPlaceholderTile() {
    const tile = $el("div", { className: "neo-gallery-card-placeholder" });
    tile.appendChild($el("span", { className: "neo-gallery-card-placeholder-icon", textContent: "\uD83D\uDCC1" }));
    return tile;
}

/** Audio cover tile reusing the audio-card visual language (badge + waveform). */
export function buildAudioTile(seed) {
    const tile = $el("div", { className: "neo-gallery-cover-audio-tile" });
    tile.appendChild($el("span", { className: "neo-gallery-cover-audio-badge", textContent: "\u266A" }));
    const canvas = $el("canvas", { className: "neo-gallery-cover-audio-waveform" });
    tile.appendChild(canvas);
    renderWaveform(canvas, decorativeHeights(seed), 0);
    return tile;
}

/**
 * Render a directory / bookmark cover into `coverWrapper`.
 * Up to MAX_COVER_IMAGES image/video rows at natural ratio; portrait images are
 * laid out side by side (decided from the first image that loads), an audio-only
 * set becomes one audio tile, and nothing usable becomes one placeholder.
 */
export function renderCoverTiles(coverWrapper, covers, alt = "") {
    coverWrapper.innerHTML = "";
    const list = (covers || []).slice(0, MAX_COVER_IMAGES);
    const mediaCovers = list.filter(c => getCoverTileKind(c) === "media");

    if (mediaCovers.length > 0) {
        const grid = $el("div", { className: "neo-gallery-card-cover-grid" });
        let oriented = false;
        for (const c of mediaCovers) {
            const itemEl = $el("div", { className: "neo-gallery-card-cover-grid-item" });
            const img = $el("img", { src: _coverImgSrc(c), alt, loading: "lazy" });
            img.onerror = () => itemEl.replaceWith(buildPlaceholderTile());
            img.onload = () => {
                if (oriented) return;
                oriented = true;
                // 竖图上下堆叠会让卡片过高，改为左右并排；横图保持竖排
                if (img.naturalHeight > img.naturalWidth) grid.classList.add("neo-gallery-card-cover-grid-row");
            };
            itemEl.appendChild(img);
            grid.appendChild(itemEl);
        }
        coverWrapper.appendChild(grid);
    } else if (list.some(c => getCoverTileKind(c) === "audio")) {
        const firstAudio = list.find(c => getCoverTileKind(c) === "audio");
        coverWrapper.appendChild(buildAudioTile(firstAudio && (firstAudio.filename || firstAudio.name)));
    } else {
        coverWrapper.appendChild(buildPlaceholderTile());
    }
}

/**
 * Create breadcrumb item
 */
export function createBreadcrumbItem(text, onClick, options = {}) {
    const { isCurrent = false, isHome = false, isUp = false, title = '' } = options;
    
    let className = 'neo-gallery-breadcrumb-item';
    if (isHome) className += ' neo-gallery-breadcrumb-home';
    if (isCurrent) className += ' neo-gallery-breadcrumb-current';
    if (isUp) className += ' neo-gallery-breadcrumb-up';
    
    const item = $el("span", {
        className: className,
        textContent: text,
        title: title
    });
    
    if (onClick) {
        item.onclick = (e) => {
            e.stopPropagation();
            onClick();
        };
    }
    
    return item;
}

/**
 * Create separator element
 */
export function createBreadcrumbSeparator() {
    return $el("span", { className: "neo-gallery-breadcrumb-sep", textContent: ">" });
}

/**
 * Create spacer element
 */
export function createSpacer() {
    return $el("div", { style: { flex: 1 } });
}

/**
 * Sort items by mtime descending, fallback to name
 */
export function sortByMtime(items) {
    return [...items].sort((a, b) => {
        const at = a.mtime ?? a._mtime ?? 0;
        const bt = b.mtime ?? b._mtime ?? 0;
        if (bt !== at) return bt - at;
        return b.name.localeCompare(a.name);
    });
}

/**
 * Show no files message
 */
export function showNoFilesMessage(container, message = "No images found") {
    container.appendChild($el("div", { className: "neo-gallery-no-files" }, [
        $el("div", { className: "neo-gallery-no-files-icon", textContent: "\uD83D\uDE14" }),
        $el("div", { className: "neo-gallery-no-files-text", textContent: message })
    ]));
}

/**
 * Show loading overlay
 */
export function showLoadingOverlay(container, size = 320) {
    const skeletonCards = [];
    // Create 6 skeleton cards to simulate a grid
    for (let i = 0; i < 6; i++) {
        skeletonCards.push($el("div", { className: "skeleton-card" }));
    }
    
    const loadingEl = $el("div", { className: "neo-gallery-loading-overlay" }, [
        $el("div", { className: "neo-gallery-loading-skeleton", dataset: { size: size.toString() } }, skeletonCards),
        $el("span", { className: "neo-gallery-loading-text", textContent: "Loading gallery..." })
    ]);
    container.appendChild(loadingEl);
    return loadingEl;
}

/**
 * Toast notification
 */
export function showToast(app, severity, summary, detail) {
    app.extensionManager.toast.add({ severity, summary, detail, life: 5000 });
}

/**
 * Inline feedback on button
 */
export function showInlineFeedback(button, message, type) {
    const existing = button.querySelector('.neo-gallery-feedback');
    if (existing) existing.remove();

    const feedbackClassName = type === 'success' ? 'neo-gallery-feedback neo-gallery-feedback-success' : 'neo-gallery-feedback neo-gallery-feedback-error';
    const feedback = $el("div", {
        className: feedbackClassName,
        textContent: message
    });

    document.body.appendChild(feedback);

    const buttonRect = button.getBoundingClientRect();
    const top = buttonRect.top;
    const left = buttonRect.left + buttonRect.width / 2;

    feedback.style.position = 'fixed';
    feedback.style.top = (top - 32) + 'px';
    feedback.style.left = left + 'px';
    feedback.style.transform = 'translateX(-50%)';
    feedback.style.zIndex = '2147483646';
    feedback.style.pointerEvents = 'none';

    setTimeout(() => {
        if (feedback.parentNode) {
            feedback.style.opacity = "0";
            feedback.style.transition = "opacity 0.3s ease";
            setTimeout(() => {
                if (feedback.parentNode) feedback.remove();
            }, 300);
        }
    }, 1500);
}