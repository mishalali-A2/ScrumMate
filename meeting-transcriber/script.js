/**
 * Recall.ai: bot has actually entered the call (not only HTTP 200 from create-bot).
 * @see https://docs.recall.ai/docs/bot-status-change-events
 */
const RECALL_BOT_IN_CALL = new Set(['in_call_recording', 'in_call_not_recording']);

function recallStatusLabel(code) {
    const map = {
        joining_call: 'Joining call…',
        in_waiting_room: 'In waiting room…',
        in_call_recording: 'In call — live',
        in_call_not_recording: 'In call — live',
        call_ended: 'Call ended',
        recording_done: 'Recording finished',
        bot_errored: 'Error',
    };
    return map[code] || (code ? String(code).replace(/_/g, ' ') : 'Connecting…');
}

class MeetingLauncher {
    constructor() {
        document.getElementById('startBtn')?.addEventListener('click', () => this.startTranscription());
        this.checkServerQuiet();
    }

    /** Updates the topbar dot + label: 'inactive' | 'joining' | 'live' */
    setTopbarStatus(state) {
        const dot   = document.getElementById('botStatusDot');
        const label = document.getElementById('botStatusLabel');
        if (!dot || !label) return;
        const states = { inactive: 'Inactive', joining: 'Joining', live: 'Live' };
        dot.className   = `tx-bot-dot tx-bot-dot--${state}`;
        label.className = `tx-bot-label tx-bot-label--${state}`;
        label.textContent = states[state] ?? 'Inactive';
    }

    async checkServerQuiet() {
        try { await fetch('/api/bots'); } catch { /* non-blocking */ }
    }

    setConnecting(message, isError = false) {
        const el = document.getElementById('txConnecting');
        if (!el) return;
        if (!message) {
            el.hidden = true;
            el.textContent = '';
            el.classList.remove('tx-connecting--error');
            return;
        }
        el.hidden = false;
        el.textContent = message;
        el.classList.toggle('tx-connecting--error', isError);
    }

    async startTranscription() {
        const meetingUrl = document.getElementById('meetingUrl').value.trim();
        const meetingTypeSelect = document.getElementById('meetingTypeSelect');
        if (meetingTypeSelect?.value) {
            selectedMeetingType = meetingTypeSelect.value;
        } else if (document.getElementById('retrospective')?.checked) {
            selectedMeetingType = 'retrospective';
        } else if (document.getElementById('dailyStandup')?.checked) {
            selectedMeetingType = 'daily-standup';
        } else {
            selectedMeetingType = 'product-owner';
        }

        if (!meetingUrl) {
            alert('Please enter a Google Meet URL');
            return;
        }
        if (!meetingUrl.includes('meet.google.com')) {
            alert('Please enter a valid Google Meet URL');
            return;
        }

        const startBtn = document.getElementById('startBtn');
        if (startBtn) startBtn.disabled = true;
        this.setTopbarStatus('joining');
        this.setConnecting('Creating bot…');

        try {
            const response = await fetch('/api/create-bot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meetingUrl, meetingType: selectedMeetingType }),
            });
            const data = await response.json();

            if (!data.success) {
                this.setConnecting(String(data.error?.detail || data.error || 'Could not create bot'), true);
                this.setTopbarStatus('inactive');
                if (startBtn) startBtn.disabled = false;
                return;
            }

            sessionStorage.setItem('scmate_meeting_type', selectedMeetingType);
            await this.waitUntilInCall(data.botId);
        } catch (error) {
            this.setConnecting('Connection error: ' + error.message, true);
            this.setTopbarStatus('inactive');
            if (startBtn) startBtn.disabled = false;
        }
    }

    async waitUntilInCall(botId) {
        const startBtn = document.getElementById('startBtn');
        const maxMs = 240000;
        const t0 = Date.now();
        this.setConnecting('Waiting to enter the call…');

        while (Date.now() - t0 < maxMs) {
            try {
                const r = await fetch(`/api/bot/${botId}`);
                const data = await r.json();
                if (data.success && data.bot) {
                    const code = data.bot.status;

                    // Primary: status code from Recall (works with webhooks / public URL)
                    const statusKnown = RECALL_BOT_IN_CALL.has(code);

                    // Fallback: transcript data arriving means the bot is live in the call.
                    // This covers local dev where webhooks can't reach localhost so
                    // status_changes stays empty, but the transcript endpoint still works.
                    const transcriptLive = data.hasTranscript === true;

                    if (statusKnown || transcriptLive) {
                        this.setTopbarStatus('live');
                        window.location.href = `session.html?bot=${encodeURIComponent(botId)}`;
                        return;
                    }

                    // Update the connecting label only when we have a meaningful status
                    if (code && code !== 'unknown') {
                        this.setConnecting(recallStatusLabel(code));
                    }
                }
            } catch {
                /* keep polling */
            }
            await new Promise((res) => setTimeout(res, 2000));
        }

        this.setConnecting('The bot did not enter the call in time. Check Google Meet, then try again.', true);
        this.setTopbarStatus('inactive');
        if (startBtn) startBtn.disabled = false;
    }
}

