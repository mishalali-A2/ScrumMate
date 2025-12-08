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
        
        if (!meetingUrl) {
            alert('Please enter a Google Meet URL');
            return;
        }
        
        if (!meetingUrl.includes('meet.google.com')) {
            alert('Please enter a valid Google Meet URL (should contain meet.google.com)');
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
                this.updateStatus('Error: ' + (data.error?.detail || 'Unknown error'), 'error');
            }
        } catch (error) {
            this.updateStatus('Connection error: ' + error.message, 'error');
        }
    }
    
    async stopTranscription() {
        if (!this.currentBotId) return;
        
        this.updateStatus('Stopping transcription...', 'processing');
        
        try {
            const response = await fetch(`/api/bot/${this.currentBotId}`, {
                method: 'DELETE'
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.updateStatus('Transcription stopped', 'idle');
                this.clearTranscript();
                
                // Disable stop button
                document.getElementById('stopBtn').disabled = true;
                document.getElementById('startBtn').disabled = false;
                
                // Stop polling
                this.stopPolling();
                this.hideBotInfo();
            }
        } catch (error) {
            this.updateStatus('Error stopping transcription', 'error');
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
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MeetingTranscriber();
});