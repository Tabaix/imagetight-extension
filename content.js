(function () {
    const HIGHLIGHT_CLASS = 'itc-highlight';
    const HIGHLIGHT_ALT_CLASS = 'itc-highlight-alt';

    function clearHighlights() {
        document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
        document.querySelectorAll(`.${HIGHLIGHT_ALT_CLASS}`).forEach((el) => el.classList.remove(HIGHLIGHT_ALT_CLASS));
    }

    async function collectImages() {
        const imgs = Array.from(document.querySelectorAll('img'))
            .filter((img) => img.src && /^https?:\/\//i.test(img.src))
            .filter((img) => img.clientWidth > 50 && img.clientHeight > 50);

        clearHighlights();

        const imagePromises = imgs.map(async (img) => {
            let size = 0;
            try {
                const res = await fetch(img.src, { method: 'HEAD', cache: 'force-cache' });
                size = parseInt(res.headers.get('content-length') || '0', 10);
            } catch (e) {
                size = 0;
            }

            const hasAlt = Boolean(img.getAttribute('alt') && img.getAttribute('alt').trim());
            const altText = img.getAttribute('alt') || '';

            if (size > 250000) {
                img.classList.add(HIGHLIGHT_CLASS);
                img.style.outline = '4px solid #ef4444';
                img.style.outlineOffset = '-4px';
                img.style.transition = 'all 0.3s';
            } else if (!hasAlt) {
                img.classList.add(HIGHLIGHT_ALT_CLASS);
                img.style.outline = '4px solid #f59e0b';
                img.style.outlineOffset = '-4px';
                img.style.transition = 'all 0.3s';
            }

            if (size > 250000 || !hasAlt) {
                img.onmouseenter = () => { img.style.opacity = '0.5'; };
                img.onmouseleave = () => { img.style.opacity = '1'; };
            }

            return {
                src: img.src,
                size,
                width: img.naturalWidth || img.clientWidth,
                height: img.naturalHeight || img.clientHeight,
                hasAlt,
                alt: altText
            };
        });

        const results = await Promise.all(imagePromises);
        results.sort((a, b) => {
            if (a.size === 0 && b.size > 0) return 1;
            if (b.size === 0 && a.size > 0) return -1;
            return b.size - a.size;
        });
        return results;
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request?.action === 'scan_images') {
            collectImages()
                .then((images) => sendResponse({ images }))
                .catch((error) => sendResponse({ images: [], error: error.message }));
            return true;
        }
        return false;
    });

    setTimeout(() => {
        const imgs = Array.from(document.querySelectorAll('img')).filter((img) => img.src && /^https?:\/\//i.test(img.src));
        const heavyCount = imgs.filter((img) => img.clientWidth * img.clientHeight > 400000).length;
        chrome.runtime.sendMessage({ action: 'update_badge', count: heavyCount });
    }, 3000);
})();
