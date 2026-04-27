const API_ENDPOINT = 'https://imagetight-api.vercel.app/api/compress';

// Add Context Menu on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "imagetight-compress",
        title: "Compress with ImageTight Pro",
        contexts: ["image"]
    });
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "imagetight-compress") {
        handleImageCompression(info.srcUrl, tab.id);
    }
});

// Handle messages from the Browser Action (Popup) or Content
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download_compress') {
        processImage(request.url, request.apiKey)
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((e) => {
                console.error("Compression Failed:", e);
                sendResponse({ success: false });
            });
        return true; // async response
    }
    
    if (request.action === 'update_badge' && sender.tab) {
        if (request.count > 0) {
            chrome.action.setBadgeText({ text: request.count.toString(), tabId: sender.tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
        } else {
            chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
        }
    }
});

// Main logic to fetch, compress, and download
async function handleImageCompression(imageUrl, tabId) {
    chrome.storage.local.get(['itc_api_key'], async (result) => {
        const apiKey = result.itc_api_key;
        if (!apiKey) {
            chrome.scripting.executeScript({
                target: {tabId: tabId},
                func: () => alert("ImageTight: Please set your Production API key in the extension settings first.")
            });
            return;
        }

        try {
            await processImage(imageUrl, apiKey);
        } catch(err) {
            chrome.scripting.executeScript({
                target: {tabId: tabId},
                func: (msg) => alert(`ImageTight Error: ${msg}`),
                args: [err.message]
            });
        }
    });
}

// Reusable workflow for both Context Menu and Popup
async function processImage(imageUrl, apiKey) {
    // 1. Fetch the image locally into memory as a Blob
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error("Could not fetch the original image. Check CORS.");
    
    const imageBlob = await response.blob();
    const oldSize = imageBlob.size;
    
    // 1b. Get the chosen output format from storage (default WebP)
    const storageResult = await chrome.storage.local.get(['itc_format']);
    const desiredFormat = storageResult.itc_format || 'webp';
    
    // 2. Prepare FormData to mimic the WP Plugin behavior
    const formData = new FormData();
    formData.append('api_key', apiKey);
    formData.append('domain', 'chrome-extension'); 
    formData.append('quality', '75'); 
    formData.append('output_format', desiredFormat); // Pass to Edge Engine
    
    // Extract a filename from URL, fallback to image.jpg
    let filename = imageUrl.split('/').pop().split('#')[0].split('?')[0];
    if(!filename || !filename.includes('.')) filename = 'image.jpg';
    
    formData.append('image', imageBlob, filename);

    // 3. Send to Vercel API
    const compressRes = await fetch(API_ENDPOINT, {
        method: 'POST',
        body: formData
    });

    if (!compressRes.ok) {
        const errorText = await compressRes.text();
        throw new Error(errorText || "API compression failed.");
    }

    // 4. Get optimized Blob
    const optimizedBlob = await compressRes.blob();
    const newSize = optimizedBlob.size;
    
    // Determine exact extension based on API response headers
    let finalExt = desiredFormat;
    if (finalExt === 'jpeg') finalExt = 'jpg';
    const serverFormat = compressRes.headers.get('X-Output-Format');
    if (serverFormat && serverFormat === 'jpeg') finalExt = 'jpg';
    else if (serverFormat) finalExt = serverFormat;

    // 5. Download it to the user's computer
    const reader = new FileReader();
    reader.onload = function() {
        const dataUrl = reader.result;
        // Strip original extension and swap it
        const baseName = filename.split('.').slice(0, -1).join('.') || 'image';
        
        chrome.downloads.download({
            url: dataUrl,
            filename: `optimized_${baseName}.${finalExt}`,
            saveAs: false // Changed to false for bulk downloads without dialog hell
        });
    };
    reader.readAsDataURL(optimizedBlob);
    
    return { oldSize, newSize };
}