class MeetingSession {
    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.currentBotId = params.get('bot');
        if (!this.currentBotId) {
            window.location.href = 'index.html';
            return;
        }
        this.pollingInterval = null;
        this.updateInterval = 3000;
        selectedMeetingType = sessionStorage.getItem('scmate_meeting_type') || 'product-owner';

        this.bindEvents();
        this.checkServerQuiet();

        const pending = params.get('pending') === '1';
        const banner = document.getElementById('sessionPendingBanner');
        if (pending && banner) banner.hidden = false;

        this.showBotInfo(this.currentBotId);
        const stopBtn = document.getElementById('stopBtn');
        if (stopBtn) stopBtn.disabled = false;
        this.startPolling();
    }

    bindEvents() {
        document.getElementById('stopBtn')?.addEventListener('click', () => this.stopTranscription());
        document.getElementById('clearBtn')?.addEventListener('click', () => this.clearTranscript());
        document.getElementById('copyBtn')?.addEventListener('click', () => this.copyTranscript());
    }

    async checkServerQuiet() {
        const dot = document.getElementById('serverHealth');
        try {
            const response = await fetch('/api/bots');
            if (!response.ok) throw new Error('bad');
            dot?.classList.remove('is-off');
            if (dot) dot.removeAttribute('title');
        } catch {
            dot?.classList.add('is-off');
            if (dot) dot.title = 'Cannot reach app server';
        }
    }

    async stopTranscription() {
        if (!this.currentBotId) return;
        
        this.updateStatus('Stopping bot and leaving meeting...', 'processing');
        
        try {
            const response = await fetch(`/api/bot/${this.currentBotId}`, {
                method: 'DELETE'
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Stop polling immediately
                this.stopPolling();
                
                this.updateStatus('Bot left meeting. Transcript saved!', 'success');
                
                // Display the final transcript
                if (data.transcript && data.transcript.length > 0) {
                    this.displayFinalTranscript(data.transcript, data.statistics);
                } else {
                    this.updateStatus('No transcript data available', 'idle');
                }
                
                // Show success notification with download
                if (data.transcript_file) {
                    this.showTranscriptSavedNotification(data.transcript_file, data.statistics);
                }
                
                // Update UI
                document.getElementById('stopBtn') && (document.getElementById('stopBtn').disabled = true);
                const startBtn = document.getElementById('startBtn');
                if (startBtn) startBtn.disabled = false;
                this.hideBotInfo();
                
                // Clear bot ID
                this.currentBotId = null;
            } else {
                this.updateStatus('Error: ' + (data.error || 'Failed to stop'), 'error');
            }
        } catch (error) {
            this.updateStatus('Error stopping transcription: ' + error.message, 'error');
            console.error('Stop error:', error);
        }
    }
    
    startPolling() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        
        this.pollingInterval = setInterval(() => {
            this.fetchTranscript();
        }, 2000); // Poll every 2 seconds
        
        // Fetch immediately
        this.fetchTranscript();
    }
    
    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }
    
    async fetchTranscript() {
        if (!this.currentBotId) return;
        
        try {
            const response = await fetch(`/api/bot/${this.currentBotId}`);
            const data = await response.json();
            
            if (data.success) {
                const bs = document.getElementById('botStatus');
                if (bs) bs.textContent = data.bot.status;
                
                // Update transcript if available
                if (data.hasTranscript && data.transcript.length > 0) {
                    this.displayTranscript(data.transcript);
                } else {
                    // Show waiting message
                    const transcriptContainer = document.getElementById('transcript');
                    transcriptContainer.innerHTML = `
                        <div class="tx-empty">
                            <p><strong>${recallStatusLabel(data.bot?.status)}</strong></p>
                            <p>Transcript appears when speech is detected.</p>
                        </div>
                    `;
                }
            }
        } catch (error) {
            console.log('Polling error:', error);
        }
    }
    
    displayTranscript(transcriptData) {
        const transcriptContainer = document.getElementById('transcript');
        
        if (!transcriptData || transcriptData.length === 0) {
            transcriptContainer.innerHTML = `
                <div class="tx-empty">
                    <p>No speech yet — the bot is still listening.</p>
                </div>
            `;
            this.updateStats(0, 0);
            return;
        }
        
        // Group by speaker
        const groupedTranscript = this.groupBySpeaker(transcriptData);
        
        let transcriptHTML = '';
        let speakerCount = 0;
        let wordCount = 0;
        
        Object.entries(groupedTranscript).forEach(([speaker, words]) => {
            speakerCount++;
            const speakerText = words.map(w => w.text).join(' ');
            wordCount += words.length;
            
            transcriptHTML += `
                <div class="speaker-block">
                    <div class="speaker-header">
                        <span class="speaker-mark" aria-hidden="true"></span>
                        <span class="speaker-name">${speaker}</span>
                    </div>
                    <div class="speaker-text">${speakerText}</div>
                </div>
            `;
        });
        
        transcriptContainer.innerHTML = transcriptHTML;
        this.updateStats(speakerCount, wordCount);
        this.updateLastUpdate();
        
        // Auto-scroll to bottom
        transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
    }
    
    displayFinalTranscript(transcriptData, statistics) {
        const transcriptContainer = document.getElementById('transcript');
        
        if (!transcriptData || transcriptData.length === 0) {
            transcriptContainer.innerHTML = `
                <div class="tx-empty">
                    <p>No transcript data available.</p>
                </div>
            `;
            return;
        }
        
        let transcriptHTML = `
            <div class="tx-final-summary">
                <div class="tx-final-summary-title">Meeting saved</div>
                <div class="tx-final-summary-grid">
                    <div><span class="tx-final-kpi-label">Speakers</span><span class="tx-final-kpi">${statistics.total_speakers}</span></div>
                    <div><span class="tx-final-kpi-label">Words</span><span class="tx-final-kpi">${statistics.total_words}</span></div>
                    <div><span class="tx-final-kpi-label">Entries</span><span class="tx-final-kpi">${statistics.total_entries}</span></div>
                    <div><span class="tx-final-kpi-label">Duration</span><span class="tx-final-kpi">${Math.floor(statistics.duration / 60)}m ${statistics.duration % 60}s</span></div>
                </div>
            </div>
        `;
        
        // Group consecutive messages by speaker
        const groupedMessages = [];
        let currentSpeaker = null;
        let currentText = [];
        
        transcriptData.forEach((item, index) => {
            if (item.speaker !== currentSpeaker) {
                if (currentSpeaker !== null) {
                    groupedMessages.push({
                        speaker: currentSpeaker,
                        text: currentText.join(' ')
                    });
                }
                currentSpeaker = item.speaker;
                currentText = [item.text];
            } else {
                currentText.push(item.text);
            }
            
            // Push last group
            if (index === transcriptData.length - 1) {
                groupedMessages.push({
                    speaker: currentSpeaker,
                    text: currentText.join(' ')
                });
            }
        });
        
        // Render grouped messages
        groupedMessages.forEach(msg => {
            transcriptHTML += `
                <div class="speaker-block">
                    <div class="speaker-header">
                        <span class="speaker-mark" aria-hidden="true"></span>
                        <span class="speaker-name">${msg.speaker}</span>
                    </div>
                    <div class="speaker-text">${msg.text}</div>
                </div>
            `;
        });
        
        transcriptContainer.innerHTML = transcriptHTML;
        this.updateStats(statistics.total_speakers, statistics.total_words);
        
        // Scroll to top to see the summary
        transcriptContainer.scrollTop = 0;
    }
    
    groupBySpeaker(transcriptData) {
        const groups = {};
        
        transcriptData.forEach(item => {
            const speaker = item.speaker || 'Unknown Speaker';
            if (!groups[speaker]) {
                groups[speaker] = [];
            }
            groups[speaker].push(item);
        });
        
        return groups;
    }
    
    updateStats(speakerCount, wordCount) {
        const sc = document.getElementById('speakerCount');
        const wc = document.getElementById('wordCount');
        if (sc) sc.textContent = speakerCount;
        if (wc) wc.textContent = wordCount;
    }
    
    updateLastUpdate() {
        const el = document.getElementById('lastUpdate');
        if (!el) return;
        const now = new Date();
        el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    
    clearTranscript() {
        const transcriptContainer = document.getElementById('transcript');
        transcriptContainer.innerHTML = `
            <div class="tx-empty">
                <p>Transcript cleared.</p>
            </div>
        `;
        this.updateStats(0, 0);
    }
    
    async copyTranscript() {
        const transcriptContainer = document.getElementById('transcript');
        const speakerBlocks = transcriptContainer.querySelectorAll('.speaker-block');
        
        if (speakerBlocks.length === 0) {
            alert('No transcript to copy');
            return;
        }
        
        let textToCopy = '';
        speakerBlocks.forEach(block => {
            const speaker = block.querySelector('.speaker-name').textContent;
            const text = block.querySelector('.speaker-text').textContent;
            textToCopy += `${speaker}: ${text}\n\n`;
        });
        
        try {
            await navigator.clipboard.writeText(textToCopy);
            this.showNotification('Transcript copied to clipboard!', 'success');
        } catch (error) {
            alert('Failed to copy transcript: ' + error.message);
        }
    }
    
    updateStatus(message, type) {
        const statusElement = document.getElementById('status');
        if (!statusElement) return;
        statusElement.textContent = message;
        statusElement.className = `status tx-live-status ${type}`;
        
        const icon = statusElement.querySelector('i');
        if (icon) {
            icon.className = this.getStatusIcon(type);
        } else {
            statusElement.innerHTML = `<i class="${this.getStatusIcon(type)}"></i> ${message}`;
        }
    }
    
    getStatusIcon(type) {
        switch(type) {
            case 'success': return 'fas fa-check-circle';
            case 'error': return 'fas fa-exclamation-circle';
            case 'processing': return 'fas fa-sync-alt fa-spin';
            default: return 'fas fa-clock';
        }
    }
    
    showBotInfo(botId) {
        const bid = document.getElementById('botId');
        const bs = document.getElementById('botStatus');
        const info = document.getElementById('botInfo');
        if (bid) bid.textContent = botId.substring(0, 8) + '...';
        if (bs) bs.textContent = 'joining';
        if (info) info.style.display = 'block';
    }
    
    hideBotInfo() {
        const info = document.getElementById('botInfo');
        if (info) info.style.display = 'none';
    }
    
    showNotification(message, type) {
        // Create a temporary notification
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas fa-${type === 'success' ? 'check' : 'exclamation'}-circle"></i>
            ${message}
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }
    
    showTranscriptSavedNotification(filename, statistics) {
        const notification = document.createElement('div');
        notification.className = 'notification success large';
        notification.innerHTML = `
            <div class="notification-content">
                <div class="notification-header">
                    <i class="fas fa-check-circle"></i>
                    <div>
                        <strong>Transcript Saved!</strong>
                        <div class="notification-subtitle">Bot has left the meeting</div>
                    </div>
                </div>
                
                <div class="notification-stats">
                    <div>${statistics.total_speakers} speakers | ${statistics.total_words} words</div>
                    <div>Duration: ${Math.floor(statistics.duration / 60)}m ${statistics.duration % 60}s</div>
                    <div>${statistics.total_entries} transcript entries</div>
                </div>
                
                <div class="notification-actions">
                    <a href="/api/download/${filename}" download="${filename}" class="btn-download">
                        <i class="fas fa-download"></i> Download JSON
                    </a>
                    <button onclick="runPipeline('${filename}')" class="btn-pipeline">
                        <i class="fas fa-cogs"></i> Run Pipeline
                    </button>
                </div>
            </div>
        `;
        
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            min-width: 400px;
            max-width: 500px;
            z-index: 10000;
            box-shadow: 0 20px 60px rgba(0,0,0,0.4);
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            color: white;
            border-radius: 12px;
            animation: slideIn 0.3s ease-out;
        `;
        
        document.body.appendChild(notification);
        
        // Store filename for later use
        this.lastTranscriptFile = filename;
        
        // Auto-dismiss after 15 seconds (longer to allow pipeline trigger)
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-in';
            setTimeout(() => notification.remove(), 300);
        }, 15000);
    }
}

// Pipeline functions (global scope for onclick handlers)
let currentMeetingId = null;
let pipelinePollingInterval = null;
let selectedMeetingType = 'product-owner'; // captured when meeting starts

async function runPipeline(filename) {
    // Close any notification
    document.querySelectorAll('.notification.large').forEach(n => n.remove());

    // ── Reset & show modal ──────────────────────────────────────────────
    const modal = document.getElementById('pipelineModal');
    modal.style.display = 'flex';

    // Reset progress bar
    const fill = document.getElementById('pipeProgressFill');
    fill.style.width = '4%';
    fill.classList.add('pulsing');

    // Reset stage labels
    document.querySelectorAll('.pipe-stage').forEach(s => s.classList.remove('active', 'done'));
    document.querySelector('[data-step="chunking"]')?.classList.add('active');

    // Reset result / error panels
    document.getElementById('pipelineResult').style.display = 'none';
    document.getElementById('pipelineError').style.display = 'none';
    document.getElementById('pipelineStatus').textContent = 'Starting pipeline…';

    // Set meeting-type badge
    const typeLabels = { 'daily-standup': 'Daily Standup', 'product-owner': 'Product Owner', 'retrospective': 'Retrospective' };
    const typeCls    = { 'daily-standup': 'standup', 'retrospective': 'retro' };
    const badge = document.getElementById('pipeMeetingBadge');
    badge.textContent = typeLabels[selectedMeetingType] || 'Meeting';
    badge.className   = 'pipe-badge ' + (typeCls[selectedMeetingType] || '');

    // Reset icon & title
    const iconWrap = document.getElementById('pipeIconWrap');
    iconWrap.className = 'pipe-icon-wrap';
    document.getElementById('pipeHeadIcon').className = 'fas fa-cogs pipe-spin';
    document.getElementById('pipeSubtitle').textContent = 'Analysing your transcript…';
    const title = document.querySelector('.pipe-title');
    if (title) title.textContent = 'Meeting concluded';

    // After ~30s, drop a friendly hint that longer runs are normal (especially
    // when the local Ollama fallback takes over).
    if (window._pipeSlowHintTimer) clearTimeout(window._pipeSlowHintTimer);
    window._pipeSlowHintTimer = setTimeout(() => {
        const sub = document.getElementById('pipeSubtitle');
        if (sub && document.getElementById('pipelineResult').style.display === 'none'
                && document.getElementById('pipelineError').style.display === 'none') {
            sub.textContent = 'Still working — longer runs are normal for complex transcripts.';
        }
    }, 30000);
    
    try {
        const response = await fetch('/api/pipeline/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcriptFile: filename,
                meetingType:    selectedMeetingType,
                projectId:      sessionStorage.getItem('selectedProjectId')   || null,
                projectName:    sessionStorage.getItem('selectedProjectName') || null,
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentMeetingId = data.meeting_id;
            // Start polling for status
            startPipelinePolling(data.meeting_id);
        } else {
            showPipelineError(data.error || 'Failed to start pipeline');
        }
    } catch (error) {
        showPipelineError('Connection error: ' + error.message);
    }
}

function startPipelinePolling(meetingId) {
    if (pipelinePollingInterval) {
        clearInterval(pipelinePollingInterval);
    }

    // Grace periods: the agentic API may not have registered the job yet when
    // the first poll fires (fire-and-forget race), and when the Ollama
    // fallback kicks in a single LLM call on a local CPU can take many
    // minutes. Be extremely patient — we'd rather wait than falsely fail.
    let notFoundStreak = 0;
    let errorStreak    = 0;
    const MAX_NOT_FOUND = 10;  // ~40s to register the job
    const MAX_ERRORS    = 240; // ~16 min of transient errors before giving up
    const POLL_MS       = 4000;

    pipelinePollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/pipeline/status/${meetingId}`);
            const data = await response.json();

            // 404 means the job isn't registered yet — keep retrying briefly.
            if (response.status === 404) {
                notFoundStreak++;
                if (notFoundStreak >= MAX_NOT_FOUND) {
                    clearInterval(pipelinePollingInterval);
                    showPipelineError('Pipeline job not found after waiting. Check the agentic API.', null, meetingId);
                }
                return;
            }

            notFoundStreak = 0;
            errorStreak    = 0; // reset on any real response

            if (!response.ok || (!data.success && data.error)) {
                clearInterval(pipelinePollingInterval);
                showPipelineError(data?.error || 'Request failed', null, meetingId);
                return;
            }

            if (data.status === 'completed') {
                clearInterval(pipelinePollingInterval);
                showPipelineComplete(meetingId, data.result, data.actual_meeting_id || meetingId);
            } else if (data.status === 'failed') {
                clearInterval(pipelinePollingInterval);
                showPipelineError(data.error || 'Pipeline failed', data.error_stage, meetingId);
            } else if (data.progress) {
                updatePipelineProgress(data.progress);
            }
        } catch (error) {
            // Network / timeout hiccups — tolerate many before aborting, since
            // a slow local LLM can legitimately make the agentic API
            // unresponsive for a while.
            errorStreak++;
            console.warn(`Pipeline polling hiccup (${errorStreak}/${MAX_ERRORS}):`, error.message);
            if (errorStreak >= MAX_ERRORS) {
                clearInterval(pipelinePollingInterval);
                showPipelineError(
                    'Lost connection to the agentic API after many retries. Is it still running on port 8000? ' + error.message,
                    null,
                    meetingId
                );
            }
        }
    }, POLL_MS);
}

