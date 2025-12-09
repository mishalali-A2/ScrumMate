const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_API_URL = 'https://us-west-2.recall.ai/api/v1';

console.log('Starting Meeting Transcriber...');
console.log(`Using US West 2 region`);
console.log(`API Key: ${RECALL_API_KEY ? 'Set' : 'Missing!'}`);

// Store active bots and their transcripts
const activeBots = new Map();

// === HEALTH CHECK ===
app.get('/api/health', async (req, res) => {
    try {
        const response = await axios.get(`${RECALL_API_URL}/bot/`, {
            headers: { 'Authorization': `Token ${RECALL_API_KEY}` },
            params: { limit: 1 }
        });
        
        res.json({
            status: 'healthy',
            region: 'us-west-2',
            recallStatus: response.status,
            message: 'Ready to transcribe meetings!'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.response?.data?.detail || error.message
        });
    }
});

// === CREATE BOT WITH REAL-TIME TRANSCRIPTION ===
app.post('/api/create-bot', async (req, res) => {
    try {
        const { meetingUrl } = req.body;
        
        if (!meetingUrl || !meetingUrl.includes('meet.google.com')) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid Google Meet URL'
            });
        }
        
        console.log(`🤖 Creating bot for: ${meetingUrl}`);
        
        // bot with real-time transcription
        const response = await axios.post(
            `${RECALL_API_URL}/bot/`,
            {
                meeting_url: meetingUrl,
                bot_name: "ScrumMate-Bot",
                recording_config: {
                    transcript: {
                        provider: {
                            meeting_captions: {}  
                        }
                    },
                    realtime_endpoints: [
                        {
                            type: "webhook",
                            url: ` https://subsonic-mafalda-unawake.ngrok-free.dev/webhook/transcription`,
                            events: ["transcript.data", "transcript.partial_data"]
                        }
                    ]
                },
                automatic_leave: {
                    waiting_room_timeout: 600,
                    noone_joined_timeout: 600
                }
            },
            {
                headers: {
                    'Authorization': `Token ${RECALL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );
        
        const botId = response.data.id;
        
        // init bot data
        activeBots.set(botId, {
            botId,
            meetingUrl,
            status: response.data.status_changes?.[0]?.code || 'created',
            createdAt: new Date(),
            transcript: [],
            lastUpdate: new Date()
        });
        
        console.log(`✅ Bot created: ${botId}`);
        console.log(`Status: ${response.data.status_changes?.[0]?.code || 'unknown'}`);
        
        res.json({
            success: true,
            botId,
            status: response.data.status_changes?.[0]?.code || 'created',
            message: 'Bot created! Joining meeting with real-time transcription...'
        });
        
    } catch (error) {
        console.error('❌ Bot creation failed:', {
            status: error.response?.status,
            error: error.response?.data
        });
        
        const errorData = error.response?.data || {};
        
        res.status(error.response?.status || 500).json({
            success: false,
            error: errorData.detail || error.message,
            code: errorData.code,
            suggestion: 'Check your meeting URL and API key. (ngrok)'
        });
    }
});

// === WEBHOOK FOR REAL-TIME TRANSCRIPTION ===
app.post('/webhook/transcription', (req, res) => {
    try {
        const data = req.body;
        
        console.log('Webhook received:', JSON.stringify(data, null, 2));
        
        // trans events
        if (data.event === 'transcript.data' || data.event === 'transcript.partial_data') {
            const botId = data.data.bot?.id;
            
            if (botId && activeBots.has(botId)) {
                const botInfo = activeBots.get(botId);
                
                // Extract transcript info
                const words = data.data.data?.words || [];
                const text = words.map(w => w.text).join(' ');
                const participant = data.data.data?.participant;
                
                //only save final full transcript
                if (text && data.event === 'transcript.data') {  
                    botInfo.transcript.push({
                        speaker: participant?.name || `Speaker ${participant?.id || 'Unknown'}`,
                        text: text,
                        timestamp: new Date().toISOString(),
                        is_final: true
                    });
                    
                    botInfo.lastUpdate = new Date();
                    
                    console.log(`Transcript for ${botId}: [${participant?.name}] "${text}"`);
                }
            }
        } else if (data.event === 'bot.status_change') {
            const botId = data.data.bot?.id;
            if (botId && activeBots.has(botId)) {
                const status = data.data.status?.code || 'unknown';
                activeBots.get(botId).status = status;
                console.log(`Bot ${botId} status: ${status}`);
            }
        }
        
        res.status(200).json({ received: true });
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// === BOT STATUS & TRANSCRIPT ===
app.get('/api/bot/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        
        const botResponse = await axios.get(
            `${RECALL_API_URL}/bot/${botId}/`,
            {
                headers: { 'Authorization': `Token ${RECALL_API_KEY}` }
            }
        );
        
        // stored transcript from memory -> webhook
        let transcript = [];
        if (activeBots.has(botId)) {
            transcript = activeBots.get(botId).transcript || [];
        }
        
        // api transcript extract
        if (transcript.length === 0) {
            try {
                const transcriptResponse = await axios.get(
                    `${RECALL_API_URL}/bot/${botId}/transcript/`,
                    {
                        headers: { 'Authorization': `Token ${RECALL_API_KEY}` }
                    }
                );
                
                if (transcriptResponse.data.transcript) {
                    transcript = transcriptResponse.data.transcript.map(item => ({
                        speaker: item.speaker || 'Unknown Speaker',
                        text: item.words?.map(w => w.text).join(' ') || '',
                        timestamp: item.timestamp
                    }));
                }
            } catch (transcriptError) {
                console.log(`No transcript yet for ${botId}`);
            }
        }
        
        res.json({
            success: true,
            bot: {
                id: botResponse.data.id,
                status: botResponse.data.status_changes?.[0]?.code || 'unknown',
                meeting_url: botResponse.data.meeting_url,
                created_at: botResponse.data.created_at
            },
            transcript: transcript,
            hasTranscript: transcript.length > 0
        });
        
    } catch (error) {
        console.error(` Error getting bot ${req.params.botId}:`, error.message);
        
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// === LIST ALL BOTS ===
app.get('/api/bots', (req, res) => {
    res.json({
        success: true,
        count: activeBots.size,
        bots: Array.from(activeBots.values()).map(bot => ({
            id: bot.botId,
            meetingUrl: bot.meetingUrl,
            status: bot.status,
            createdAt: bot.createdAt,
            transcriptLength: bot.transcript?.length || 0
        }))
    });
});

// === DELETE BOT & GENERATE TRANSCRIPT FILE ===
app.delete('/api/bot/:botId', async (req, res) => {
    try {
        const { botId } = req.params;
        
        console.log(`🛑 Stopping bot: ${botId}`);
        
        // Get final transcript before deleting
        let finalTranscript = [];
        if (activeBots.has(botId)) {
            finalTranscript = activeBots.get(botId).transcript || [];
        }
        
        //  API fetch -> backup
        try {
            const transcriptResponse = await axios.get(
                `${RECALL_API_URL}/bot/${botId}/transcript/`,
                {
                    headers: { 'Authorization': `Token ${RECALL_API_KEY}` }
                }
            );
            
            if (transcriptResponse.data.transcript && transcriptResponse.data.transcript.length > 0) {
                finalTranscript = transcriptResponse.data.transcript.map(item => ({
                    speaker: item.speaker || 'Unknown Speaker',
                    text: item.words?.map(w => w.text).join(' ') || '',
                    timestamp: item.timestamp,
                    words: item.words
                }));
            }
        } catch (transcriptError) {
            console.log(`Using in-memory transcript`);
        }
        
        // JSON file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `transcript-${botId.substring(0, 8)}-${timestamp}.json`;
        const filepath = path.join(__dirname, 'transcripts', filename);
        
        // transcripts directory 
        const transcriptsDir = path.join(__dirname, 'transcripts');
        if (!fs.existsSync(transcriptsDir)) {
            fs.mkdirSync(transcriptsDir);
        }
        
        // Create transcript data
        const transcriptData = {
            bot_id: botId,
            meeting_url: activeBots.get(botId)?.meetingUrl || 'Unknown',
            created_at: activeBots.get(botId)?.createdAt || new Date(),
            stopped_at: new Date(),
            transcript: finalTranscript,
            statistics: {
                total_speakers: new Set(finalTranscript.map(t => t.speaker)).size,
                total_words: finalTranscript.reduce((sum, t) => sum + (t.text?.split(' ').length || 0), 0),
                total_entries: finalTranscript.length,
                duration: activeBots.get(botId) ? 
                    Math.round((new Date() - new Date(activeBots.get(botId).createdAt)) / 1000) : 0
            }
        };
        
        // Write JSON file
        fs.writeFileSync(filepath, JSON.stringify(transcriptData, null, 2));
        console.log(`💾 Transcript saved: ${filename}`);
        
        //use leave_call 
        try {
            await axios.post(
                `${RECALL_API_URL}/bot/${botId}/leave_call/`,
                {},
                {
                    headers: { 'Authorization': `Token ${RECALL_API_KEY}` }
                }
            );
            console.log(`✅ Bot successfully left the meeting: ${botId}`);
        } catch (leaveError) {
            console.log(`⚠️ leave_call failed, trying DELETE: ${leaveError.response?.status}`);
            
            try {
                await axios.delete(
                    `${RECALL_API_URL}/bot/${botId}/`,
                    {
                        headers: { 'Authorization': `Token ${RECALL_API_KEY}` }
                    }
                );
                console.log(`✅ Bot deleted (was not in call): ${botId}`);
            } catch (deleteError) {
                console.error(`❌ Could not remove bot:`, deleteError.response?.data);
            }
        }
        
        // rmv from active bots
        activeBots.delete(botId);
        console.log(` Bot left meeting: ${botId}`);
        
        res.json({
            success: true,
            message: 'Bot stopped and left meeting successfully',
            transcript_file: filename,
            transcript_path: filepath,
            statistics: transcriptData.statistics
        });
        
    } catch (error) {
        console.error(' Error stopping bot:', error);
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// === DOWNLOAD TRANSCRIPT FILE ===
app.get('/api/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filepath = path.join(__dirname, 'transcripts', filename);
        
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({
                success: false,
                error: 'Transcript file not found'
            });
        }
        
        res.download(filepath, filename);
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(` Health check: http://localhost:${PORT}/api/health`);
    console.log(`🎯 Ready!`);
    console.log('');
    console.log('   For local testing, use ngrok: npx ngrok http 3000');
    console.log('   Then update destination_url in the code with your ngrok URL');
    console.log('============================================');
});