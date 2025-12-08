// comprehensive-test.js
const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.RECALL_API_KEY;
const BASE_URL = 'https://us-west-2.recall.ai';

console.log('🔍 Comprehensive Recall.ai API Discovery');
console.log('========================================');
console.log(`Base: ${BASE_URL}`);
console.log(`Key: ${API_KEY ? API_KEY.substring(0, 8) + '...' : 'Missing!'}`);

// Test common REST API patterns
const endpoints = [
    // Standard patterns
    '/api/v1/bots/',
    '/api/v1/bot/',
    '/v1/bots/',
    '/v1/bot/',
    '/bots/',
    '/bot/',
    
    // Alternative patterns
    '/api/bots/',
    '/api/bot/',
    '/rest/v1/bots/',
    '/rest/v1/bot/',
    
    // Could be completely different
    '/api/v1/meetings/',
    '/api/v1/meeting/',
    '/v1/meetings/',
    '/v1/meeting/',
    
    // Webhook/transcription specific
    '/api/v1/transcriptions/',
    '/api/v1/transcription/',
    
    // Maybe it's under a different namespace
    '/api/v1/recall/bots/',
    '/api/v1/recall/bot/',
];

async function discoverEndpoints() {
    console.log('\n📡 Discovering available endpoints...');
    
    for (const endpoint of endpoints) {
        try {
            const url = `${BASE_URL}${endpoint}`;
            console.log(`\nTesting: ${endpoint}`);
            
            // Try GET first
            const getResponse = await axios.get(url, {
                headers: { 
                    'Authorization': `Token ${API_KEY}`,
                    'User-Agent': 'Discovery/1.0'
                },
                params: { limit: 1 },
                timeout: 3000
            });
            
            console.log(`  ✅ GET works (${getResponse.status})`);
            console.log(`     Response keys: ${Object.keys(getResponse.data).join(', ')}`);
            
            if (getResponse.data.results || getResponse.data.count !== undefined) {
                console.log(`     Has ${getResponse.data.count || getResponse.data.results?.length || 0} items`);
            }
            
            // Now try POST
            try {
                const postResponse = await axios.post(
                    url,
                    {
                        meeting_url: 'https://meet.google.com/test-test-test',
                        transcription_options: { provider: "deepgram" }
                    },
                    {
                        headers: {
                            'Authorization': `Token ${API_KEY}`,
                            'Content-Type': 'application/json',
                            'User-Agent': 'Discovery/1.0'
                        },
                        timeout: 3000
                    }
                );
                
                console.log(`  🎯 POST works too! (${postResponse.status})`);
                console.log(`     Bot ID: ${postResponse.data.id}`);
                
                // Clean up
                if (postResponse.data.id) {
                    await axios.delete(`${url}${postResponse.data.id}/`, {
                        headers: { 'Authorization': `Token ${API_KEY}` }
                    });
                    console.log(`     Cleaned up test bot`);
                }
                
                return endpoint; // Found working endpoint!
                
            } catch (postError) {
                console.log(`  ❌ POST failed: ${postError.response?.status} - ${postError.response?.data?.detail || 'No detail'}`);
            }
            
        } catch (error) {
            console.log(`  ❌ GET failed: ${error.response?.status || error.code}`);
        }
    }
    
    console.log('\n❌ No working endpoint found with standard patterns.');
    console.log('Let me check the Recall.ai documentation directly...');
    return null;
}

async function checkDocumentation() {
    console.log('\n📚 Checking possible solutions:');
    console.log('1. Visit: https://docs.recall.ai/reference/createbot');
    console.log('2. Look for the exact endpoint URL in their docs');
    console.log('3. Your region (us-west-2) might have special requirements');
    console.log('4. Check if you need to enable something in dashboard first');
    
    // Try to fetch Recall.ai's own API docs
    try {
        console.log('\n🌐 Fetching Recall.ai OpenAPI spec...');
        const response = await axios.get('https://docs.recall.ai/openapi.json', {
            timeout: 5000
        });
        
        if (response.data) {
            console.log('Found OpenAPI spec. Looking for paths...');
            const paths = Object.keys(response.data.paths || {});
            console.log(`First few paths: ${paths.slice(0, 5).join(', ')}`);
        }
    } catch (e) {
        // Ignore if can't fetch
    }
}

// Run discovery
discoverEndpoints().then(async (foundEndpoint) => {
    if (foundEndpoint) {
        console.log('\n🎉 SUCCESS! Found working endpoint:');
        console.log(`   ${BASE_URL}${foundEndpoint}`);
        console.log('\n🚀 Update your server.js with:');
        console.log(`   const RECALL_API_URL = '${BASE_URL}${foundEndpoint}';`);
    } else {
        await checkDocumentation();
        
        console.log('\n⚠️  NEXT STEPS:');
        console.log('1. Check Recall.ai dashboard for API examples');
        console.log('2. Contact support: support@recall.ai');
        console.log('3. Try different meeting URL format');
        console.log('4. Ensure your account has transcription enabled');
    }
});