function updatePipelineProgress(progress) {
    const p = (progress || '').toLowerCase();
    document.getElementById('pipelineStatus').textContent = progress || 'Processing…';

    // Map progress message to (% width, active step)
    let pct = 4, activeStep = 'chunking';
    if (p.includes('chunk'))                                         { pct = 18; activeStep = 'chunking'; }
    if (p.includes('embed'))                                         { pct = 42; activeStep = 'embedding'; }
    if (p.includes('minut') || p.includes('summar'))                 { pct = 66; activeStep = 'summarization'; }
    if (p.includes('stor') || p.includes('blocker') || p.includes('retro') || p.includes('assign')) { pct = 88; activeStep = 'userstories'; }

    const fill = document.getElementById('pipeProgressFill');
    if (fill) fill.style.width = pct + '%';

    // Update stage label highlights
    const stageOrder = ['chunking', 'embedding', 'summarization', 'userstories'];
    const activeIdx  = stageOrder.indexOf(activeStep);
    stageOrder.forEach((s, i) => {
        const el = document.querySelector(`.pipe-stage[data-step="${s}"]`);
        if (!el) return;
        el.classList.remove('active', 'done');
        if (i < activeIdx)  el.classList.add('done');
        if (i === activeIdx) el.classList.add('active');
    });
}

