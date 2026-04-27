document.addEventListener('DOMContentLoaded', async () => {
    let currentImages = [];
    let currentFormat = 'webp';

    // Tab switching
    document.getElementById('tab-scanner').addEventListener('click', () => switchTab('scanner'));
    document.getElementById('tab-settings').addEventListener('click', () => switchTab('settings'));

    // Check Credits & Load Format
    chrome.storage.local.get(['itc_api_key', 'itc_format'], (result) => {
        if (result.itc_api_key) {
            document.getElementById('api-key-input').value = result.itc_api_key;
            // Fake credit fetch for now (you'll implement real API later)
            const badge = document.getElementById('credit-badge');
            badge.style.display = 'inline-block';
            badge.innerText = '💳 Active'; // We'd show real credits if the Edge API sent it
        } else {
            switchTab('settings');
        }
        if (result.itc_format) {
            currentFormat = result.itc_format;
            document.getElementById('format-select').value = result.itc_format;
        }
    });

    // Save Settings
    document.getElementById('save-key-btn').addEventListener('click', () => {
        const key = document.getElementById('api-key-input').value.trim();
        const format = document.getElementById('format-select').value;
        currentFormat = format;
        chrome.storage.local.set({ itc_api_key: key, itc_format: format }, () => {
            const btn = document.getElementById('save-key-btn');
            const originalText = btn.innerText;
            btn.innerText = 'Settings Saved!';
            document.getElementById('itc-key-error')?.remove();
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

            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
                resultsDiv.innerHTML = '<div class="empty-state"><p>Cannot scan internal browser pages.</p></div>';
                return;
            }

            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            }, () => {
                if (chrome.runtime.lastError) {
                    resultsDiv.innerHTML = `<div class="empty-state"><p>Access Denied. Reload page.</p></div>`;
                    return;
                }

                chrome.tabs.sendMessage(tab.id, { action: 'scan_images' }, (response) => {
                    if (chrome.runtime.lastError || !response) {
                        resultsDiv.innerHTML = '<div class="empty-state"><p>Scan failed. Try refreshing the page.</p></div>';
                        return;
                    }
                    currentImages = response.images;
                    updateScorePanel(currentImages);
                    renderImages(currentImages, currentFormat);
                });
            });
        } catch(err) {
            resultsDiv.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
        }
    });

    // Filtering
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            renderImages(currentImages, currentFormat, e.currentTarget.dataset.filter);
        });
    });

    // Bulk Compress
    document.getElementById('bulk-compress-btn').addEventListener('click', async () => {
        const heavyImages = currentImages.filter(img => (img.size / 1024) > 250);
        if (heavyImages.length === 0) return;
        
        showCreditConfirmModal(heavyImages.length, currentFormat, true, async () => {
            const btn = document.getElementById('bulk-compress-btn');
            const progress = document.getElementById('bulk-progress');
            btn.disabled = true;
            btn.innerHTML = 'Compressing...';
            progress.classList.remove('hidden');
            
            let successCount = 0;
            for (let i = 0; i < heavyImages.length; i++) {
                progress.innerText = `Processing ${i+1} of ${heavyImages.length}...`;
                // Trigger the individual button to show spinner
                const imgBtn = document.querySelector(`.compress-btn[data-url="${heavyImages[i].src}"]`);
                if (imgBtn) imgBtn.innerHTML = '<svg class="spin" ...></svg>'; // Simplified
                
                const res = await triggerCompression(heavyImages[i].src);
                if (res && res.success) {
                    successCount++;
                    if(imgBtn) updateImgUIAfterSuccess(imgBtn, res.oldSize, res.newSize);
                } else {
                    if(imgBtn) imgBtn.innerHTML = 'Failed';
                }
            }
            
            progress.innerText = `Finished! Compressed ${successCount}/${heavyImages.length} images.`;
            btn.innerHTML = 'Bulk Compress Complete';
            setTimeout(() => progress.classList.add('hidden'), 5000);
        });
    });
});

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
    document.getElementById(`content-${tabId}`).classList.remove('hidden');
}

