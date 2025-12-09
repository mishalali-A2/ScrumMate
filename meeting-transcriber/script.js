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
        const selectedMeetingTypes = [];
        if (document.getElementById('retrospective').checked) selectedMeetingTypes.push('retrospective');
        if (document.getElementById('dailyStandup').checked) selectedMeetingTypes.push('daily-standup');
        if (document.getElementById('productOwner').checked) selectedMeetingTypes.push('product-owner');

        console.log("Selected meeting types:", selectedMeetingTypes);

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
            <div style="display: flex; flex-direction: column; gap: 10px; padding: 10px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-check-circle" style="font-size: 24px;"></i>
                    <div>
                        <strong style="font-size: 16px;">Transcript Saved!</strong>
                        <div style="font-size: 12px; opacity: 0.9;">Bot has left the meeting</div>
                    </div>
                </div>
                
                <div style="background: rgba(255,255,255,0.2); padding: 12px; border-radius: 8px; font-size: 13px;">
                    <div style="margin-bottom: 5px;">📊 ${statistics.total_speakers} speakers • ${statistics.total_words} words</div>
                    <div style="margin-bottom: 5px;">⏱️ Duration: ${Math.floor(statistics.duration / 60)}m ${statistics.duration % 60}s</div>
                    <div>📝 ${statistics.total_entries} transcript entries</div>
                </div>
                
                <a href="/api/download/${filename}" 
                   download="${filename}"
                   style="background: white; color: #10b981; padding: 10px 20px; border-radius: 8px; 
                          text-decoration: none; text-align: center; font-weight: bold; display: block;
                          transition: all 0.2s;">
                    <i class="fas fa-download"></i> Download JSON File
                </a>
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
        
        // Add animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -60%);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%);
                }
            }
            .notification.large a:hover {
                background: #f0fdf4 !important;
                transform: scale(1.02);
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(notification);
        
        // Auto-dismiss after 10 seconds
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-in';
            setTimeout(() => notification.remove(), 300);
        }, 10000);
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MeetingTranscriber();
});