function showPipelineComplete(meetingId, result, actualMeetingId) {
    // Progress bar → 100%
    const fill = document.getElementById('pipeProgressFill');
    if (fill) { fill.style.width = '100%'; fill.classList.remove('pulsing'); }

    // All stage labels → done
    document.querySelectorAll('.pipe-stage').forEach(el => { el.classList.remove('active'); el.classList.add('done'); });

    // Header: swap to sparkle icon + update title & subtitle
    const iconWrap = document.getElementById('pipeIconWrap');
    if (iconWrap) iconWrap.className = 'pipe-icon-wrap done';
    const icon = document.getElementById('pipeHeadIcon');
    if (icon) icon.className = 'fas fa-check';
    const sub = document.getElementById('pipeSubtitle');
    if (sub) sub.textContent = 'Minutes, stories and outputs are ready.';
    const title = document.querySelector('.pipe-title');
    if (title) title.textContent = 'Analysis complete';

    // Hide live-status text
    document.getElementById('pipelineStatus').textContent = '';

    // Type-aware outputs label
    const typeIsStandup = selectedMeetingType === 'daily-standup';
    const secondary = typeIsStandup
        ? { num: result?.blockers_count ?? 0, label: 'blockers' }
        : { num: result?.stories_count   ?? 0, label: 'user stories' };
    const chunks = result?.chunks_count ?? 0;

    const resultDiv = document.getElementById('pipelineResult');
    resultDiv.innerHTML = `
        <div class="pipe-result-summary">
            <strong>${chunks}</strong> ${chunks === 1 ? 'chunk' : 'chunks'}
            <span class="dot-sep"></span>
            <strong>${secondary.num}</strong> ${secondary.label}
            <span class="dot-sep"></span>
            Saved to your workspace
        </div>
        <div class="pipe-result-actions">
            <a href="meetings.html" class="pipe-btn pipe-btn-primary">
                View in Past Meetings
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h6M6 3l3 3-3 3"/></svg>
            </a>
            <button onclick="closePipelineModal()" class="pipe-btn pipe-btn-ghost">Close</button>
        </div>`;
    resultDiv.style.display = 'block';
    resultDiv.dataset.resultsMeetingId = meetingId;
}