function updateScorePanel(images) {
    document.getElementById('scan-intro-card').classList.add('hidden');
    document.getElementById('score-card').classList.remove('hidden');
    document.getElementById('filter-bar').classList.remove('hidden');

    let totalWeight = 0;
    let heavyCount = 0;
    let noAltCount = 0;

    images.forEach(img => {
        totalWeight += img.size;
        if (img.size > 250000) heavyCount++;
        if (!img.hasAlt) noAltCount++;
    });

    const mb = (totalWeight / (1024 * 1024)).toFixed(2);
    document.getElementById('stat-total-weight').innerText = `${mb} MB`;
    
    const heavyEl = document.getElementById('stat-heavy-images');
    heavyEl.innerText = heavyCount;
    heavyEl.className = heavyCount > 0 ? 'danger-text' : 'success-text';

    const altEl = document.getElementById('stat-missing-alt');
    altEl.innerText = noAltCount;
    altEl.className = noAltCount > 0 ? 'warning-text' : 'success-text';

    const scoreEl = document.getElementById('page-score');
    scoreEl.className = 'score-circle';
    
    let score = 100;
    score -= heavyCount * 10;
    score -= noAltCount * 2;
    if (score < 0) score = 0;

    scoreEl.innerText = score;
    if (score < 50) scoreEl.classList.add('danger');
    else if (score < 80) scoreEl.classList.add('warning');

    const bulkBtn = document.getElementById('bulk-compress-btn');
    if (heavyCount === 0) {
        bulkBtn.style.display = 'none';
    } else {
        bulkBtn.style.display = 'flex';
        bulkBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Compress All ${heavyCount} Heavy`;
    }
}

function renderImages(images, currentFormat, filter = 'all') {
    const container = document.getElementById('results');
    container.innerHTML = '';

    let filtered = images;
    if (filter === 'heavy') filtered = images.filter(img => img.size > 250000);
    if (filter === 'no-alt') filtered = images.filter(img => !img.hasAlt);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No images match this filter.</p></div>`;
        return;
    }

    filtered.forEach(img => {
        const card = document.createElement('div');
        card.className = 'img-item';

        const sizeKb = Math.round(img.size / 1024);
        const formatSize = sizeKb > 1024 ? (sizeKb / 1024).toFixed(2) + ' MB' : sizeKb + ' KB';
        const isHeavy = sizeKb > 250; 

        card.innerHTML = `
            <img src="${img.src}" class="img-thumb" alt="Preview" onerror="this.src='icon.png'">
            <div class="img-info">
                <div class="img-size ${isHeavy ? 'heavy' : ''}">
                    <span class="size-val">${img.size > 0 ? formatSize : 'Unknown Size'}</span>
                </div>
                <div class="img-dim">${img.width}x${img.height} px ${!img.hasAlt ? '<span class="alt-warning">Missing Alt</span>' : ''}</div>
                <div class="img-url" title="${img.src}">${img.src}</div>
            </div>
            <button class="compress-btn" title="Compress via Remote API" data-url="${img.src}">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
        `;

        card.querySelector('.compress-btn').addEventListener('click', (e) => {
            const btn = e.currentTarget;
            showCreditConfirmModal(1, currentFormat, false, () => {
                btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
                btn.disabled = true;
                triggerCompression(img.src).then((res) => {
                    if(res && res.success) {
                        updateImgUIAfterSuccess(btn, res.oldSize, res.newSize);
                    } else {
                        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
                        btn.title = 'Failed. Check API key.';
                        btn.disabled = false;
                    }
                });
            });
        });

        container.appendChild(card);
    });

    const style = document.getElementById('spin-style');
    if (!style) {
        const newStyle = document.createElement('style');
        newStyle.id = 'spin-style';
        newStyle.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`;
        document.head.appendChild(newStyle);
    }
}

function updateImgUIAfterSuccess(btn, oldSize, newSize) {
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.title = 'Compressed! Saved to Downloads.';
    btn.style.background = 'rgba(34,197,94,0.1)';
    btn.style.borderColor = 'rgba(34,197,94,0.5)';
    
    // Update size text
    const infoDiv = btn.parentElement.querySelector('.img-size');
    if (infoDiv && oldSize && newSize) {
        const savedPercent = Math.round(((oldSize - newSize) / oldSize) * 100);
        infoDiv.classList.remove('heavy');
        const newKb = Math.round(newSize / 1024);
        infoDiv.innerHTML = `
            <span class="size-val">${newKb} KB</span>
            <span class="saved-badge">-${savedPercent}%</span>
        `;
    }
}

function showCreditConfirmModal(count, outputFormat, isBulk, onConfirm) {
    const old = document.getElementById('itc-confirm-modal');
    if (old) old.remove();

    const title = isBulk ? `Use ${count} Credits?` : `Use 1 Credit?`;
    const desc = isBulk 
        ? `This will compress <strong>${count} heavy images</strong> to ${outputFormat.toUpperCase()} and download them.`
        : `This will compress this image via Edge API and save it as <strong>${outputFormat.toUpperCase()}</strong>.`;

    const modal = document.createElement('div');
    modal.id = 'itc-confirm-modal';
    modal.innerHTML = `
        <div class="modal-overlay">
            <div class="modal-box">
                <div class="modal-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                </div>
                <h3 class="modal-title">${title}</h3>
                <p class="modal-desc">${desc}</p>
                <div class="modal-credit-tag">💳 ${count} Credit(s) will be deducted</div>
                <div class="modal-actions">
                    <button id="modal-cancel" class="modal-btn-cancel">Cancel</button>
                    <button id="modal-confirm" class="modal-btn-confirm">Yes, Proceed</button>
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
                switchTab('settings');
                const existing = document.getElementById('itc-key-error');
                if (!existing) {
                    const err = document.createElement('p');
                    err.id = 'itc-key-error';
                    err.style.cssText = 'color:#ef4444;font-size:12px;font-weight:700;margin-top:10px;';
                    err.textContent = '⚠️ Please enter your API key to compress images.';
                    document.getElementById('save-key-btn').after(err);
                }
                return resolve({success: false});
            }

            try {
                chrome.runtime.sendMessage({
                    action: "download_compress", 
                    url: imageUrl, 
                    apiKey: apiKey 
                }, (response) => {
                    resolve(response);
                });
            } catch(e) {
                console.error(e);
                resolve({success: false});
            }
        });
    });
}
