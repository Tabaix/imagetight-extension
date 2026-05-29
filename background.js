const CLOUD_API_ENDPOINT = 'https://imagetight-api.vercel.app/api/compress';

// ── Install: create context menu ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'imagetight-compress',
        title: 'Compress with ImageTight Pro',
        contexts: ['image']
    });
    chrome.contextMenus.create({
        id: 'imagetight-alttext',
        title: '✨ Generate AI Alt Text',
        contexts: ['image']
    });
});

// ── Context Menu clicks ───────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'imagetight-compress') {
        handleContextCompress(info.srcUrl, tab.id);
    }
    if (info.menuItemId === 'imagetight-alttext') {
        handleContextAlt(info.srcUrl, tab.id);
    }
});

// ── Message Router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.action === 'download_compress') {
        processImage(request.url, request.apiKey, request.engine, request.format)
            .then(result => sendResponse({ success: true, ...result }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (request.action === 'generate_alt') {
        generateAltText(request.url, request.apiKey, request.geminiKey)
            .then(alt => sendResponse({ success: true, alt }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (request.action === 'bulk_download') {
        bulkDownloadOriginals(request.urls)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (request.action === 'update_badge' && sender.tab) {
        if (request.count > 0) {
            chrome.action.setBadgeText({ text: String(request.count), tabId: sender.tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
        } else {
            chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
        }
    }
});

// ── Context menu handler: compress ───────────────────────────────────────────
async function handleContextCompress(imageUrl, tabId) {
    const { itc_api_key: apiKey, itc_engine: engine = 'local' } =
        await chrome.storage.local.get(['itc_api_key', 'itc_engine']);

    if (engine === 'cloud' && !apiKey) {
        chrome.scripting.executeScript({
            target: { tabId },
            func: () => alert('ImageTight: Set your API key in extension settings first.')
        });
        return;
    }
    try {
        await processImage(imageUrl, apiKey, engine);
    } catch (err) {
        chrome.scripting.executeScript({
            target: { tabId },
            func: msg => alert(`ImageTight Error: ${msg}`),
            args: [err.message]
        });
    }
}

// ── Context menu handler: alt text ───────────────────────────────────────────
async function handleContextAlt(imageUrl, tabId) {
    const { itc_api_key: apiKey, itc_gemini_key: geminiKey } =
        await chrome.storage.local.get(['itc_api_key', 'itc_gemini_key']);

    if (!apiKey && !geminiKey) {
        chrome.scripting.executeScript({
            target: { tabId },
            func: () => alert('ImageTight: Set a Gemini Key (free) or ImageTight API Key in settings.')
        });
        return;
    }
    try {
        const alt = await generateAltText(imageUrl, apiKey, geminiKey);
        chrome.scripting.executeScript({
            target: { tabId },
            func: (text) => {
                prompt('✨ AI Alt Text (copy and paste):', text);
            },
            args: [alt]
        });
    } catch (err) {
        chrome.scripting.executeScript({
            target: { tabId },
            func: msg => alert(`Alt Text Error: ${msg}`),
            args: [err.message]
        });
    }
}

// ── Main compression router ───────────────────────────────────────────────────
// format is passed directly from popup (real-time dropdown value) so we never
// rely on stale storage — the fallback to storage is only for context-menu calls.
async function processImage(imageUrl, apiKey, engine = 'local', format) {
    let desiredFormat = format;
    if (!desiredFormat) {
        // Context-menu path: no format in message, read from storage
        const stored = await chrome.storage.local.get(['itc_format']);
        desiredFormat = stored.itc_format || 'webp';
    }

    let filename = imageUrl.split('/').pop().split('#')[0].split('?')[0];
    if (!filename || !filename.includes('.')) filename = 'image.jpg';
    const baseName = filename.split('.').slice(0, -1).join('.') || 'image';
    const finalExt = desiredFormat === 'jpeg' ? 'jpg' : desiredFormat;

    if (engine === 'local') {
        // ── FREE: local OffscreenCanvas compression ──
        const { blob, oldSize, newSize } = await compressLocally(imageUrl, desiredFormat);
        const dataUrl = await blobToDataUrl(blob);
        chrome.downloads.download({
            url: dataUrl,
            filename: `optimized_${baseName}.${finalExt}`,
            saveAs: false
        });
        return { oldSize, newSize };

    } else {
        // ── PAID: ImageTight Cloud API ──
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error('Could not fetch image. Check CORS.');
        const imageBlob = await response.blob();
        const oldSize = imageBlob.size;

        const formData = new FormData();
        formData.append('api_key', apiKey);
        formData.append('domain', 'chrome-extension');
        formData.append('quality', '75');
        formData.append('output_format', desiredFormat);
        formData.append('image', imageBlob, filename);

        const compressRes = await fetch(CLOUD_API_ENDPOINT, { method: 'POST', body: formData });
        if (!compressRes.ok) {
            const errorText = await compressRes.text();
            throw new Error(errorText || 'Cloud API compression failed.');
        }

        const optimizedBlob = await compressRes.blob();
        const newSize = optimizedBlob.size;

        // Honour server-reported format
        let ext = finalExt;
        const serverFormat = compressRes.headers.get('X-Output-Format');
        if (serverFormat) ext = serverFormat === 'jpeg' ? 'jpg' : serverFormat;

        const dataUrl = await blobToDataUrl(optimizedBlob);
        chrome.downloads.download({
            url: dataUrl,
            filename: `optimized_${baseName}.${ext}`,
            saveAs: false
        });
        return { oldSize, newSize };
    }
}

// ── Local browser compression via OffscreenCanvas ────────────────────────────
async function compressLocally(imageUrl, desiredFormat) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Could not fetch image for local compression.');

    const blob = await response.blob();
    const oldSize = blob.size;

    const imageBitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0);
    imageBitmap.close();

    const mimeMap = { webp: 'image/webp', avif: 'image/avif', jpeg: 'image/jpeg', png: 'image/png' };
    const mimeType = mimeMap[desiredFormat] || 'image/webp';
    const quality = desiredFormat === 'png' ? undefined : 0.75;

    const optimizedBlob = await canvas.convertToBlob({ type: mimeType, quality });
    const newSize = optimizedBlob.size;

    return { blob: optimizedBlob, oldSize, newSize };
}

// ── Bulk download originals (no compression) ──────────────────────────────────
async function bulkDownloadOriginals(urls) {
    for (const url of urls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const blob = await response.blob();
            const dataUrl = await blobToDataUrl(blob);
            let filename = url.split('/').pop().split('#')[0].split('?')[0];
            if (!filename || !filename.includes('.')) filename = 'image.jpg';
            chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
            // Small stagger to avoid download manager overload
            await sleep(300);
        } catch (_) { /* skip failed images */ }
    }
}

// ── AI Alt Text: free Gemini or paid cloud ────────────────────────────────────
async function generateAltText(imageUrl, apiKey, geminiKey) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Could not fetch image for alt text generation.');

    const blob = await response.blob();
    const mimeType = blob.type || 'image/jpeg';
    const base64Data = await blobToBase64(blob);

    if (geminiKey) {
        // ── FREE mode: direct Google Gemini Vision call ──
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                text: 'Write a short, descriptive, SEO-friendly alt text for this image. Maximum 12 words. Output ONLY the alt text — no quotes, no markdown, no labels.'
                            },
                            {
                                inline_data: { mime_type: mimeType, data: base64Data }
                            }
                        ]
                    }]
                })
            }
        );

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            let errMsg = 'Gemini API error.';
            try { errMsg = JSON.parse(errText)?.error?.message || errMsg; } catch (_) {}
            throw new Error(errMsg);
        }

        const geminiData = await geminiRes.json();
        const alt = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!alt) throw new Error('Gemini returned no text. Check API key quota.');
        return alt.trim();

    } else {
        // ── PAID mode: ImageTight AI Proxy (deducts 1 credit) ──
        const aiRes = await fetch('https://imagetight-api.vercel.app/api/ai-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                prompt: 'Write a short, descriptive, SEO-friendly alt text (max 12 words). Output ONLY the alt text, no quotes.',
                image_base64: base64Data,
                image_mime: mimeType
            })
        });

        if (!aiRes.ok) {
            const errText = await aiRes.text();
            throw new Error(errText || 'AI-Proxy request failed.');
        }

        const data = await aiRes.json();
        if (!data.success || !data.data) throw new Error('AI did not return a valid description.');
        return data.data.trim();
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