function showPipelineError(error, stage = null, meetingIdForResults = null) {
    // Progress bar — stop pulsing, tint red
    const fill = document.getElementById('pipeProgressFill');
    if (fill) { fill.classList.remove('pulsing'); fill.style.background = 'var(--danger)'; }

    // Header icon → error
    const iconWrap = document.getElementById('pipeIconWrap');
    if (iconWrap) iconWrap.className = 'pipe-icon-wrap fail';
    const icon = document.getElementById('pipeHeadIcon');
    if (icon) icon.className = 'fas fa-exclamation-circle';
    const sub = document.getElementById('pipeSubtitle');
    if (sub) sub.textContent = 'Something went wrong.';

    document.getElementById('pipelineStatus').textContent = '';

    const errorDiv = document.getElementById('pipelineError');
    errorDiv.innerHTML = `
        <div class="pipe-error-card">
            <div class="pipe-error-title"><i class="fas fa-times-circle"></i> Pipeline failed</div>
            <div class="pipe-error-msg">${error}</div>
            ${stage ? `<div class="pipe-error-stage">Stage: ${stage}</div>` : ''}
            ${meetingIdForResults ? `
                <div style="margin-top:12px">
                    <button onclick="viewPipelineResults('${meetingIdForResults}')" class="pipe-btn pipe-btn-ghost">
                        <i class="fas fa-eye"></i> Check partial results
                    </button>
                </div>` : ''}
        </div>`;
    errorDiv.style.display = 'block';
}

