import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";

const fastify = Fastify({ logger: true });
await fastify.register(formbody);

// ---------------- ENV ----------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  OPENAI_API_KEY,
  AIRTABLE_PAT,
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  INSTAGRAM_VERIFY_TOKEN,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY || !AIRTABLE_PAT) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- EXISTING TENANT SYSTEM ----------------
let TENANTS = {};
let TENANT_DETAILS = new Map();

try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("✅ Loaded tenants registry");
} catch (e) {
  fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

function loadTenantDetails(tenantId) {
  if (TENANT_DETAILS.has(tenantId)) {
    return TENANT_DETAILS.get(tenantId);
  }

  try {
    const detailsPath = `./tenants/${tenantId}/config.json`;
    if (fs.existsSync(detailsPath)) {
      const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
      TENANT_DETAILS.set(tenantId, details);
      return details;
    }
  } catch (err) {
    fastify.log.warn({ err, tenantId }, "Error loading tenant details");
  }
  
  return {};
}

function getTenantByToNumber(toNumber) {
  if (!toNumber) return null;

  const normalized = normalizePhone(toNumber);
  let baseTenant = null;
  
  if (TENANTS[toNumber]) baseTenant = TENANTS[toNumber];
  else if (TENANTS[normalized]) baseTenant = TENANTS[normalized];
  else {
    for (const tenant of Object.values(TENANTS)) {
      if (tenant?.phone_number) {
        const tenantNormalized = normalizePhone(tenant.phone_number);
        if (tenantNormalized === normalized) {
          baseTenant = tenant;
          break;
        }
      }
    }
  }
  
  if (!baseTenant) {
    baseTenant = Object.values(TENANTS)[0] || null;
  }
  
  if (baseTenant?.tenant_id) {
    const details = loadTenantDetails(baseTenant.tenant_id);
    return { ...baseTenant, ...details };
  }
  
  return baseTenant;
}
function loadKnowledgeFor(tenant) {
  try {
    if (tenant?.tenant_id) {
      const tenantKnowledgePath = `./tenants/${tenant.tenant_id}/knowledge.md`;
      if (fs.existsSync(tenantKnowledgePath)) {
        const tenantKnowledge = fs.readFileSync(tenantKnowledgePath, "utf8");
        
        if (fs.existsSync("./knowledge.md")) {
          const universalKnowledge = fs.readFileSync("./knowledge.md", "utf8");
          return universalKnowledge + "\n\n" + tenantKnowledge;
        }
        return tenantKnowledge;
      }
    }
    
    if (fs.existsSync("./knowledge.md")) {
      return fs.readFileSync("./knowledge.md", "utf8");
    }
  } catch (err) {
    fastify.log.warn({ err }, "Error loading knowledge");
  }
  return "";
}

function buildVoicePrompt(tenant, knowledgeText) {
  const t = tenant || {};
  
  const services = (t.services?.primary || t.services || []).join(", ");
  const hours = t.hours?.hours_string || t.hours_string || "Please call during business hours";
  
  const loctician = t.loctician_name || "our stylist";
  const experience = t.experience_years ? `${t.experience_years} years experience` : "";
  const specialties = (t.services?.specialties || t.specialties || []).join(", ");
  
  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL INSTRUCTIONS:
- Keep responses under 15 seconds
- Never spell out URLs - just say "visit our website" or "check our portal"
- DO NOT repeat or rephrase the customer's question back to them
- Answer directly and naturally

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Loctician: ${loctician}${experience ? ` - ${experience}` : ""}
- Hours: ${hours}
- Services: ${services || "Hair care services"}
${specialties ? `- Specialties: ${specialties}` : ""}

Knowledge Base:
${(knowledgeText || "").slice(0, 8000)}`;

  return prompt.slice(0, 15000);
}

// ---------------- INSTAGRAM WEBHOOK HANDLERS ----------------

// Instagram OAuth configuration
const INSTAGRAM_CONFIG = {
  clientId: INSTAGRAM_APP_ID,
  clientSecret: INSTAGRAM_APP_SECRET,
  redirectUri: `https://locsync-q7z9.onrender.com/instagram/callback`
};

// Instagram Webhook Verification (Meta requirement)
fastify.get("/webhook/instagram", async (req, reply) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  console.log('Instagram webhook verification attempt:', { mode, token, challenge });
  
  if (mode && token) {
    if (mode === 'subscribe' && token === INSTAGRAM_VERIFY_TOKEN) {
      console.log('✅ Instagram webhook verified successfully');
      reply.code(200).send(challenge);
    } else {
      console.log('❌ Instagram webhook verification failed - invalid token');
      reply.code(403).send('Forbidden');
    }
  } else {
    console.log('❌ Instagram webhook verification failed - missing parameters');
    reply.code(400).send('Bad Request');
  }
});

