document.addEventListener('DOMContentLoaded', async () => {
    // Tab switching
    document.getElementById('tab-scanner').addEventListener('click', () => switchTab('scanner'));
    document.getElementById('tab-settings').addEventListener('click', () => switchTab('settings'));

    // Load API Key & Format
    chrome.storage.local.get(['itc_api_key', 'itc_format'], (result) => {
        if (result.itc_api_key) {
            document.getElementById('api-key-input').value = result.itc_api_key;
        } else {
            // Force them to settings if no key
            switchTab('settings');
        }
        if (result.itc_format) {
            document.getElementById('format-select').value = result.itc_format;
        }
    });

    // Save API Key & Format
    document.getElementById('save-key-btn').addEventListener('click', () => {
        const key = document.getElementById('api-key-input').value.trim();
        const format = document.getElementById('format-select').value;
        chrome.storage.local.set({ itc_api_key: key, itc_format: format }, () => {
            const btn = document.getElementById('save-key-btn');
            const originalText = btn.innerText;
            btn.innerText = 'Settings Saved!';
            setTimeout(() => { btn.innerText = originalText; }, 2000);
        });
    });

    // Scan Page
    document.getElementById('scan-btn').addEventListener('click', async () => {
        const resultsDiv = document.getElementById('results');
        resultsDiv.innerHTML = '<div class="loader">Analyzing DOM Assets...</div>';
        
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error("No active tab");

            // Avoid scanning chrome:// urls
            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
                resultsDiv.innerHTML = '<div class="empty-state"><p>Cannot scan internal browser pages.</p></div>';
                return;
            }

            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            }, () => {
                // Ignore the extension's own possible DOM error for missing execute
                if (chrome.runtime.lastError) {
                    resultsDiv.innerHTML = `<div class="empty-state"><p>Access Denied. Reload page.</p></div>`;
                    return;
                }

                chrome.tabs.sendMessage(tab.id, { action: 'scan_images' }, (response) => {
                    if (chrome.runtime.lastError || !response) {
                        resultsDiv.innerHTML = '<div class="empty-state"><p>Scan failed. Try refreshing the page.</p></div>';
                        return;
                    }
                    renderImages(response.images);
                });
            });
        } catch(err) {
            resultsDiv.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
        }
    });
});

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    document.getElementById(`content-${tabId}`).classList.remove('hidden');
}

function renderImages(images) {
    const container = document.getElementById('results');
    container.innerHTML = '';

    if (images && images.length > 0) {
        // Add free audit notice banner above results
        const banner = document.createElement('div');
        banner.className = 'audit-banner';
        banner.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span><strong>Scan is FREE.</strong> Click the download icon to compress (costs 1 credit each).</span>
        `;
        container.appendChild(banner);
    }

    if (!images || images.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                <p>No valid images found on this page.</p>
            </div>
        `;
        return;
    }

    images.forEach(img => {
        // Build card
        const card = document.createElement('div');
        card.className = 'img-item';

        const sizeKb = Math.round(img.size / 1024);
        const formatSize = sizeKb > 1024 ? (sizeKb / 1024).toFixed(2) + ' MB' : sizeKb + ' KB';
        const isHeavy = sizeKb > 250; 

        card.innerHTML = `
            <img src="${img.src}" class="img-thumb" alt="Preview" onerror="this.src='icon.png'">
            <div class="img-info">
                <div class="img-size ${isHeavy ? 'heavy' : ''}">${img.size > 0 ? formatSize : 'Unknown Size'}</div>
                <div class="img-dim">${img.width}x${img.height} px</div>
                <div class="img-url" title="${img.src}">${img.src}</div>
            </div>
            <button class="compress-btn" title="Compress via Remote API" data-url="${img.src}">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
        `;

        card.querySelector('.compress-btn').addEventListener('click', (e) => {
            const btn = e.currentTarget;
            // ─── Show Credit Confirmation Modal BEFORE calling API ───
            showCreditConfirmModal(img.src, () => {
                // User confirmed — now spend the credit
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
                triggerCompression(img.src).then((success) => {
                    if(success) {
                        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                        btn.title = 'Compressed! Saved to Downloads.';
                    } else {
                        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
                        btn.title = 'Failed. Check your API key.';
                    }
                });
            });
        });

        container.appendChild(card);
    });

    // Add spin animation dynamically
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
    `;
    document.head.appendChild(style);
}

/**
 * Shows a native-style confirmation modal before spending a credit.
 * onConfirm() is ONLY called if the user clicks YES.
 */
function showCreditConfirmModal(imageUrl, onConfirm) {
    // Remove any existing modal
    const old = document.getElementById('itc-confirm-modal');
    if (old) old.remove();

    const filename = imageUrl.split('/').pop().split('?')[0].substring(0, 30);

    const modal = document.createElement('div');
    modal.id = 'itc-confirm-modal';
    modal.innerHTML = `
        <div class="modal-overlay">
            <div class="modal-box">
                <div class="modal-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                </div>
                <h3 class="modal-title">Use 1 Credit?</h3>
                <p class="modal-desc">This will compress <strong>${filename}</strong> via Edge API and save it as WebP to your Downloads.</p>
                <div class="modal-credit-tag">💳 1 Credit will be deducted from your account</div>
                <div class="modal-actions">
                    <button id="modal-cancel" class="modal-btn-cancel">Cancel — Free Scan Only</button>
                    <button id="modal-confirm" class="modal-btn-confirm">Yes, Use 1 Credit</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('modal-cancel').addEventListener('click', () => modal.remove());
    document.getElementById('modal-confirm').addEventListener('click', () => {
        modal.remove();
        onConfirm();
    });
}

async function triggerCompression(imageUrl) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['itc_api_key'], async (result) => {
            const apiKey = result.itc_api_key;
            if (!apiKey) {
                alert("Please authenticate your API key in Settings first.");
                return resolve(false);
            }

            try {
                // Tell background to handle the download logic to bypass CORS restrictions in popup
                chrome.runtime.sendMessage({
                    action: "download_compress", 
                    url: imageUrl, 
                    apiKey: apiKey 
                }, (response) => {
                    resolve(response && response.success);
                });
            } catch(e) {
                console.error(e);
                resolve(false);
            }
        });
    });
}
