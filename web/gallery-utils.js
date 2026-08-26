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
 * Get cover image height for card grid
 */
export function getCoverHeight(coverWrapper, gallery) {
    const cardWidth = coverWrapper.clientWidth || 160;
    const maxCoverHeight = gallery.maxThumbnailSize - getReservedSpace(gallery.displayLabels);
    return Math.min(Math.max(cardWidth * 0.5, 40), maxCoverHeight / 2);
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
 * Get video source URL
 */
export function getVideoSrc(video, subfolder) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
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
 * Build cover image grid for cards
 */
export async function buildCoverGrid(coverImages, subfolder, gallery, placeholder = '\uD83D\uDCC1', placeholderClass = 'neo-gallery-card-cover neo-gallery-card-placeholder') {
    const coverWrapper = $el("div", { className: "neo-gallery-card-cover-wrapper" });
    
    if (coverImages.length > 0) {
        const coverGrid = $el("div", { className: "neo-gallery-card-cover-grid" });
        
        let loadedCount = 0;
        coverImages.forEach((imgData) => {
            // Use thumbnail API for cover images to reduce bandwidth (original image can be several MB)
            const src = getThumbnailSrc(imgData, subfolder);
            
            const imgItem = $el("div", { className: "neo-gallery-card-cover-grid-item" });
            
            const img = $el("img", {
                src: src,
                alt: subfolder,
                loading: "lazy"
            });
            
            img.onload = () => {
                loadedCount++;
                if (loadedCount === coverImages.length) {
                    const height = getCoverHeight(coverWrapper, gallery);
                    coverGrid.style.height = `${height * 2}px`;
                }
            };
            
            img.onerror = () => {
                imgItem.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:24px;">${placeholder}</div>`;
            };
            
            imgItem.appendChild(img);
            coverGrid.appendChild(imgItem);
        });
        
        coverWrapper.appendChild(coverGrid);
    } else {
        coverWrapper.appendChild($el("div", { className: placeholderClass, textContent: placeholder }));
    }
    
    return coverWrapper;
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