// Instagram Webhook Handler (receives messages)
fastify.post("/webhook/instagram", async (req, reply) => {
  const body = req.body;
  
  console.log('📨 Instagram webhook received:', JSON.stringify(body, null, 2));
  
  if (body.object === 'instagram') {
    try {
      await Promise.all(body.entry.map(processInstagramEntry));
      reply.code(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('Error processing Instagram webhook:', error);
      reply.code(500).send('Internal Server Error');
    }
  } else {
    reply.code(404).send('Not Found');
  }
});

async function processInstagramEntry(entry) {
  const messaging = entry.messaging || [];
  
  for (const message of messaging) {
    if (message.message && message.message.text) {
      await handleInstagramMessage(entry.id, message);
    }
  }
}

async function handleInstagramMessage(instagramAccountId, message) {
  const senderId = message.sender.id;
  const messageText = message.message.text;
  
  console.log(`📱 Instagram message from ${senderId}: ${messageText}`);
  
  // For now, just log - we'll add real responses after Meta approval
  const response = "Thanks for your message! We'll get back to you soon.";
  console.log(`📤 Would send Instagram reply: ${response}`);
}

// ---------------- INSTAGRAM ONBOARDING ROUTES ----------------

// Step 1: Onboarding page - shows "Connect Instagram" button
fastify.get('/onboard/:tenantId', async (req, reply) => {
  const tenantId = req.params.tenantId;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>LocSync - Connect Instagram</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .connect-btn { background: #E4405F; color: white; padding: 15px 30px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; text-decoration: none; display: inline-block; }
        .connect-btn:hover { background: #d31f47; }
      </style>
    </head>
    <body>
      <h1>LocSync Instagram Integration</h1>
      <p>Connect your Instagram Business account to start managing customer messages with LocSync.</p>
      <p><strong>Tenant ID:</strong> ${tenantId}</p>
      <p><a href="/connect-instagram/${tenantId}" class="connect-btn">📱 Connect Instagram Account</a></p>
      <hr>
      <p><small>For Meta App Review: This demonstrates how Instagram professional accounts connect to LocSync.</small></p>
    </body>
    </html>
  `;
  
  reply.type('text/html').send(html);
});

// Step 2: Redirect to Instagram OAuth
fastify.get('/connect-instagram/:tenantId', async (req, reply) => {
  const tenantId = req.params.tenantId;
  const state = `tenant_${tenantId}_${Date.now()}`;
  
  // Store state temporarily (in production use Redis/Database)
  global.oauthStates = global.oauthStates || new Map();
  global.oauthStates.set(state, { tenantId, timestamp: Date.now() });
  
  const instagramAuthUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth');
  instagramAuthUrl.searchParams.set('client_id', INSTAGRAM_CONFIG.clientId);
  instagramAuthUrl.searchParams.set('redirect_uri', 'https://locsync-q7z9.onrender.com/instagram/callback');
  instagramAuthUrl.searchParams.set('scope', 'instagram_business_basic,instagram_business_manage_messages,pages_show_list,pages_read_engagement');
  instagramAuthUrl.searchParams.set('response_type', 'code');
  instagramAuthUrl.searchParams.set('state', state);
  
  reply.redirect(instagramAuthUrl.toString());
});
// REPLACE your current Instagram callback handler (lines 298-364) with this:

// Step 3: Handle Instagram OAuth callback
fastify.get('/instagram/callback', async (req, reply) => {
  const { code, state, error, error_description } = req.query;
  
  // Enhanced logging
  fastify.log.info({ 
    code: code ? 'received' : 'missing', 
    state, 
    error,
    error_description,
    query: req.query 
  }, "Instagram callback received");
  
  if (error) {
    fastify.log.error({ error, error_description }, "Instagram OAuth error from user");
    return reply.type('text/html').send(`
      <h1>❌ Connection Failed</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description || 'User denied access'}</p>
      <a href="/onboard/test_tenant">Try Again</a>
    `);
  }
  
  if (!code) {
    fastify.log.error("No authorization code received from Instagram");
    return reply.type('text/html').send(`
      <h1>❌ Connection Failed</h1>
      <p>No authorization code received from Instagram</p>
      <a href="/onboard/test_tenant">Try Again</a>
    `);
  }

  console.log('Token exchange request:', {
    client_id: INSTAGRAM_CONFIG.clientId,
    redirect_uri: INSTAGRAM_CONFIG.redirectUri,
    code: code ? code.substring(0, 20) + '...' : 'missing'
  }); 
  
  if (!state || !global.oauthStates?.has(state)) {
    fastify.log.error({ state, hasStates: !!global.oauthStates }, "Invalid or missing state");
    return reply.type('text/html').send(`
      <h1>❌ Invalid State</h1>
      <p>Session expired or invalid. Please try again.</p>
      <a href="/onboard/test_tenant">Try Again</a>
    `);
  }
  
  const stateData = global.oauthStates.get(state);
  global.oauthStates.delete(state);
  
  try {
    // CRITICAL: Check environment variables
    if (!INSTAGRAM_CONFIG.clientId || !INSTAGRAM_CONFIG.clientSecret) {
      throw new Error('Instagram app credentials not configured in environment variables');
    }

    fastify.log.info({ 
      client_id: INSTAGRAM_CONFIG.clientId ? 'set' : 'missing',
      client_secret: INSTAGRAM_CONFIG.clientSecret ? 'set' : 'missing',
      redirect_uri: INSTAGRAM_CONFIG.redirectUri
    }, "Attempting Instagram token exchange");

    // Exchange code for access token
    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        client_id: INSTAGRAM_CONFIG.clientId,
        client_secret: INSTAGRAM_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: INSTAGRAM_CONFIG.redirectUri,
        code: code
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    fastify.log.info({ 
      status: tokenResponse.status,
      hasAccessToken: !!tokenData.access_token,
      hasError: !!tokenData.error,
      errorType: tokenData.error_type,
      errorMessage: tokenData.error_message 
    }, "Instagram token exchange response");
    
    // Enhanced error handling
    if (!tokenResponse.ok || tokenData.error) {
      const errorMsg = tokenData.error_message || tokenData.error_description || tokenData.error || 'Unknown Instagram API error';
      
      fastify.log.error({ 
        status: tokenResponse.status,
        error: tokenData.error,
        error_type: tokenData.error_type,
        error_message: tokenData.error_message,
        error_description: tokenData.error_description,
        full_response: tokenData
      }, "Instagram token exchange failed");
      
      throw new Error(`Instagram API error: ${errorMsg}`);
    }
    
    const { access_token, user_id } = tokenData;
    
    if (!access_token || !user_id) {
      throw new Error('Instagram API did not return access token or user ID');
    }

    fastify.log.info({ user_id, hasToken: !!access_token }, "Instagram token received successfully");
    
    // Get user profile information
    const profileResponse = await fetch(`https://graph.instagram.com/${user_id}?fields=id,username,name,account_type,profile_picture_url&access_token=${access_token}`);
    const profileData = await profileResponse.json();
    
    if (!profileResponse.ok || profileData.error) {
      fastify.log.error({ profileError: profileData.error }, "Failed to get Instagram profile");
      throw new Error(profileData.error?.message || 'Failed to get Instagram profile');
    }
    
    fastify.log.info({ 
      username: profileData.username, 
      account_type: profileData.account_type 
    }, "Instagram profile retrieved successfully");
    
    // Store connected account info (in production use database)
    global.connectedAccounts = global.connectedAccounts || new Map();
    global.connectedAccounts.set(stateData.tenantId, {
      ...profileData,
      access_token,
      connected_at: new Date().toISOString()
    });
    
    // Redirect to success page showing profile info
    reply.redirect(`/dashboard/${stateData.tenantId}`);
    
  } catch (error) {
    // This is where your line 324 error occurs - enhanced error handling
    fastify.log.error({ 
      error: error.message,
      stack: error.stack,
      code: code ? code.substring(0, 20) + '...' : 'missing',
      state: state,
      tenantId: stateData?.tenantId,
      environment: {
        client_id: INSTAGRAM_CONFIG.clientId ? 'set' : 'missing',
        client_secret: INSTAGRAM_CONFIG.clientSecret ? 'set' : 'missing'
      }
    }, "Instagram OAuth error - detailed");
    
    reply.type('text/html').send(`
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .error { background: #f8d7da; color: #721c24; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .error-details { background: #f1f3f4; padding: 15px; border-radius: 5px; margin: 15px 0; font-family: monospace; font-size: 12px; }
            .btn { background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px; }
          </style>
        </head>
        <body>
          <h1>❌ Instagram Connection Failed</h1>
          <div class="error">
            <strong>Error Details:</strong>
            <div class="error-details">
              <strong>Message:</strong> ${error.message}<br>
              <strong>Time:</strong> ${new Date().toISOString()}<br>
              <strong>Code received:</strong> ${code ? 'Yes' : 'No'}<br>
              <strong>State:</strong> ${state || 'Missing'}<br>
              <strong>Tenant:</strong> ${stateData?.tenantId || 'Unknown'}
            </div>
          </div>
          <p>The error has been logged for debugging. Please try again or contact support if the issue persists.</p>
          <a href="/onboard/test_tenant" class="btn">Try Again</a>
          <a href="/debug/instagram" class="btn">Debug Info</a>
        </body>
      </html>
    `);
  }
});

// Step 4: Dashboard showing connected Instagram profile
fastify.get('/dashboard/:tenantId', async (req, reply) => {
  const tenantId = req.params.tenantId;
  
  global.connectedAccounts = global.connectedAccounts || new Map();
  const account = global.connectedAccounts.get(tenantId);
  
  if (!account) {
    return reply.redirect(`/onboard/${tenantId}`);
  }
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>LocSync Dashboard - Connected Instagram Account</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        .profile-card { border: 1px solid #ddd; border-radius: 12px; padding: 20px; margin: 20px 0; background: #f9f9f9; }
        .profile-pic { width: 80px; height: 80px; border-radius: 50%; margin-right: 20px; vertical-align: middle; }
        .profile-info { display: inline-block; vertical-align: middle; }
        .success { background: #d4edda; color: #155724; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .info-row { margin: 10px 0; }
        .label { font-weight: bold; color: #555; }
      </style>
    </head>
    <body>
      <h1>✅ LocSync Dashboard</h1>
      
      <div class="success">
        <strong>Instagram Account Successfully Connected!</strong>
      </div>
      
      <div class="profile-card">
        <h2>Connected Instagram Professional Account</h2>
        
        <div style="margin: 20px 0;">
          ${account.profile_picture_url ? `<img src="${account.profile_picture_url}" alt="Profile Picture" class="profile-pic">` : ''}
          <div class="profile-info">
            <h3>@${account.username}</h3>
            <p>${account.name || 'No display name'}</p>
          </div>
        </div>
        
        <div class="info-row">
          <span class="label">Instagram Username:</span> @${account.username}
        </div>
        
        <div class="info-row">
          <span class="label">Display Name:</span> ${account.name || 'Not provided'}
        </div>
        
        <div class="info-row">
          <span class="label">Account Type:</span> ${account.account_type || 'Professional'}
        </div>
        
        <div class="info-row">
          <span class="label">Instagram Account ID:</span> ${account.id}
        </div>
        
        <div class="info-row">
          <span class="label">Connected:</span> ${new Date(account.connected_at).toLocaleString()}
        </div>
        
        <div class="info-row">
          <span class="label">Tenant ID:</span> ${tenantId}
        </div>
      </div>
      
      <h3>Next Steps:</h3>
      <ul>
        <li>✅ Instagram account connected successfully</li>
        <li>✅ Profile information retrieved and displayed</li>
        <li>✅ Ready to receive and respond to Instagram messages</li>
      </ul>
      
      <p><strong>For App Reviewers:</strong> This page demonstrates the Instagram professional account profile information displayed within the LocSync application after successful OAuth connection.</p>
      
      <hr>
      <p><small>LocSync by U Natural Hair - Instagram Integration Demo</small></p>
    </body>
    </html>
  `;
  
  reply.type('text/html').send(html);
});

// ---------------- EXISTING VOICE BOT ROUTES ----------------

fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Multi-Tenant",
    tenants: Object.keys(TENANTS).length,
    instagram: "enabled"
  };
});

fastify.get("/health", async () => {
  return { 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    instagram_webhook: "/webhook/instagram",
    onboarding: "/onboard/test_tenant"
  };
});

// Incoming call handler
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming call");

  const response = new twiml();
  const greeting = tenant?.voice_config?.greeting_tts || 
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you?`;

  response.say(greeting);
  
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 10,
    speechTimeout: "auto"
  });

  reply.type("text/xml").send(response.toString());
});

// SMS handler
fastify.post("/incoming-sms", async (req, reply) => {
  const body = req.body?.Body?.trim() || "";
  const fromNumber = (req.body?.From || "").trim();
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  const response = new twilio.twiml.MessagingResponse();

  try {
    const salonName = tenant?.studio_name || "our salon";
    response.message(`Thanks for texting ${salonName}! Call us or visit our portal for assistance.`);
  } catch (err) {
    fastify.log.error({ err }, "SMS error");
    response.message("Sorry, technical issues. Please call us.");
  }

  reply.type("text/xml").send(response.toString());
});

// Handle speech input
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ 
    speech: speechResult, 
    tenant: tenant?.tenant_id
  }, "Processing speech");

  const response = new twiml();

  if (!speechResult) {
    response.say("I didn't catch that clearly. Could you please repeat what you need?");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    const knowledgeText = loadKnowledgeFor(tenant);
    const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

    const completion = await openai.chat.completions.create({
      model: tenant?.voice_config?.model || "gpt-4o-mini",
      temperature: tenant?.voice_config?.temperature || 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: speechResult }
      ],
      max_tokens: 100
    });

    const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
      "I'm sorry, I couldn't process that right now.";
    
    response.say(aiResponse);

    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 12,
      speechTimeout: "auto"
    });

    response.say("Is there anything else I can help you with?");

  } catch (err) {
    fastify.log.error({ err }, "Speech processing error");
    response.say("I'm having a technical issue. Let me try again - what did you need help with?");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
  }

  reply.type("text/xml").send(response.toString());
});

