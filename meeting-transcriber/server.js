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
    res.sendFile(path.join(__dirname, 'login.html'));
});

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_API_URL = 'https://us-west-2.recall.ai/api/v1';
const AGENTIC_API_URL = process.env.AGENTIC_API_URL || 'http://localhost:8000';

console.log('Starting Meeting Transcriber...');
console.log(`Using US West 2 region`);
console.log(`API Key: ${RECALL_API_KEY ? 'Set' : 'Missing!'}`);
console.log(`Agentic API: ${AGENTIC_API_URL}`);

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
        const { transcriptFile } = req.body;

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

// === PROJECTS CRUD ===

// GET /api/projects  — all projects (optionally filtered by member email)
app.get('/api/projects', async (req, res) => {
    const { email } = req.query;
    try {
        let result;
        if (email) {
            result = await pgPool.query(
                `SELECT p.id, p.name, p.status, p.sprints, p.user_stories_count,
                        p.trello_board_id, p.team, p.created_at,
                        COALESCE(jsonb_array_length(p.us_done), 0)    AS us_done_count,
                        COALESCE(jsonb_array_length(p.us_pending), 0) AS us_pending_count
                 FROM project p
                 WHERE p.team @> to_jsonb(ARRAY(
                     SELECT pr.id FROM profile pr WHERE pr.email = $1
                 ))
                 ORDER BY p.created_at DESC`,
                [email]
            );
        } else {
            result = await pgPool.query(
                `SELECT p.id, p.name, p.status, p.sprints, p.user_stories_count,
                        p.trello_board_id, p.team, p.created_at,
                        COALESCE(jsonb_array_length(p.us_done), 0)    AS us_done_count,
                        COALESCE(jsonb_array_length(p.us_pending), 0) AS us_pending_count
                 FROM project p
                 ORDER BY p.created_at DESC`
            );
        }
        res.json({ success: true, projects: result.rows });
    } catch (err) {
        console.error('DB error GET /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/projects — create a project
// Body: { name, status, description, emoji, color, sprints, teamEmails[], trelloBoardId? }
app.post('/api/projects', async (req, res) => {
    const { name, status, description, emoji, color, sprints, teamEmails, trelloBoardId } = req.body;
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
        // Resolve profile IDs from emails (ignore unknown emails)
        let teamIds = [];
        if (Array.isArray(teamEmails) && teamEmails.length) {
            const lookup = await pgPool.query(
                `SELECT id FROM profile WHERE email = ANY($1::text[])`,
                [teamEmails.map(e => e.toLowerCase())]
            );
            teamIds = lookup.rows.map(r => r.id);
        }

        const result = await pgPool.query(
            `INSERT INTO project (name, status, sprints, user_stories_count, team, trello_board_id)
             VALUES ($1, $2, $3, 0, $4::jsonb, $5)
             RETURNING id, name, status, sprints, user_stories_count, trello_board_id, team, created_at`,
            [
                name,
                status || 'Not Started',
                sprints || null,
                JSON.stringify(teamIds),
                trelloBoardId || null,
            ]
        );
        // Store extra display fields client-side; return core DB row
        res.json({ success: true, project: { ...result.rows[0], emoji, color, description } });
    } catch (err) {
        console.error('DB error POST /api/projects:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT /api/projects/:id — update a project
app.put('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    const { name, status, sprints, teamEmails, trelloBoardId } = req.body;
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