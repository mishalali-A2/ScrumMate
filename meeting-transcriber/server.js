const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

// --- PostgreSQL connection (same creds as database/.env) ---
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/ScrumMate',
});

const app = express();
app.use(cors());
app.use(express.json());
// Serve static assets but do not automatically serve index files
app.use(express.static('.', { index: false }));

// Default route: show Clerk-powered login/signup landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'landing.html'));
});

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_API_URL = 'https://us-west-2.recall.ai/api/v1';
const AGENTIC_API_URL = process.env.AGENTIC_API_URL || 'http://localhost:8000';
const TRELLO_KEY   = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_API   = 'https://api.trello.com/1';

console.log('Starting Meeting Transcriber...');
console.log(`Using US West 2 region`);
console.log(`API Key: ${RECALL_API_KEY ? 'Set' : 'Missing!'}`);
console.log(`Agentic API: ${AGENTIC_API_URL}`);
console.log(`Trello: ${TRELLO_KEY && TRELLO_TOKEN ? 'Configured' : 'Not configured'}`);

// === TRELLO HELPER FUNCTIONS ===
function isDoneListName(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return false;
    if (/^(done|complete|completed|closed|released|live)$/i.test(n)) return true;
    return /\b(done|completed)\b/i.test(n);
}

function isBlockedListName(name) {
    return /\b(blocked|stuck|on hold|hold)\b/i.test(name || '');
}

async function trelloGet(resourcePath, query = {}) {
    const { data } = await axios.get(`${TRELLO_API}${resourcePath}`, {
        params: { key: TRELLO_KEY, token: TRELLO_TOKEN, ...query },
        timeout: 25000
    });
    return data;
}

function buildDayEndTimestamps(windowDays) {
    const dayEnds = [];
    for (let i = 0; i <= windowDays; i++) {
        const d = new Date();
        d.setHours(23, 59, 59, 999);
        d.setDate(d.getDate() - (windowDays - i));
        dayEnds.push(d.getTime());
    }
    return dayEnds;
}