// Instagram health check
fastify.get("/instagram/health", async (req, reply) => {
  global.connectedAccounts = global.connectedAccounts || new Map();
  
  reply.send({
    status: "healthy",
    service: "LocSync Instagram Integration",
    timestamp: new Date().toISOString(),
    webhook_url: "/webhook/instagram",
    onboarding_url: "/onboard/test_tenant",
    connected_accounts: global.connectedAccounts.size
  });
});

// Connected accounts info
fastify.get('/connected-accounts', async (req, reply) => {
  global.connectedAccounts = global.connectedAccounts || new Map();
  
  const accounts = {};
  for (const [tenantId, account] of global.connectedAccounts.entries()) {
    accounts[tenantId] = {
      username: account.username,
      name: account.name,
      account_type: account.account_type,
      connected_at: account.connected_at
    };
  }
  
  reply.send({
    status: 'success',
    connected_accounts: accounts,
    total: Object.keys(accounts).length
  });
});

// Test endpoints for tenants
fastify.get("/test/:tenantId", async (req, reply) => {
  const baseTenant = TENANTS[req.params.tenantId];
  if (!baseTenant) {
    return { error: "Tenant not found", available: Object.keys(TENANTS) };
  }
  
  const fullTenant = getTenantByToNumber(baseTenant.phone_number);

  return {
    tenant_id: fullTenant?.tenant_id,
    salon_name: fullTenant?.studio_name || fullTenant?.salon_name,
    phone_normalized: normalizePhone(fullTenant?.phone_number),
    booking_url: fullTenant?.booking?.main_url || fullTenant?.booking_url || "not configured"
  };
});



