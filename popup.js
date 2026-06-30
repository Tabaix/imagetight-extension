document.addEventListener('DOMContentLoaded', async () => {
    let currentImages = [];
    let currentFormat = 'webp';
    let currentEngine = 'local'; // 'local' = free browser, 'cloud' = paid API

    // ── Tab switching ────────────────────────────────────────────────────────
    document.getElementById('tab-scanner').addEventListener('click', () => switchTab('scanner'));
    document.getElementById('tab-settings').addEventListener('click', () => switchTab('settings'));

    // ── Load saved settings on startup ───────────────────────────────────────
    chrome.storage.local.get(['itc_api_key', 'itc_format', 'itc_gemini_key', 'itc_engine'], (result) => {
        if (result.itc_api_key) {
            document.getElementById('api-key-input').value = result.itc_api_key;
            fetchCredits(result.itc_api_key);
        } else {
            // No cloud key — only redirect to settings if also no Gemini key
            if (!result.itc_gemini_key) switchTab('settings');
        }
        if (result.itc_gemini_key) {
            document.getElementById('gemini-key-input').value = result.itc_gemini_key;
        }
        if (result.itc_format) {
            currentFormat = result.itc_format;
            document.getElementById('format-select').value = result.itc_format;
        }
        if (result.itc_engine) {
            currentEngine = result.itc_engine;
            document.getElementById('engine-select').value = result.itc_engine;
        }
        updateEngineUI(currentEngine);
    });

    // ── Engine select: toggle cloud API key field visibility ─────────────────
    document.getElementById('engine-select').addEventListener('change', (e) => {
        currentEngine = e.target.value;
        updateEngineUI(currentEngine);
    });

    // ── Format select: update live output format for compression ────────────
    document.getElementById('format-select').addEventListener('change', (e) => {
        currentFormat = e.target.value;
    });

    // ── Save Settings ────────────────────────────────────────────────────────
    document.getElementById('save-key-btn').addEventListener('click', () => {
        const key       = document.getElementById('api-key-input').value.trim();
        const geminiKey = document.getElementById('gemini-key-input').value.trim();
        const format    = document.getElementById('format-select').value;
        const engine    = document.getElementById('engine-select').value;
        currentFormat = format;
        currentEngine = engine;

        chrome.storage.local.set(
            { itc_api_key: key, itc_format: format, itc_gemini_key: geminiKey, itc_engine: engine },
            () => {
                const btn = document.getElementById('save-key-btn');
                document.getElementById('itc-key-error')?.remove();

                if (key) {
                    fetchCredits(key);
                } else {
                    document.getElementById('credit-badge').style.display = 'none';
                }

                btn.innerText = '✅ Settings Saved!';
                setTimeout(() => { btn.innerText = 'Save Settings'; }, 2000);
            }
        );
    });

    // ── Scan Page ────────────────────────────────────────────────────────────
    document.getElementById('scan-btn').addEventListener('click', async () => {
        const resultsDiv = document.getElementById('results');
        resultsDiv.innerHTML = '<div class="loader">Analyzing DOM Assets...</div>';

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error('No active tab');

            const tabUrl = tab.url || '';
            if (
                tabUrl.startsWith('chrome://') ||
                tabUrl.startsWith('edge://') ||
                tabUrl.startsWith('about:')
            ) {
                resultsDiv.innerHTML = '<div class="empty-state"><p>Cannot scan internal browser pages.</p></div>';
                return;
            }

            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
                if (chrome.runtime.lastError) {
                    resultsDiv.innerHTML = `<div class="empty-state"><p>Access Denied. Reload the page and try again.</p></div>`;
                    return;
                }

                chrome.tabs.sendMessage(tab.id, { action: 'scan_images' }, (response) => {
                    if (chrome.runtime.lastError || !response) {
                        resultsDiv.innerHTML = '<div class="empty-state"><p>Scan failed. Try refreshing the page.</p></div>';
                        return;
                    }
                    currentImages = Array.isArray(response.images) ? response.images : [];
                    updateScorePanel(currentImages);
                    renderImages(currentImages, currentFormat);
                });
            });
        } catch (err) {
            resultsDiv.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
        }
    });

    // ── Filter buttons ───────────────────────────────────────────────────────
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            renderImages(currentImages, currentFormat, e.currentTarget.dataset.filter);
        });
    });

    // ── Bulk Compress ────────────────────────────────────────────────────────
    document.getElementById('bulk-compress-btn').addEventListener('click', async () => {
        const heavyImages = currentImages.filter(img => (img.size / 1024) > 250);
        if (heavyImages.length === 0) return;

        // Free local mode skips credit modal
        if (currentEngine === 'local') {
            await runBulkCompress(heavyImages);
        } else {
            showCreditConfirmModal(heavyImages.length, currentFormat, true, () => runBulkCompress(heavyImages));
        }
    });

    async function runBulkCompress(heavyImages) {
        const btn = document.getElementById('bulk-compress-btn');
        const progress = document.getElementById('bulk-progress');
        btn.disabled = true;
        btn.innerHTML = '⏳ Compressing...';
        progress.classList.remove('hidden');

        let successCount = 0;
        for (let i = 0; i < heavyImages.length; i++) {
            progress.innerText = `Processing ${i + 1} of ${heavyImages.length}...`;
            const imgBtn = document.querySelector(`.compress-btn[data-url="${CSS.escape(heavyImages[i].src)}"]`);
            const res = await triggerCompression(heavyImages[i].src, currentFormat);
            if (res && res.success) {
                successCount++;
                if (imgBtn) updateImgUIAfterSuccess(imgBtn, res.oldSize, res.newSize);
            } else {
                if (imgBtn) { imgBtn.innerHTML = '❌'; imgBtn.disabled = false; }
            }
        }

        progress.innerText = `✅ Done! Compressed ${successCount}/${heavyImages.length} images.`;
        btn.innerHTML = `Bulk Compress Complete`;
        btn.disabled = false;
        setTimeout(() => progress.classList.add('hidden'), 6000);

        chrome.storage.local.get(['itc_api_key'], (res) => {
            if (res.itc_api_key) fetchCredits(res.itc_api_key);
        });
    }

    // ── Bulk Download Originals ──────────────────────────────────────────────
    document.getElementById('bulk-download-btn').addEventListener('click', () => {
        if (currentImages.length === 0) return;

        const btn = document.getElementById('bulk-download-btn');
        btn.disabled = true;
        btn.innerHTML = '⏳ Downloading...';

        const urls = currentImages.map(img => img.src);
        chrome.runtime.sendMessage({ action: 'bulk_download', urls }, (res) => {
            btn.disabled = false;
            if (res && res.success) {
                btn.innerHTML = '✅ Downloaded!';
            } else {
                btn.innerHTML = '❌ Download Failed';
            }
            setTimeout(() => {
                btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download All Scanned Originals`;
                btn.disabled = false;
            }, 4000);
        });
    });
}); // end DOMContentLoaded

// ── Tab Switch ────────────────────────────────────────────────────────────────
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById(`content-${tabId}`).classList.remove('hidden');
}

// ── Engine UI update ──────────────────────────────────────────────────────────
function updateEngineUI(engine) {
    const cloudKeyGroup = document.getElementById('cloud-key-group');
    const engineNote    = document.getElementById('engine-note');
    if (cloudKeyGroup) {
        cloudKeyGroup.style.display = engine === 'cloud' ? 'block' : 'block'; // always visible
    }
    if (engineNote) {
        engineNote.innerText = engine === 'local'
            ? '🆓 Local mode: compression runs entirely in your browser — no credits used.'
            : '☁️ Cloud mode: images are compressed via ImageTight servers — 1 credit per image.';
    }
}

// ── Fetch Credits from API ────────────────────────────────────────────────────
async function fetchCredits(apiKey) {
    const badge = document.getElementById('credit-badge');
    badge.style.display = 'inline-block';
    badge.innerText = '💳 Loading...';

    try {
        const res = await fetch(`https://imagetight-api.vercel.app/api/quota?api_key=${apiKey}`);
        if (res.ok) {
            const data = await res.json();
            if (data.credits_remaining !== undefined) {
                badge.innerText = `💳 ${data.credits_remaining} Credits`;
                badge.style.background = '#22c55e';
                badge.style.color = '#ffffff';
            } else {
                badge.innerText = '💳 Active';
            }
        } else {
            badge.innerText = '⚠️ Invalid Key';
            badge.style.background = '#ef4444';
            badge.style.color = '#ffffff';
        }
    } catch (e) {
        badge.innerText = '💳 Active';
    }
}

// ── Score Panel ───────────────────────────────────────────────────────────────
function updateScorePanel(images) {
    document.getElementById('scan-intro-card').classList.add('hidden');
    document.getElementById('score-card').classList.remove('hidden');
    document.getElementById('filter-bar').classList.remove('hidden');

    let totalWeight = 0, heavyCount = 0, noAltCount = 0;
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
    let score = 100 - (heavyCount * 10) - (noAltCount * 2);
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

// ── Render Image Cards ────────────────────────────────────────────────────────
function renderImages(images, currentFormat, filter = 'all') {
    const container = document.getElementById('results');
    container.innerHTML = '';

    let filtered = images;
    if (filter === 'heavy')  filtered = images.filter(img => img.size > 250000);
    if (filter === 'no-alt') filtered = images.filter(img => !img.hasAlt);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No images match this filter. 🎉</p></div>`;
        return;
    }

    // Read engine from storage to decide credit modal behaviour
    chrome.storage.local.get(['itc_engine'], (store) => {
        const engine = store.itc_engine || 'local';

        filtered.forEach(img => {
            const card = document.createElement('div');
            card.className = 'img-item';

            const sizeKb = Math.round(img.size / 1024);
            const formatSize = sizeKb > 1024 ? (sizeKb / 1024).toFixed(2) + ' MB' : sizeKb + ' KB';
            const isHeavy = sizeKb > 250;
            const altContainerClass = img.alt ? 'alt-text-container' : 'alt-text-container hidden';

            card.innerHTML = `
                <img src="${img.src}" class="img-thumb" alt="Preview" onerror="this.src='icon.png'">
                <div class="img-info">
                    <div class="img-size ${isHeavy ? 'heavy' : ''}">
                        <span class="size-val">${img.size > 0 ? formatSize : 'Unknown'}</span>
                    </div>
                    <div class="img-dim">${img.width}x${img.height} px ${!img.hasAlt ? '<span class="alt-warning">Missing Alt</span>' : ''}</div>
                    <div class="img-url" title="${img.src}">${img.src}</div>
                    <div class="${altContainerClass}">
                        <span class="alt-label">Alt:</span>
                        <span class="alt-val">${img.alt || ''}</span>
                        <button class="copy-alt-btn" title="Copy Alt Text">📋</button>
                    </div>
                </div>
                <div class="img-actions">
                    <button class="alt-btn" title="Generate AI Alt Text" data-url="${img.src}">✨</button>
                    <button class="compress-btn" title="${engine === 'local' ? 'Compress Free (Browser)' : 'Compress via Cloud API'}" data-url="${img.src}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </button>
                </div>
            `;

            // ── Compress button ──
            card.querySelector('.compress-btn').addEventListener('click', (e) => {
                const btn = e.currentTarget;

                const doCompress = () => {
                    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
                    btn.disabled = true;
                    triggerCompression(img.src, currentFormat).then((res) => {
                        if (res && res.success) {
                            updateImgUIAfterSuccess(btn, res.oldSize, res.newSize);
                        } else {
                            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
                            btn.title = `Failed: ${res?.error || 'Check API key & credits.'}`;
                            btn.disabled = false;
                        }
                        chrome.storage.local.get(['itc_api_key'], (r) => {
                            if (r.itc_api_key) fetchCredits(r.itc_api_key);
                        });
                    });
                };

                // Local mode: no credit modal needed
                if (engine === 'local') {
                    doCompress();
                } else {
                    showCreditConfirmModal(1, currentFormat, false, doCompress);
                }
            });

            // ── AI Alt button ──
            card.querySelector('.alt-btn').addEventListener('click', (e) => {
                const btn = e.currentTarget;

                chrome.storage.local.get(['itc_gemini_key', 'itc_api_key'], (storageResult) => {
                    const geminiKey = storageResult.itc_gemini_key;
                    const apiKey    = storageResult.itc_api_key;

                    if (!geminiKey && !apiKey) {
                        switchTab('settings');
                        alert('Set an ImageTight API Key or a Google Gemini Key in settings.');
                        return;
                    }

                    const doGenerate = () => {
                        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
                        btn.disabled = true;

                        triggerAltGeneration(img.src).then((res) => {
                            if (res && res.success) {
                                btn.innerHTML = '✨';
                                btn.disabled = false;
                                const altContainer = card.querySelector('.alt-text-container');
                                altContainer.classList.remove('hidden');
                                altContainer.querySelector('.alt-val').innerText = res.alt;
                                img.hasAlt = true;
                                img.alt = res.alt;
                                card.querySelector('.alt-warning')?.remove();
                                updateScorePanel(images);
                            } else {
                                btn.innerHTML = '⚠️';
                                btn.title = `Failed: ${res?.error || 'Check your API key.'}`;
                                btn.disabled = false;
                            }
                            if (apiKey) fetchCredits(apiKey);
                        });
                    };

                    // Gemini key = free, no modal. Cloud only = credit modal.
                    if (geminiKey) {
                        doGenerate();
                    } else {
                        showCreditConfirmModal(1, 'AI Alt Text', false, doGenerate);
                    }
                });
            });

            // ── Copy Alt button ──
            const copyBtn = card.querySelector('.copy-alt-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const altText = card.querySelector('.alt-val').innerText;
                    navigator.clipboard.writeText(altText);
                    copyBtn.innerText = '✅';
                    setTimeout(() => { copyBtn.innerText = '📋'; }, 2000);
                });
            }

            container.appendChild(card);
        });
    });

    // Inject spin keyframes once
    if (!document.getElementById('spin-style')) {
        const s = document.createElement('style');
        s.id = 'spin-style';
        s.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`;
        document.head.appendChild(s);
    }
}

// ── Update image card UI after successful compression ─────────────────────────
function updateImgUIAfterSuccess(btn, oldSize, newSize) {
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.title = 'Compressed & saved to Downloads.';
    btn.style.background = 'rgba(34,197,94,0.1)';
    btn.style.borderColor = 'rgba(34,197,94,0.5)';

    const infoDiv = btn.parentElement?.parentElement?.querySelector('.img-size');
    if (infoDiv && oldSize && newSize) {
        const savedPercent = Math.round(((oldSize - newSize) / oldSize) * 100);
        const newKb = Math.round(newSize / 1024);
        infoDiv.classList.remove('heavy');
        infoDiv.innerHTML = `<span class="size-val">${newKb} KB</span><span class="saved-badge">-${savedPercent}%</span>`;
    }
}

// ── Credit Confirmation Modal ─────────────────────────────────────────────────
function showCreditConfirmModal(count, outputFormat, isBulk, onConfirm) {
    document.getElementById('itc-confirm-modal')?.remove();

    const title = isBulk ? `Use ${count} Credits?` : `Use 1 Credit?`;
    const desc  = isBulk
        ? `This will compress <strong>${count} heavy images</strong> via ImageTight Cloud to ${String(outputFormat).toUpperCase()} and download them.`
        : `This will use 1 ImageTight credit to process this image.`;

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

// ── Trigger Cloud/Local Compression ──────────────────────────────────────────
async function triggerCompression(imageUrl, format) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['itc_api_key', 'itc_engine', 'itc_format'], (result) => {
            const apiKey = result.itc_api_key;
            const engine = result.itc_engine || 'local';
            const desiredFormat = format || result.itc_format || 'webp';

            if (engine === 'cloud' && !apiKey) {
                switchTab('settings');
                const existing = document.getElementById('itc-key-error');
                if (!existing) {
                    const err = document.createElement('p');
                    err.id = 'itc-key-error';
                    err.style.cssText = 'color:#ef4444;font-size:12px;font-weight:700;margin-top:10px;';
                    err.textContent = '⚠️ Cloud mode requires an ImageTight API key.';
                    document.getElementById('save-key-btn')?.after(err);
                }
                return resolve({ success: false, error: 'No API key for cloud mode.' });
            }

            chrome.runtime.sendMessage(
                { action: 'download_compress', url: imageUrl, apiKey, engine, format: desiredFormat },
                (response) => resolve(response || { success: false, error: 'No response from background.' })
            );
        });
    });
}

// ── Trigger Alt Text Generation ───────────────────────────────────────────────
async function triggerAltGeneration(imageUrl) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['itc_api_key', 'itc_gemini_key'], (result) => {
            chrome.runtime.sendMessage(
                {
                    action: 'generate_alt',
                    url: imageUrl,
                    apiKey: result.itc_api_key,
                    geminiKey: result.itc_gemini_key
                },
                (response) => resolve(response || { success: false, error: 'No response from background.' })
            );
        });
    });
}