async function loadSingleBoardAnalytics(boardId, windowStart, WINDOW_DAYS, dayEnds) {
    const lists = await trelloGet(`/boards/${boardId}/lists`, { fields: 'id,name,closed' });
    const openLists = (lists || []).filter(l => !l.closed);
    const doneListIds    = new Set(openLists.filter(l => isDoneListName(l.name)).map(l => l.id));
    const blockedListIds = new Set(openLists.filter(l => isBlockedListName(l.name)).map(l => l.id));

    const cards = await trelloGet(`/boards/${boardId}/cards`, {
        filter: 'visible', fields: 'id,idList,closed,dateLastActivity,name'
    });

    const isDoneCard = c => Boolean(c.closed) || doneListIds.has(c.idList);
    const total   = cards.length;
    const done    = cards.filter(isDoneCard).length;
    const open    = total - done;
    const blocked = cards.filter(c => !isDoneCard(c) && blockedListIds.has(c.idList)).length;

    const firstDoneDateByCard = new Map();
    let before;
    for (let page = 0; page < 30; page++) {
        const params = { filter: 'updateCard:idList', limit: 1000 };
        if (before) params.before = before;
        const actions = await trelloGet(`/boards/${boardId}/actions`, params);
        if (!actions.length) break;
        for (const a of actions) {
            const listAfter = a.data?.listAfter;
            const cardId = a.data?.card?.id;
            if (!cardId || !listAfter || !doneListIds.has(listAfter.id)) continue;
            const t = new Date(a.date).getTime();
            const prev = firstDoneDateByCard.get(cardId);
            if (prev == null || t < prev) firstDoneDateByCard.set(cardId, t);
        }
        const oldest = actions[actions.length - 1];
        before = oldest.id;
        if (new Date(oldest.date).getTime() < windowStart && page > 2) break;
        if (actions.length < 1000) break;
    }

    for (const c of cards) {
        if (!isDoneCard(c)) continue;
        if (firstDoneDateByCard.has(c.id)) continue;
        const t = new Date(c.dateLastActivity).getTime();
        if (!Number.isNaN(t)) firstDoneDateByCard.set(c.id, t);
    }

    let completedInWindow = 0;
    firstDoneDateByCard.forEach(t => { if (t >= windowStart) completedInWindow += 1; });

    const initialScope = open + completedInWindow;
    const burndown = dayEnds.map((endTs, i) => {
        let cum = 0;
        firstDoneDateByCard.forEach(t => { if (t <= endTs && t >= windowStart) cum += 1; });
        const actualRemaining = Math.max(0, initialScope - cum);
        const idealRemaining  = initialScope > 0 ? Math.max(0, Math.round(initialScope * (1 - i / WINDOW_DAYS))) : 0;
        return { date: new Date(endTs).toISOString().slice(0, 10), actualRemaining, idealRemaining };
    });

    return {
        boardId,
        totals: { cards: total, done, open, blocked },
        burndown,
        doneListNames: openLists.filter(l => doneListIds.has(l.id)).map(l => l.name)
    };
}

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
        const { meetingUrl, meetingType } = req.body;
        
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
                            url: `https://subsonic-mafalda-unawake.ngrok-free.dev/webhook/transcription`,
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
        
        const initChanges = response.data.status_changes || [];
        const initStatus  = initChanges[initChanges.length - 1]?.code || 'created';

        // init bot data
        activeBots.set(botId, {
            botId,
            meetingUrl,
            meetingType: meetingType || 'product-owner',
            status: initStatus,
            createdAt: new Date(),
            transcript: [],
            lastUpdate: new Date()
        });
        
        console.log(`✅ Bot created: ${botId}`);
        console.log(`Status: ${initStatus}`);
        
        res.json({
            success: true,
            botId,
            status: initStatus,
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
                    { headers: { 'Authorization': `Token ${RECALL_API_KEY}` } }
                );

                const raw = transcriptResponse.data;

                // Recall returns either an array directly, or {transcript: [...]}
                const items = Array.isArray(raw) ? raw
                            : Array.isArray(raw?.transcript) ? raw.transcript
                            : [];

                if (items.length > 0) {
                    console.log(`📝 Transcript live for ${botId} (${items.length} segments)`);
                    transcript = items.map(item => ({
                        speaker: item.speaker || 'Unknown Speaker',
                        text: item.words?.map(w => w.text).join(' ') || item.text || '',
                        timestamp: item.start_timestamp ?? item.timestamp
                    }));
                } else {
                    console.log(`No transcript yet for ${botId}`);
                }
            } catch (transcriptError) {
                console.log(`No transcript yet for ${botId}`);
            }
        }

        // Recall status: try status_changes array (newest-last), else top-level status field
        const statusChanges = botResponse.data.status_changes || [];
        const currentStatus = statusChanges[statusChanges.length - 1]?.code
                           || botResponse.data.status
                           || 'unknown';

        // One-time debug log so we can see the Recall response shape
        if (currentStatus === 'unknown' && statusChanges.length === 0) {
            console.log(`[debug] bot ${botId} raw keys:`, Object.keys(botResponse.data));
        }

        res.json({
            success: true,
            bot: {
                id: botResponse.data.id,
                status: currentStatus,
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
        const botInfo = activeBots.get(botId);
        const transcriptData = {
            bot_id: botId,
            meeting_url: botInfo?.meetingUrl || 'Unknown',
            meeting_type: botInfo?.meetingType || 'product-owner',
            created_at: botInfo?.createdAt || new Date(),
            stopped_at: new Date(),
            transcript: finalTranscript,
            statistics: {
                total_speakers: new Set(finalTranscript.map(t => t.speaker)).size,
                total_words: finalTranscript.reduce((sum, t) => sum + (t.text?.split(' ').length || 0), 0),
                total_entries: finalTranscript.length,
                duration: botInfo ?
                    Math.round((new Date() - new Date(botInfo.createdAt)) / 1000) : 0
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

// === AGENTIC PIPELINE ENDPOINTS ===

// Trigger the agentic pipeline on a transcript
app.post('/api/pipeline/run', async (req, res) => {
    try {
        const { transcriptFile, projectId, projectName } = req.body;

        if (!transcriptFile) {
            return res.status(400).json({ success: false, error: 'transcriptFile is required' });
        }

        const filepath = path.join(__dirname, 'transcripts', transcriptFile);
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, error: 'Transcript file not found' });
        }

        const transcriptData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        const meetingType = req.body.meetingType || 'product-owner';

        // Derive the meeting_id the same way the agentic API does:
        // api.py uses bot_id[:12] — must match exactly or polling will 404.
        const botId = transcriptData.bot_id || '';
        const meeting_id = botId.substring(0, 12) || transcriptData.meeting_id || transcriptFile.replace(/\.json$/, '');

        // Inject project info into transcript_data so the agentic pipeline
        // can write the real project_name into _minutes.json without guessing.
        const googleMeetId = transcriptData.meeting_url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] || meeting_id;
        if (projectName) transcriptData.project_name = projectName;
        if (projectId)   transcriptData.project_id   = parseInt(projectId, 10) || null;

        // Upsert a row in the meetings table so we track which project this belongs to.
        try {
            const pid = projectId ? (parseInt(projectId, 10) || null) : null;
            await pgPool.query(
                `INSERT INTO meetings (google_meet_id, transcript_path, project_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (google_meet_id) DO UPDATE
                   SET transcript_path = EXCLUDED.transcript_path,
                       project_id      = COALESCE(EXCLUDED.project_id, meetings.project_id)`,
                [googleMeetId, filepath, pid]
            );
            console.log(`📋 meetings row upserted for ${googleMeetId} (project_id: ${pid})`);
        } catch (dbErr) {
            // Non-fatal — pipeline still runs; log and continue.
            console.warn(`⚠️  meetings DB upsert failed: ${dbErr.message}`);
        }

        // Fire the pipeline request WITHOUT awaiting it — the agentic API runs
        // the pipeline asynchronously and the old 10-second timeout was killing
        // the connection before it could return, causing "stream has been aborted".
        axios.post(
            `${AGENTIC_API_URL}/pipeline/run`,
            { transcript_data: transcriptData, meeting_type: meetingType, skip_assignment: false },
            // 60 min upper bound — local Ollama can be slow, and this is fire-and-forget anyway.
            { headers: { 'Content-Type': 'application/json' }, timeout: 3600000 }
        ).then(r => {
            console.log(`✅ Pipeline complete for ${meeting_id} (agentic id: ${r.data?.meeting_id})`);
        }).catch(err => {
            console.error(`❌ Pipeline error for ${meeting_id}:`, err.message);
        });

        // Respond immediately so the frontend can start polling for status.
        console.log(`🚀 Pipeline started for ${meeting_id} (${meetingType})`);
        res.json({ success: true, meeting_id, message: 'Pipeline started — polling for status.' });

    } catch (error) {
        console.error('Pipeline trigger error:', error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message,
            suggestion: 'Make sure the agentic API server is running on port 8000'
        });
    }
});