async function viewPipelineResults(meetingId) {
    try {
        const response = await fetch(`/api/pipeline/results/${meetingId}`);
        const data = await response.json();
        
        if (data.success) {
            const resultWindow = window.open('', '_blank');
            resultWindow.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Pipeline Results - ${data.meeting_id || meetingId}</title>
                    <style>
                        body { font-family: system-ui, sans-serif; padding: 20px; max-width: 960px; margin: 0 auto; background: #f5f5f5; color: #334155; }
                        h1 { color: #4f46e5; }
                        h2 { color: #334155; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-top: 30px; }
                        h3 { color: #475569; margin-top: 20px; }
                        pre { background: white; padding: 15px; border-radius: 8px; overflow-x: auto; border: 1px solid #e2e8f0; font-size: 13px; }
                        .minutes { background: white; padding: 20px; border-radius: 8px; white-space: pre-wrap; border: 1px solid #e2e8f0; line-height: 1.7; }
                        .card { background: white; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid #4f46e5; }
                        .card-id { font-weight: bold; color: #4f46e5; font-size: 12px; margin-bottom: 6px; }
                        .urgency-high, .impact-high, .priority-high { border-left-color: #ef4444; }
                        .urgency-medium, .impact-medium, .priority-medium { border-left-color: #f59e0b; }
                        .urgency-low, .impact-low, .priority-low { border-left-color: #10b981; }
                        .tag { display: inline-block; background: #e2e8f0; border-radius: 4px; padding: 2px 8px; font-size: 12px; margin-right: 4px; }
                        .section-label { font-weight: 600; color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 4px; }
                        ul { margin: 8px 0 0 0; padding-left: 20px; }
                        li { margin-bottom: 4px; }
                    </style>
                </head>
                <body>
                    <h1>Pipeline Results</h1>
                    <p><strong>Meeting ID:</strong> ${data.meeting_id || meetingId}</p>

                    ${data.minutes ? `
                        <h2>Meeting Minutes</h2>
                        <div class="minutes">${data.minutes.replace(/</g,'&lt;')}</div>
                    ` : ''}

                    ${data.user_stories ? `
                        <h2>User Stories (${data.user_stories.length})</h2>
                        ${data.user_stories.map(s => `
                            <div class="card urgency-${(s.urgency||'medium').toLowerCase()}">
                                <div class="card-id">${s.id}</div>
                                <p>${s.user_story}</p>
                                <span class="tag">${s.urgency}</span>
                                <span class="tag">${s.effort_points} pts</span>
                                <span class="tag">${s.skill_required}</span>
                                ${s.acceptance_criteria?.length ? `
                                    <div class="section-label" style="margin-top:10px">Acceptance Criteria</div>
                                    <ul>${s.acceptance_criteria.map(ac => `<li>${ac}</li>`).join('')}</ul>
                                ` : ''}
                            </div>
                        `).join('')}
                    ` : ''}

                    ${data.assignments ? `
                        <h2>Assignments</h2>
                        <pre>${JSON.stringify(data.assignments, null, 2)}</pre>
                    ` : ''}

                    ${data.blockers_report ? `
                        <h2>Blockers Report</h2>
                        <p><strong>Total Blockers:</strong> ${data.blockers_report.total_blockers ?? 0}</p>
                        ${data.blockers_report.team_updates?.length ? `
                            <h3>Team Updates</h3>
                            ${data.blockers_report.team_updates.map(u => `
                                <div class="card ${u.has_blocker ? 'urgency-high' : ''}">
                                    <div class="card-id">${u.member}</div>
                                    <div class="section-label">Yesterday</div><p>${u.yesterday || 'N/A'}</p>
                                    <div class="section-label">Today</div><p>${u.today || 'N/A'}</p>
                                    ${u.has_blocker ? '<span class="tag" style="background:#fee2e2;color:#991b1b">Blocker</span>' : ''}
                                </div>
                            `).join('')}
                        ` : ''}
                        ${data.blockers_report.blockers?.length ? `
                            <h3>Blockers</h3>
                            ${data.blockers_report.blockers.map(b => `
                                <div class="card impact-${(b.impact||'medium').toLowerCase()}">
                                    <div class="card-id">${b.id} - ${b.owner}</div>
                                    <p>${b.description}</p>
                                    <span class="tag">${b.impact} Impact</span>
                                    ${b.blocked_task !== 'unspecified' ? `<span class="tag">${b.blocked_task}</span>` : ''}
                                    ${b.suggested_resolution ? `<p><strong>Resolution:</strong> ${b.suggested_resolution}</p>` : ''}
                                </div>
                            `).join('')}
                        ` : '<p>No blockers reported.</p>'}
                        ${data.blockers_report.action_items?.length ? `
                            <h3>Action Items</h3>
                            <pre>${JSON.stringify(data.blockers_report.action_items, null, 2)}</pre>
                        ` : ''}
                    ` : ''}

                    ${data.retro_analysis ? `
                        <h2>Retrospective Analysis</h2>
                        ${data.retro_analysis.went_well?.length ? `
                            <h3>What Went Well</h3>
                            ${data.retro_analysis.went_well.map(w => `
                                <div class="card urgency-low">
                                    <div class="card-id">${w.id} - ${w.category}</div>
                                    <p>${w.description}</p>
                                </div>
                            `).join('')}
                        ` : ''}
                        ${data.retro_analysis.didnt_go_well?.length ? `
                            <h3>What Did Not Go Well</h3>
                            ${data.retro_analysis.didnt_go_well.map(d => `
                                <div class="card urgency-high">
                                    <div class="card-id">${d.id} - ${d.category}</div>
                                    <p>${d.description}</p>
                                    ${d.root_cause ? `<p><strong>Root Cause:</strong> ${d.root_cause}</p>` : ''}
                                </div>
                            `).join('')}
                        ` : ''}
                        ${data.retro_analysis.action_items?.length ? `
                            <h3>Improvement Action Items</h3>
                            ${data.retro_analysis.action_items.map(a => `
                                <div class="card priority-${(a.priority||'medium').toLowerCase()}">
                                    <div class="card-id">${a.id}</div>
                                    <p>${a.description}</p>
                                    <span class="tag">${a.owner}</span>
                                    <span class="tag">${a.priority}</span>
                                    <span class="tag">${a.timeline}</span>
                                </div>
                            `).join('')}
                        ` : ''}
                        ${data.retro_analysis.team_health ? `
                            <h3>Team Health</h3>
                            <div class="card">
                                <p><strong>Sentiment:</strong> ${data.retro_analysis.team_health.overall_sentiment}</p>
                                ${data.retro_analysis.team_health.morale_notes ? `<p>${data.retro_analysis.team_health.morale_notes}</p>` : ''}
                                ${data.retro_analysis.team_health.kudos?.length ? `
                                    <div class="section-label">Kudos</div>
                                    <ul>${data.retro_analysis.team_health.kudos.map(k => `<li>${k}</li>`).join('')}</ul>
                                ` : ''}
                            </div>
                        ` : ''}
                    ` : ''}
                </body>
                </html>
            `);
        }
    } catch (error) {
        alert('Failed to load results: ' + error.message);
    }
}

function closePipelineModal() {
    document.getElementById('pipelineModal').style.display = 'none';
    // Reset progress bar colour so it's clean next time
    const fill = document.getElementById('pipeProgressFill');
    if (fill) fill.style.background = '';
    // Cancel the "still working" hint if it hasn't fired yet
    if (window._pipeSlowHintTimer) { clearTimeout(window._pipeSlowHintTimer); window._pipeSlowHintTimer = null; }
    if (pipelinePollingInterval) {
        clearInterval(pipelinePollingInterval);
        pipelinePollingInterval = null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;
    if (page === 'session') {
        new MeetingSession();
    } else if (page === 'launcher') {
        new MeetingLauncher();
    }
});