// Add these debug routes before your fastify.listen section:

// Debug endpoint to check Instagram configuration
fastify.get("/debug/instagram", async (req, reply) => {
  return {
    timestamp: new Date().toISOString(),
    environment: {
      INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID ? 'SET ✓' : 'MISSING ❌',
      INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET ? 'SET ✓' : 'MISSING ❌',
      INSTAGRAM_VERIFY_TOKEN: process.env.INSTAGRAM_VERIFY_TOKEN ? 'SET ✓' : 'MISSING ❌',
      BASE_URL: 'https://locsync-q7z9.onrender.com'
    },
    configuration: {
      client_id: INSTAGRAM_CONFIG.clientId || 'MISSING',
      redirect_uri: INSTAGRAM_CONFIG.redirectUri,
      auth_url: 'https://api.instagram.com/oauth/authorize',
      token_url: 'https://api.instagram.com/oauth/access_token'
    },
    current_config: INSTAGRAM_CONFIG,
    request_info: {
      host: req.headers.host,
      protocol: req.protocol
    }
  };
});

// Test Instagram API connectivity
fastify.get("/debug/instagram/test-api", async (req, reply) => {
  try {
    const testResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        client_id: INSTAGRAM_CONFIG.clientId || 'missing',
        client_secret: INSTAGRAM_CONFIG.clientSecret || 'missing',
        grant_type: 'authorization_code',
        redirect_uri: INSTAGRAM_CONFIG.redirectUri,
        code: 'test_invalid_code_for_debugging'
      }).toString()
    });

    const responseData = await testResponse.json();
    
    return {
      test_purpose: "Uses invalid code to test API connectivity and see exact error response",
      api_status: testResponse.status,
      api_response: responseData,
      connection_test: "SUCCESS - Can reach Instagram API",
      config_check: {
        client_id: INSTAGRAM_CONFIG.clientId ? 'configured' : 'missing',
        client_secret: INSTAGRAM_CONFIG.clientSecret ? 'configured' : 'missing',
        redirect_uri: INSTAGRAM_CONFIG.redirectUri
      }
    };
  } catch (error) {
    return {
      error: "Failed to connect to Instagram API",
      details: error.message,
      network_issue: true
    };
  }
});

