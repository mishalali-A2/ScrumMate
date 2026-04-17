class MeetingTranscriber {
    constructor() {
        this.currentBotId = null;
        this.pollingInterval = null;
        this.updateInterval = 3000; // Poll every 3 seconds
        
        this.bindEvents();
        this.checkServer();
    }
    
    bindEvents() {
        document.getElementById('startBtn').addEventListener('click', () => this.startTranscription());
        document.getElementById('stopBtn').addEventListener('click', () => this.stopTranscription());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearTranscript());
        document.getElementById('copyBtn').addEventListener('click', () => this.copyTranscript());
    }
    
    async checkServer() {
        try {
            const response = await fetch('/api/bots');
            if (response.ok) {
                this.updateStatus('Server connected', 'success');
            }
        } catch (error) {
            this.updateStatus('Server not responding', 'error');
        }
    }
    
    async startTranscription() {
        const meetingUrl = document.getElementById('meetingUrl').value.trim();

        // Capture selected meeting type for pipeline use later
        if (document.getElementById('retrospective').checked) selectedMeetingType = 'retrospective';
        else if (document.getElementById('dailyStandup').checked) selectedMeetingType = 'daily-standup';
        else selectedMeetingType = 'product-owner';

        console.log("Meeting type:", selectedMeetingType);

        if (!meetingUrl) {
            alert('Please enter a Google Meet URL');
            return;
        }
        
        if (!meetingUrl.includes('meet.google.com')) {
            alert('Please enter a valid Google Meet URL');
            return;
        }
        
        this.updateStatus('Creating bot and joining meeting...', 'processing');
        
        try {
            const response = await fetch('/api/create-bot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meetingUrl })
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentBotId = data.botId;
                this.updateStatus(data.message, 'success');
                this.showBotInfo(data.botId);
                
                // Enable stop button
                document.getElementById('stopBtn').disabled = false;
                document.getElementById('startBtn').disabled = true;
                
                // Start polling for updates
                this.startPolling();
            } else {
                this.updateStatus('Error: ' + (data.error?.detail || data.error || 'Unknown error'), 'error');
            }
        } catch (error) {
            this.updateStatus('Connection error: ' + error.message, 'error');
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
                document.getElementById('stopBtn').disabled = true;
                document.getElementById('startBtn').disabled = false;
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
                // Update status
                document.getElementById('botStatus').textContent = data.bot.status;
                
                // Update transcript if available
                if (data.hasTranscript && data.transcript.length > 0) {
                    this.displayTranscript(data.transcript);
                } else {
                    // Show waiting message
                    const transcriptContainer = document.getElementById('transcript');
                    transcriptContainer.innerHTML = `
                        <div class="empty-state">
                            <i class="fas fa-microphone-alt"></i>
                            <p>Listening... Bot status: ${data.bot.status}</p>
                            <p>Transcript will appear when speech is detected</p>
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
                <div class="empty-state">
                    <i class="fas fa-microphone-alt-slash"></i>
                    <p>No speech detected yet. The bot is listening...</p>
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
                        <i class="fas fa-user"></i>
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
                <div class="empty-state">
                    <i class="fas fa-file-alt"></i>
                    <p>No transcript data available</p>
                </div>
            `;
            return;
        }
        
        // Create a beautiful final transcript view
        let transcriptHTML = `
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                <h2 style="margin: 0 0 10px 0; display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-check-circle"></i>
                    Meeting Transcript Complete
                </h2>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top: 15px;">
                    <div>
                        <div style="opacity: 0.9; font-size: 12px;">Speakers</div>
                        <div style="font-size: 24px; font-weight: bold;">${statistics.total_speakers}</div>
                    </div>
                    <div>
                        <div style="opacity: 0.9; font-size: 12px;">Words</div>
                        <div style="font-size: 24px; font-weight: bold;">${statistics.total_words}</div>
                    </div>
                    <div>
                        <div style="opacity: 0.9; font-size: 12px;">Entries</div>
                        <div style="font-size: 24px; font-weight: bold;">${statistics.total_entries}</div>
                    </div>
                    <div>
                        <div style="opacity: 0.9; font-size: 12px;">Duration</div>
                        <div style="font-size: 24px; font-weight: bold;">${Math.floor(statistics.duration / 60)}m ${statistics.duration % 60}s</div>
                    </div>
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
                        <i class="fas fa-user-circle"></i>
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
        document.getElementById('speakerCount').textContent = speakerCount;
        document.getElementById('wordCount').textContent = wordCount;
    }
    
    updateLastUpdate() {
        const now = new Date();
        document.getElementById('lastUpdate').textContent = 
            now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    
    clearTranscript() {
        const transcriptContainer = document.getElementById('transcript');
        transcriptContainer.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-microphone-alt"></i>
                <p>Transcript cleared. Ready for new transcription.</p>
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
        statusElement.textContent = message;
        statusElement.className = `status ${type}`;
        
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
        document.getElementById('botId').textContent = botId.substring(0, 8) + '...';
        document.getElementById('botStatus').textContent = 'joining';
        document.getElementById('botInfo').style.display = 'block';
    }
    
    hideBotInfo() {
        document.getElementById('botInfo').style.display = 'none';
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
    
    // Show modal
    const modal = document.getElementById('pipelineModal');
    modal.style.display = 'flex';
    
    // Reset status
    document.querySelectorAll('.pipeline-step').forEach(step => {
        step.classList.remove('active', 'completed', 'error');
    });
    document.getElementById('pipelineResult').style.display = 'none';
    document.getElementById('pipelineError').style.display = 'none';
    
    // Mark first step as active
    document.querySelector('[data-step="chunking"]').classList.add('active');
    
    try {
        const response = await fetch('/api/pipeline/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcriptFile: filename, meetingType: selectedMeetingType })
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
    
    pipelinePollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/pipeline/status/${meetingId}`);
            const data = await response.json();
            
            if (!response.ok || (!data.success && data.error)) {
                clearInterval(pipelinePollingInterval);
                const errMsg = data?.error || 'Request failed';
                showPipelineError(
                    errMsg.includes('stream') || errMsg.includes('aborted')
                        ? 'Connection interrupted. The pipeline may have completed. Click "Try View Results" below.'
                        : errMsg,
                    null,
                    meetingId
                );
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
            console.error('Pipeline polling error:', error);
            clearInterval(pipelinePollingInterval);
            showPipelineError(
                'Cannot reach the agentic API. Is it running on port 8000? ' + error.message,
                null,
                meetingId
            );
        }
    }, 2000);
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

    // Header: swap to checkmark icon
    const iconWrap = document.getElementById('pipeIconWrap');
    if (iconWrap) iconWrap.className = 'pipe-icon-wrap done';
    const icon = document.getElementById('pipeHeadIcon');
    if (icon) icon.className = 'fas fa-check-circle';
    const sub = document.getElementById('pipeSubtitle');
    if (sub) sub.textContent = 'All outputs are ready.';

    // Hide live-status text
    document.getElementById('pipelineStatus').textContent = '';

    // Build stats: type-aware label for stories/blockers
    const typeIsStandup = selectedMeetingType === 'daily-standup';
    const storyStat = typeIsStandup
        ? { num: result?.blockers_count ?? 0, label: 'Blockers identified' }
        : { num: result?.stories_count   ?? 0, label: 'User stories' };

    const resultDiv = document.getElementById('pipelineResult');
    resultDiv.innerHTML = `
        <div class="pipe-result-card">
            <div class="pipe-result-title">
                <i class="fas fa-check-circle"></i> Analysis complete
            </div>
            <div class="pipe-stats">
                <div class="pipe-stat">
                    <div class="pipe-stat-num">${result?.chunks_count ?? '—'}</div>
                    <div class="pipe-stat-label">Transcript chunks</div>
                </div>
                <div class="pipe-stat">
                    <div class="pipe-stat-num">${storyStat.num}</div>
                    <div class="pipe-stat-label">${storyStat.label}</div>
                </div>
            </div>
            <div class="pipe-result-actions">
                <a href="meetings.html" class="pipe-btn pipe-btn-primary">
                    <i class="fas fa-history"></i> View in Past Meetings
                </a>
                <button onclick="closePipelineModal()" class="pipe-btn pipe-btn-ghost">
                    Close
                </button>
            </div>
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
    if (pipelinePollingInterval) {
        clearInterval(pipelinePollingInterval);
        pipelinePollingInterval = null;
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MeetingTranscriber();
});