// Get pipeline status
app.get('/api/pipeline/status/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        const response = await axios.get(
            `${AGENTIC_API_URL}/pipeline/status/${meetingId}`,
            { timeout: 60000 }
        );
        
        res.json({
            success: true,
            ...response.data
        });
        
    } catch (error) {
        if (error.response?.status === 404) {
            return res.status(404).json({
                success: false,
                error: 'Pipeline not found for this meeting'
            });
        }
        
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// Get pipeline results
app.get('/api/pipeline/results/:meetingId', async (req, res) => {
    try {
        const { meetingId } = req.params;
        
        const response = await axios.get(
            `${AGENTIC_API_URL}/pipeline/results/${meetingId}`,
            { timeout: 60000 }
        );
        
        res.json({
            success: true,
            ...response.data
        });
        
    } catch (error) {
        if (error.response?.status === 404) {
            return res.status(404).json({
                success: false,
                error: 'No results found for this meeting'
            });
        }
        
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// === RAG QUERY ENDPOINT ===
app.post('/api/rag/query', async (req, res) => {
    try {
        const { question, meeting_id } = req.body;
        
        if (!question) {
            return res.status(400).json({
                success: false,
                error: 'question is required'
            });
        }
        
        const response = await axios.post(
            `${AGENTIC_API_URL}/rag/query`,
            { question, meeting_id },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            }
        );
        
        res.json({
            success: true,
            ...response.data
        });
        
    } catch (error) {
        console.error('RAG query error:', error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// Get RAG stats
app.get('/api/rag/stats', async (req, res) => {
    try {
        const response = await axios.get(
            `${AGENTIC_API_URL}/rag/stats`,
            { timeout: 5000 }
        );
        
        res.json({
            success: true,
            ...response.data
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.response?.data?.detail || error.message
        });
    }
});

// === PROFILE SYNC / ONBOARDING ===

// POST /api/profiles/sync
// Called immediately after Clerk auth. Checks if a profile row exists for the
// email. If yes, returns it. If no, returns needsOnboarding: true so the
// frontend shows the onboarding form.
// Body: { email, name }
app.post('/api/profiles/sync', async (req, res) => {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email required' });
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: 'Invalid email format' });

    try {
        const r = await pgPool.query(
            `SELECT id, name, email, role, experience_years, skills, strengths FROM profile WHERE email = $1`,
            [email.toLowerCase()]
        );
        if (r.rows.length) {
            const p = r.rows[0];
            // Check if key fields are missing / empty
            const skillsEmpty    = !p.skills    || (Array.isArray(p.skills)    && p.skills.length    === 0);
            const strengthsEmpty = !p.strengths || (Array.isArray(p.strengths) && p.strengths.length === 0);
            const incomplete = !p.role || skillsEmpty || strengthsEmpty;
            if (incomplete) {
                return res.json({
                    success: true,
                    needsOnboarding: true,
                    partial: true,          // tells frontend to pre-fill what we have
                    profile: p,
                    suggestedName: p.name || name || '',
                });
            }
            return res.json({ success: true, needsOnboarding: false, profile: p });
        }
        // Profile doesn't exist yet
        res.json({ success: true, needsOnboarding: true, partial: false, suggestedName: name || '' });
    } catch (err) {
        console.error('DB error /api/profiles/sync:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/profiles
// Creates a new profile after onboarding.
// Body: { name, email, role, experience_years, skills[], strengths[] }
app.post('/api/profiles', async (req, res) => {
    const { name, email, role, experience_years, skills, strengths } = req.body;

    if (!name || !email) return res.status(400).json({ success: false, error: 'name and email are required' });
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: 'Invalid email format' });

    const expYears = parseFloat(experience_years);
    if (experience_years !== undefined && experience_years !== null && experience_years !== '' && (isNaN(expYears) || expYears < 0 || expYears > 80)) {
        return res.status(400).json({ success: false, error: 'experience_years must be a number between 0 and 80' });
    }

    const skillsArr    = Array.isArray(skills)    ? skills.filter(s => typeof s === 'string' && s.trim())    : [];
    const strengthsArr = Array.isArray(strengths) ? strengths.filter(s => typeof s === 'string' && s.trim()) : [];

    try {
        // Upsert: create if not exists, update if already there (handles double-submit)
        const r = await pgPool.query(
            `INSERT INTO profile (name, email, role, experience_years, skills, strengths, current_projects, assigned_effort_points)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb, 0)
             ON CONFLICT (email) DO UPDATE
               SET name              = EXCLUDED.name,
                   role              = EXCLUDED.role,
                   experience_years  = EXCLUDED.experience_years,
                   skills            = EXCLUDED.skills,
                   strengths         = EXCLUDED.strengths
             RETURNING id, name, email, role, experience_years, skills, strengths`,
            [
                name.trim(),
                email.toLowerCase(),
                role || null,
                isNaN(expYears) ? null : expYears,
                JSON.stringify(skillsArr),
                JSON.stringify(strengthsArr),
            ]
        );
        res.json({ success: true, profile: r.rows[0] });
    } catch (err) {
        console.error('DB error POST /api/profiles:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// === PROJECTS CRUD ===

// === DASHBOARD DATA ===
app.get('/api/dashboard', async (req, res) => {
    try {
        const agenticBase   = path.join(__dirname, '..', 'scrummate_agentic');
        const summariesDir  = path.join(agenticBase, 'summaries');
        const standupsDir   = path.join(agenticBase, 'standups');
        const transcriptsDir = path.join(__dirname, 'transcripts');

        // ── Projects from DB ──────────────────────────────────
        const projectsResult = await pgPool.query(
            `SELECT id, name, status, trello_board_id,
                    jsonb_array_length(COALESCE(team, '[]'::jsonb)) AS member_count
             FROM project ORDER BY id`
        );
        const projects = projectsResult.rows;
        const activeCount = projects.filter(p => p.status === 'In Progress').length;

        // ── Meetings from filesystem ──────────────────────────
        const transcriptFiles = fs.existsSync(transcriptsDir)
            ? fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.json')).sort().reverse()
            : [];

        // Build project ID lookup by position (deterministic but random-looking)
        const projectIds = projects.map(p => p.id);
        function assignProject(meetId) {
            // Stable hash so same meeting always maps to same project
            let h = 0;
            for (const c of meetId) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
            return projectIds[h % projectIds.length] || null;
        }

        // Load DB meeting rows for project lookup
        const dbMeetings = await pgPool.query('SELECT google_meet_id, project_id FROM meetings');
        const dbMeetMap = new Map(dbMeetings.rows.map(r => [r.google_meet_id, r.project_id]));

        const meetings = [];
        for (const filename of transcriptFiles) {
            try {
                const raw  = JSON.parse(fs.readFileSync(path.join(transcriptsDir, filename), 'utf-8'));
                const meetUrl = raw.meeting_url || '';
                const meetId  = meetUrl.replace('https://meet.google.com/', '').replace('http://meet.google.com/', '').split('?')[0].trim() || filename;

                const hasTranscript = Array.isArray(raw.transcript) && raw.transcript.length > 0;
                const hasSummary    = fs.existsSync(path.join(summariesDir, `${meetId}_final.txt`));
                const hasBlockers   = fs.existsSync(path.join(standupsDir,  `${meetId}_blockers.json`));

                let status = 'healthy';
                if (!hasTranscript && (raw.statistics?.total_words || 0) === 0) status = 'no-transcript';
                else if (!hasSummary && !hasBlockers) status = 'no-pipeline';

                const stats = raw.statistics || {};
                const dur   = stats.duration_seconds
                    ? `${Math.floor(stats.duration_seconds / 60)}m ${stats.duration_seconds % 60}s`
                    : (raw.stopped_at && raw.created_at
                        ? (() => { const s = Math.round((new Date(raw.stopped_at) - new Date(raw.created_at)) / 1000); return `${Math.floor(s/60)}m ${s%60}s`; })()
                        : '—');

                const projectId = dbMeetMap.get(meetId) || raw.project_id || assignProject(meetId);
                const project   = projects.find(p => p.id === projectId);

                meetings.push({
                    filename,
                    meetId,
                    meeting_type: raw.meeting_type || 'unknown',
                    created_at:   raw.created_at,
                    duration:     dur,
                    status,
                    hasTranscript,
                    hasSummary,
                    hasBlockers,
                    projectId,
                    projectName: project?.name || null,
                    wordCount: stats.total_words || 0,
                    speakerCount: stats.total_speakers || 0
                });
            } catch (_) { /* skip malformed */ }
        }

        // ── Latest meeting output ─────────────────────────────
        // Priority: user stories (assignments) → blockers → meeting minutes
        const userStoriesDir = path.join(agenticBase, 'user_stories');

        let latestOutput = null;

        // 1. User stories — pick the most recent assignments file
        if (!latestOutput && fs.existsSync(userStoriesDir)) {
            const storyFiles = fs.readdirSync(userStoriesDir)
                .filter(f => f.endsWith('_assignments.json'))
                .sort()
                .reverse();
            for (const sf of storyFiles) {
                try {
                    const meetId = sf.replace('_assignments.json', '');
                    const raw = JSON.parse(fs.readFileSync(path.join(userStoriesDir, sf), 'utf-8'));
                    if (Array.isArray(raw) && raw.length > 0) {
                        latestOutput = { type: 'stories', meetId, meetingType: 'po-meeting', data: raw };
                        break;
                    }
                } catch (_) {}
            }
        }

        // 2. Blockers from standups
        if (!latestOutput) {
            for (const m of meetings) {
                if (m.hasBlockers) {
                    try {
                        const raw = JSON.parse(fs.readFileSync(path.join(standupsDir, `${m.meetId}_blockers.json`), 'utf-8'));
                        latestOutput = { type: 'blockers', meetId: m.meetId, meetingType: m.meeting_type, data: raw };
                        break;
                    } catch (_) {}
                }
            }
        }

        // 3. Meeting minutes summary
        if (!latestOutput) {
            for (const m of meetings) {
                if (m.hasSummary) {
                    try {
                        const jsonPath = path.join(summariesDir, `${m.meetId}_minutes.json`);
                        const raw = fs.existsSync(jsonPath)
                            ? JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
                            : { project_name: m.projectName, meeting_minutes: fs.readFileSync(path.join(summariesDir, `${m.meetId}_final.txt`), 'utf-8') };
                        latestOutput = { type: 'summary', meetId: m.meetId, meetingType: m.meeting_type, data: raw };
                        break;
                    } catch (_) {}
                }
            }
        }

        res.json({
            success: true,
            stats: { totalMeetings: transcriptFiles.length, activeProjects: activeCount },
            projects,
            meetings: meetings.slice(0, 10),
            latestOutput
        });
    } catch (err) {
        console.error('/api/dashboard error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/projects/user-boards — Trello board IDs for projects the user is a member of
// Team field stores numeric profile IDs; join through profile table to match by email.
app.get('/api/projects/user-boards', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: 'email query param required' });
    try {
        const result = await pgPool.query(
            `SELECT p.trello_board_id
             FROM project p
             JOIN profile pr ON p.team @> to_jsonb(pr.id)
             WHERE pr.email = $1
               AND p.trello_board_id IS NOT NULL
               AND p.trello_board_id <> ''`,
            [email]
        );
        const ids = result.rows.map(r => r.trello_board_id);
        res.json({ success: true, boardIds: [...new Set(ids)] });
    } catch (err) {
        console.error('DB error GET /api/projects/user-boards:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/projects  — all projects (optionally filtered by member email)
// Returns member details (name, email, role) by joining with profile table.
app.get('/api/projects', async (req, res) => {
    const { email } = req.query;
    try {
        const baseSelect = `
            SELECT p.id, p.name, p.status, p.sprints, p.user_stories_count,
                   p.description, p.trello_board_id, p.team, p.created_at,
                   COALESCE(jsonb_array_length(p.us_done), 0)    AS us_done_count,
                   COALESCE(jsonb_array_length(p.us_pending), 0) AS us_pending_count
            FROM project p`;

        const result = email
            ? await pgPool.query(baseSelect + `
                JOIN profile pr ON pr.email = $1
                WHERE p.team @> to_jsonb(pr.id)
                ORDER BY p.created_at DESC`, [email])
            : await pgPool.query(baseSelect + ` ORDER BY p.created_at DESC`);

        // Collect all profile IDs referenced across all projects
        const allIds = [...new Set(result.rows.flatMap(p => {
            const t = p.team;
            if (Array.isArray(t)) return t.filter(Number.isInteger);
            return [];
        }))];

        let profileMap = {};
        if (allIds.length) {
            const profiles = await pgPool.query(
                `SELECT id, name, email, role FROM profile WHERE id = ANY($1::int[])`,
                [allIds]
            );
            profiles.rows.forEach(r => { profileMap[r.id] = r; });
        }

        const projects = result.rows.map(p => {
            const teamIds = Array.isArray(p.team) ? p.team.filter(Number.isInteger) : [];
            return {
                ...p,
                members: teamIds.map(id => profileMap[id] || { id, name: null, email: null, role: null })
            };
        });

        res.json({ success: true, projects });
    } catch (err) {
        console.error('DB error GET /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/projects — create a project
// Body: { name, status, description, emoji, color, sprints, teamEmails[], trelloBoardId?, creatorEmail?, createBoard? }
app.post('/api/projects', async (req, res) => {
    const { name, status, description, emoji, color, sprints, teamEmails, trelloBoardId, creatorEmail, createBoard } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name is required' });
    }

    // Validate teamEmails if provided
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (Array.isArray(teamEmails)) {
        const invalid = teamEmails.filter(e => typeof e !== 'string' || !EMAIL_RE.test(e));
        if (invalid.length) {
            return res.status(400).json({ success: false, error: `Invalid email(s): ${invalid.join(', ')}` });
        }
    }

    // Validate trelloBoardId if provided (alphanumeric/dash/underscore, 4–32 chars)
    if (trelloBoardId && !/^[A-Za-z0-9_-]{4,32}$/.test(trelloBoardId)) {
        return res.status(400).json({ success: false, error: 'Invalid Trello board ID' });
    }

    try {
        // Resolve profile IDs from emails (always include creator)
        const allEmails = [...new Set([
            ...(Array.isArray(teamEmails) ? teamEmails : []),
            ...(creatorEmail ? [creatorEmail] : [])
        ].map(e => e.toLowerCase()))];

        // Fetch full profile rows so we have name + email for the webhook
        let profileRows = [];
        let teamIds = [];
        if (allEmails.length) {
            const lookup = await pgPool.query(
                `SELECT id, name, email FROM profile WHERE email = ANY($1::text[])`,
                [allEmails]
            );
            profileRows = lookup.rows;
            teamIds = profileRows.map(r => r.id);
        }

        const result = await pgPool.query(
            `INSERT INTO project (name, status, sprints, user_stories_count, us_done, us_pending, description, team, trello_board_id)
             VALUES ($1, $2, $3, 0, '[]'::jsonb, '[]'::jsonb, $4, $5::jsonb, $6)
             RETURNING id, name, status, sprints, user_stories_count, description, trello_board_id, team, created_at`,
            [
                name,
                status || 'Not Started',
                sprints || null,
                description || null,
                JSON.stringify(teamIds),
                trelloBoardId || null,
            ]
        );

        // Fire n8n webhook to set up Trello board (fire-and-forget)
        if (createBoard && profileRows.length) {
            const creatorLower = (creatorEmail || '').toLowerCase();
            const webhookMembers = profileRows.map(p => ({
                email: p.email,
                name:  p.name || p.email,
                role:  p.email.toLowerCase() === creatorLower ? 'leader' : 'normal',
            }));

            axios.post(
                'http://13.201.30.41:5678/webhook/setup_board',
                { project_name: name.trim(), members: webhookMembers },
                { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
            ).then(() => {
                console.log(`[Trello webhook] Board setup triggered for "${name}"`);
            }).catch(err => {
                console.warn(`[Trello webhook] Board setup failed for "${name}":`, err.message);
            });
        }

        res.json({ success: true, project: { ...result.rows[0], emoji, color } });
    } catch (err) {
        console.error('DB error POST /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/projects/:id — update a project
app.put('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    const { name, status, sprints, description, teamEmails, trelloBoardId } = req.body;
    try {
        let teamIds = null;
        if (Array.isArray(teamEmails)) {
            const lookup = await pgPool.query(
                `SELECT id FROM profile WHERE email = ANY($1::text[])`,
                [teamEmails]
            );
            teamIds = lookup.rows.map(r => r.id);
        }

        const fields = [];
        const vals = [];
        let idx = 1;
        if (name !== undefined)          { fields.push(`name = $${idx++}`);             vals.push(name); }
        if (status !== undefined)        { fields.push(`status = $${idx++}`);           vals.push(status); }
        if (sprints !== undefined)       { fields.push(`sprints = $${idx++}`);          vals.push(sprints); }
        if (description !== undefined)   { fields.push(`description = $${idx++}`);      vals.push(description || null); }
        if (teamIds !== null)            { fields.push(`team = $${idx++}::jsonb`);      vals.push(JSON.stringify(teamIds)); }
        if (trelloBoardId !== undefined) { fields.push(`trello_board_id = $${idx++}`); vals.push(trelloBoardId || null); }

        if (!fields.length) return res.status(400).json({ success: false, error: 'Nothing to update' });

        vals.push(id);
        const result = await pgPool.query(
            `UPDATE project SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            vals
        );
        if (!result.rows.length) return res.status(404).json({ success: false, error: 'Project not found' });
        res.json({ success: true, project: result.rows[0] });
    } catch (err) {
        console.error('DB error PUT /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/suggest-assignments
// Fetches the project's team from DB then asks the Python agentic API for story assignments.
// Body: { meetingId, projectId }
app.post('/api/suggest-assignments', async (req, res) => {
    const { meetingId, projectId } = req.body;
    if (!meetingId) return res.status(400).json({ success: false, error: 'meetingId is required' });

    try {
        // Fetch team members for the project from DB
        let teamMembers = [];
        if (projectId) {
            const projRes = await pgPool.query(
                `SELECT pr.id, pr.name, pr.role, pr.experience_years,
                        pr.skills, pr.strengths, pr.assigned_effort_points
                 FROM project p
                 JOIN profile pr ON pr.id = ANY(ARRAY(SELECT jsonb_array_elements_text(p.team)::int))
                 WHERE p.id = $1`,
                [projectId]
            );
            teamMembers = projRes.rows.map(r => ({
                name:                   r.name,
                role:                   r.role || 'Developer',
                experience_years:       r.experience_years || 0,
                skills:                 Array.isArray(r.skills) ? r.skills : [],
                strengths:              Array.isArray(r.strengths) ? r.strengths : [],
                assigned_effort_points: r.assigned_effort_points || 0,
            }));
        }

        if (!teamMembers.length) {
            return res.status(400).json({ success: false, error: 'No team members found for this project. Add members to the project first.' });
        }

        // Delegate to Python agentic API
        const agRes = await axios.post(
            `${AGENTIC_API_URL}/pipeline/suggest-assignments`,
            { meeting_id: meetingId, team_members: teamMembers },
            { timeout: 120000 }
        );
        res.json({ success: true, assignments: agRes.data.assignments, meeting_id: agRes.data.meeting_id });
    } catch (err) {
        const detail = err.response?.data?.detail || err.message;
        console.error('suggest-assignments error:', detail);
        res.status(500).json({ success: false, error: detail });
    }
});

// DELETE /api/projects/:id
app.delete('/api/projects/:id', async (req, res) => {
    try {
        await pgPool.query(`DELETE FROM project WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('DB error DELETE /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/profiles/lookup?email=foo@bar.com — check if a profile exists
app.get('/api/profiles/lookup', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: 'email required' });

    // Server-side email format check
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    try {
        const r = await pgPool.query(`SELECT id, name, email, role FROM profile WHERE email = $1`, [email.toLowerCase()]);
        if (!r.rows.length) return res.status(404).json({ success: false, error: 'Profile not found' });
        res.json({ success: true, profile: r.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/projects/trello/create — create a Trello board and return its ID/URL
// Body: { projectName }
app.post('/api/projects/trello/create', async (req, res) => {
    const { projectName } = req.body;
    if (!projectName || typeof projectName !== 'string' || !projectName.trim()) {
        return res.status(400).json({ success: false, error: 'projectName is required' });
    }
    const key   = process.env.TRELLO_KEY;
    const token = process.env.TRELLO_TOKEN;
    if (!key || !token) return res.status(500).json({ success: false, error: 'Trello credentials not configured' });
    try {
        const response = await axios.post(
            `https://api.trello.com/1/boards/`,
            null,
            { params: { name: projectName || 'ScrumMate Project', key, token, defaultLists: true } }
        );
        const board = response.data;
        res.json({ success: true, boardId: board.id, boardUrl: board.url, boardName: board.name });
    } catch (err) {
        console.error('Trello create board error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
});

// List saved transcripts
app.get('/api/transcripts', (req, res) => {
    try {
        const transcriptsDir = path.join(__dirname, 'transcripts');
        const agenticBase   = path.join(__dirname, '..', 'scrummate_agentic');
        const summariesDir  = path.join(agenticBase, 'summaries');
        const storiesDir    = path.join(agenticBase, 'user_stories');
        const standupsDir   = path.join(agenticBase, 'standups');

        if (!fs.existsSync(transcriptsDir)) {
            return res.json({ success: true, transcripts: [] });
        }

        const meetIdFromUrl = url => {
            const m = url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
            return m ? m[1] : null;
        };

        const files = fs.readdirSync(transcriptsDir)
            .filter(f => f.endsWith('.json'))
            .map(filename => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(transcriptsDir, filename), 'utf-8'));
                    const meeting_id   = meetIdFromUrl(data.meeting_url)
                                      || (data.bot_id ? data.bot_id.substring(0, 11) : null);
                    const meeting_type = data.meeting_type || 'product-owner';
                    const has_minutes  = meeting_id && fs.existsSync(path.join(summariesDir, `${meeting_id}_final.txt`));
                    const has_stories  = meeting_id && fs.existsSync(path.join(storiesDir, `${meeting_id}_stories.json`));
                    // Blockers live in standups/ for daily-standup, user_stories/ for everything else
                    const has_blockers = meeting_id && (
                        meeting_type === 'daily-standup'
                            ? fs.existsSync(path.join(standupsDir, `${meeting_id}_blockers.json`))
                            : fs.existsSync(path.join(storiesDir, `${meeting_id}_blockers.json`))
                    );
                    return {
                        filename,
                        meeting_url:  data.meeting_url  || '',
                        meeting_type,
                        bot_id:       data.bot_id       || '',
                        meeting_id,
                        created_at:   data.created_at,
                        stopped_at:   data.stopped_at,
                        statistics:   data.statistics   || {},
                        has_minutes:  !!has_minutes,
                        has_stories:  !!has_stories,
                        has_blockers: !!has_blockers,
                    };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ success: true, transcripts: files });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Return full transcript JSON for display
app.get('/api/transcript/:filename', (req, res) => {
    try {
        const filepath = path.join(__dirname, 'transcripts', req.params.filename);
        if (!fs.existsSync(filepath)) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, data: JSON.parse(fs.readFileSync(filepath, 'utf-8')) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Return minutes text for a meeting
app.get('/api/minutes/:meetingId', (req, res) => {
    try {
        const p = path.join(__dirname, '..', 'scrummate_agentic', 'summaries', `${req.params.meetingId}_final.txt`);
        if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: 'No minutes found' });
        res.json({ success: true, text: fs.readFileSync(p, 'utf-8') });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Return stories or blockers JSON for a meeting
// ?type=daily-standup → look in standups/; anything else → look in user_stories/
app.get('/api/stories/:meetingId', (req, res) => {
    try {
        const agenticBase  = path.join(__dirname, '..', 'scrummate_agentic');
        const storiesBase  = path.join(agenticBase, 'user_stories');
        const standupsBase = path.join(agenticBase, 'standups');
        const meetingType  = req.query.type || '';
        const mid          = req.params.meetingId;

        if (meetingType === 'daily-standup') {
            // Standup blockers always live in standups/
            const blockersPath = path.join(standupsBase, `${mid}_blockers.json`);
            if (fs.existsSync(blockersPath))
                return res.json({ success: true, type: 'blockers', data: JSON.parse(fs.readFileSync(blockersPath, 'utf-8')) });
            return res.status(404).json({ success: false, error: 'No blockers report found for this standup' });
        }

        // Product Owner / Retrospective — check user_stories/
        const storiesPath  = path.join(storiesBase, `${mid}_stories.json`);
        const blockersPath = path.join(storiesBase, `${mid}_blockers.json`);
        if (fs.existsSync(storiesPath))  return res.json({ success: true, type: 'stories',  data: JSON.parse(fs.readFileSync(storiesPath, 'utf-8')) });
        if (fs.existsSync(blockersPath)) return res.json({ success: true, type: 'blockers', data: JSON.parse(fs.readFileSync(blockersPath, 'utf-8')) });
        return res.status(404).json({ success: false, error: 'No stories or blockers found' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// === TRELLO ANALYTICS — AGGREGATED DASHBOARD ===
app.get('/api/trello/dashboard', async (req, res) => {
    if (!TRELLO_KEY || !TRELLO_TOKEN) {
        return res.status(503).json({ success: false, error: 'Trello is not configured. Set TRELLO_KEY and TRELLO_TOKEN in .env.' });
    }
    const WINDOW_DAYS = 14;
    const windowStart = Date.now() - WINDOW_DAYS * 86400000;
    const CONCURRENCY = 3;
    try {
        const boards = await trelloGet('/members/me/boards', { fields: 'id,name,closed', filter: 'open' });
        const openBoards = (boards || []).filter(b => !b.closed);
        if (!openBoards.length) return res.status(404).json({ success: false, error: 'No open Trello boards found.' });

        const dayEnds = buildDayEndTimestamps(WINDOW_DAYS);
        const perBoard = [];
        for (let i = 0; i < openBoards.length; i += CONCURRENCY) {
            const chunk = await Promise.all(
                openBoards.slice(i, i + CONCURRENCY).map(b =>
                    loadSingleBoardAnalytics(b.id, windowStart, WINDOW_DAYS, dayEnds)
                        .catch(err => { console.error(`Trello board ${b.id}:`, err.message); return null; })
                )
            );
            perBoard.push(...chunk);
        }
        const okBoards = perBoard.filter(Boolean);
        if (!okBoards.length) return res.status(502).json({ success: false, error: 'Could not load any board data from Trello.' });

        const totals = { cards: 0, done: 0, open: 0, blocked: 0 };
        const doneNameSet = new Set();
        const burndown = dayEnds.map((endTs) => ({
            date: new Date(endTs).toISOString().slice(0, 10), actualRemaining: 0, idealRemaining: 0
        }));
        for (const row of okBoards) {
            totals.cards   += row.totals.cards;
            totals.done    += row.totals.done;
            totals.open    += row.totals.open;
            totals.blocked += row.totals.blocked;
            row.doneListNames.forEach(n => doneNameSet.add(n));
            for (let i = 0; i < burndown.length; i++) {
                burndown[i].actualRemaining += row.burndown[i].actualRemaining;
                burndown[i].idealRemaining  += row.burndown[i].idealRemaining;
            }
        }
        const completionPercent = totals.cards ? Math.round((100 * totals.done) / totals.cards) : 100;
        res.json({
            success: true,
            workspace: { scope: 'all_open_boards', boardCount: openBoards.length, boardsLoaded: okBoards.length, boards: openBoards.map(b => ({ id: b.id, name: b.name })) },
            board: { id: null, name: `All open boards (${okBoards.length})` },
            totals, completionPercent,
            doneListNames: [...doneNameSet].slice(0, 24),
            burndown, windowDays: WINDOW_DAYS
        });
    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        console.error('Trello dashboard error:', msg);
        res.status(error.response?.status || 500).json({ success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    }
});

// === TRELLO ANALYTICS — PER-BOARD DETAIL ===
app.get('/api/trello/boards-detailed', async (req, res) => {
    if (!TRELLO_KEY || !TRELLO_TOKEN) {
        return res.status(503).json({ success: false, error: 'Trello is not configured. Set TRELLO_KEY and TRELLO_TOKEN in .env.' });
    }
    const WINDOW_DAYS = 14;
    const windowStart = Date.now() - WINDOW_DAYS * 86400000;
    const CONCURRENCY = 3;
    try {
        const boards = await trelloGet('/members/me/boards', { fields: 'id,name,closed', filter: 'open' });
        const openBoards = (boards || []).filter(b => !b.closed);
        if (!openBoards.length) return res.status(404).json({ success: false, error: 'No open Trello boards found.' });

        const dayEnds = buildDayEndTimestamps(WINDOW_DAYS);
        const perBoard = [];
        for (let i = 0; i < openBoards.length; i += CONCURRENCY) {
            const chunk = await Promise.all(
                openBoards.slice(i, i + CONCURRENCY).map(b =>
                    loadSingleBoardAnalytics(b.id, windowStart, WINDOW_DAYS, dayEnds)
                        .catch(err => { console.error(`Trello board ${b.id}:`, err.message); return null; })
                )
            );
            perBoard.push(...chunk);
        }
        const okBoards = perBoard.filter(Boolean);
        if (!okBoards.length) return res.status(502).json({ success: false, error: 'Could not load any board data from Trello.' });

        const boardsDetail = okBoards.map(board => {
            const t = board.totals;
            const info = openBoards.find(b => b.id === board.boardId);
            return {
                id: board.boardId, name: info?.name || 'Unknown Board',
                metrics: { total: t.cards, done: t.done, open: t.open, blocked: t.blocked, completionPercent: t.cards ? Math.round((100 * t.done) / t.cards) : 100 },
                burndown: board.burndown, doneListNames: board.doneListNames
            };
        });

        const totals = { cards: 0, done: 0, open: 0, blocked: 0 };
        const doneNameSet = new Set();
        const burndown = dayEnds.map(endTs => ({ date: new Date(endTs).toISOString().slice(0, 10), actualRemaining: 0, idealRemaining: 0 }));
        for (const row of okBoards) {
            totals.cards += row.totals.cards; totals.done += row.totals.done;
            totals.open  += row.totals.open;  totals.blocked += row.totals.blocked;
            row.doneListNames.forEach(n => doneNameSet.add(n));
            for (let i = 0; i < burndown.length; i++) {
                burndown[i].actualRemaining += row.burndown[i].actualRemaining;
                burndown[i].idealRemaining  += row.burndown[i].idealRemaining;
            }
        }
        const completionPercent = totals.cards ? Math.round((100 * totals.done) / totals.cards) : 100;
        res.json({
            success: true,
            workspace: { scope: 'all_open_boards', boardCount: openBoards.length, boardsLoaded: okBoards.length, boardsDetail: boardsDetail.sort((a, b) => b.metrics.total - a.metrics.total) },
            totals: { workspace: totals, completionPercent },
            doneListNames: [...doneNameSet].slice(0, 24),
            burndown, windowDays: WINDOW_DAYS, fetchedAt: new Date().toISOString()
        });
    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        console.error('Trello boards-detailed error:', msg);
        res.status(error.response?.status || 500).json({ success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`RAG page: http://localhost:${PORT}/rag.html`);
    console.log('Ready!');
    console.log('');
    console.log('For local testing, use ngrok: npx ngrok http 3000');
    console.log('Then update destination_url in the code with your ngrok URL');
    console.log('============================================');
});