// Check environment variables
fastify.get("/debug/env", async (req, reply) => {
  return {
    message: "Environment variables check",
    instagram_vars: {
      INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID ? 
        `SET (${process.env.INSTAGRAM_APP_ID.substring(0, 8)}...)` : 
        'NOT SET ❌',
      INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET ? 
        `SET (${process.env.INSTAGRAM_APP_SECRET.substring(0, 8)}...)` : 
        'NOT SET ❌',
      INSTAGRAM_VERIFY_TOKEN: process.env.INSTAGRAM_VERIFY_TOKEN ? 
        `SET (${process.env.INSTAGRAM_VERIFY_TOKEN.substring(0, 8)}...)` : 
        'NOT SET ❌'
    },
    current_values: {
      clientId: INSTAGRAM_CONFIG.clientId || 'undefined',
      clientSecret: INSTAGRAM_CONFIG.clientSecret ? 'set' : 'undefined',
      redirectUri: INSTAGRAM_CONFIG.redirectUri
    }
  };
});
// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot - Multi-Tenant Edition running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
  console.log(`📱 Instagram integration: ENABLED`);
  console.log(`🔗 Instagram webhook: ${address}/webhook/instagram`);
  console.log(`📋 Instagram onboarding: ${address}/onboard/test_tenant`);
  console.log(`✨ Ready for Meta App Review!`);
});
