chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scan_images') {
        const imgs = Array.from(document.querySelectorAll('img'))
            .filter(img => img.src && img.src.startsWith('http'))
            // Filter out tiny UI icons
            .filter(img => img.clientWidth > 50 && img.clientHeight > 50);
        
        // Remove old highlights
        document.querySelectorAll('.itc-highlight').forEach(el => el.classList.remove('itc-highlight'));

        const imagePromises = imgs.map(async (img) => {
            let size = 0;
            try {
                // Try to get content-length without downloading the whole image
                const res = await fetch(img.src, { method: 'HEAD', cache: 'force-cache' });
                size = parseInt(res.headers.get('content-length') || '0', 10);
            } catch(e) {
                // CORS or other fetch blocks, default size to 0
                size = 0;
            }
            
            // Highlight heavy images to show the user visually
            if(size > 250000) { // > 250 KB
                img.classList.add('itc-highlight');
                img.style.outline = '4px solid #ef4444';
                img.style.outlineOffset = '-4px';
                img.style.transition = 'all 0.3s';
                
                // Dim on hover
                img.onmouseenter = () => img.style.opacity = '0.5';
                img.onmouseleave = () => img.style.opacity = '1';
            }
            
            return {
                src: img.src,
                size: size,
                width: img.naturalWidth || img.clientWidth,
                height: img.naturalHeight || img.clientHeight
            };
        });

        Promise.all(imagePromises).then(results => {
            // Sort by largest to smallest, ignoring 0 sizes (push to bottom)
            results.sort((a,b) => {
                if(a.size === 0 && b.size > 0) return 1;
                if(b.size === 0 && a.size > 0) return -1;
                return b.size - a.size;
            });
            sendResponse({ images: results });
        });

        return true; // Keep channel open for async response
    }
});
