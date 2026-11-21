const fs = require('fs');
const path = require('path');

const TRUEFORGE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8790';

// 1. Read key from CLI argument, environment, or .env file
let groqApiKey = process.argv[2] || process.env.GROQ_API_KEY;

if (!groqApiKey) {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('GROQ_API_KEY=')) {
        groqApiKey = trimmed.replace('GROQ_API_KEY=', '').trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  }
}

if (!groqApiKey || !groqApiKey.startsWith('gsk_')) {
  console.error('\x1b[31m[Error] Please provide a valid Groq API key (starts with "gsk_").\x1b[0m');
  console.log('Usage:');
  console.log('  1. Either add GROQ_API_KEY=gsk_... to forge-extension/.env');
  console.log('  2. Or run: node configure_groq.js gsk_your_key_here\n');
  process.exit(1);
}

async function configureGroq() {
  console.log(`\x1b[36m[Groq Setup] Registering Groq provider in TrueForge (${TRUEFORGE_URL})...\x1b[0m`);

  const providerPayload = {
    manifest: {
      type: 'custom',
      name: 'groq',
      base_url: 'https://api.groq.com/openai/v1',
      auth: {
        api_key: groqApiKey,
      },
      models: [
        {
          model_id: 'openai/gpt-oss-120b',
          name: 'gpt-oss-120b',
          properties: {
            context_length: 131072,
            max_output_tokens: 8192,
          },
        },
        {
          model_id: 'qwen/qwen3.8-27b',
          name: 'qwen-3-8-27b',
          properties: {
            context_length: 131072,
            max_output_tokens: 8192,
          },
        },
      ],
    },
  };

  // Register provider
  const provRes = await fetch(`${TRUEFORGE_URL}/api/v1/settings/model-providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(providerPayload),
  });

  if (!provRes.ok && provRes.status !== 409) {
    const errText = await provRes.text();
    console.error(`\x1b[31m[Error] Failed to register Groq provider (${provRes.status}):\x1b[0m`, errText);
    process.exit(1);
  }
  console.log('\x1b[32m[Groq Setup] ✓ Groq provider registered in TrueForge.\x1b[0m');

  // Find fallback agent ID
  const agentsRes = await fetch(`${TRUEFORGE_URL}/api/v1/agents`);
  if (!agentsRes.ok) {
    console.error('\x1b[31m[Error] Failed to fetch agents list.\x1b[0m');
    process.exit(1);
  }

  const agentsJson = await agentsRes.json();
  const fallbackAgent = (agentsJson.data || []).find((a) => a.name === 'forge-coding-agent-fallback');

  if (!fallbackAgent) {
    console.error('\x1b[31m[Error] forge-coding-agent-fallback not found in TrueForge.\x1b[0m');
    process.exit(1);
  }

  // Update fallback agent to use groq/gpt-oss-120b
  const updatedManifest = {
    ...fallbackAgent.manifest,
    model: {
      name: 'groq/gpt-oss-120b',
    },
  };

  const updateRes = await fetch(`${TRUEFORGE_URL}/api/v1/agents/${fallbackAgent.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: updatedManifest }),
  });

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error(`\x1b[31m[Error] Failed to bind fallback agent (${updateRes.status}):\x1b[0m`, errText);
    process.exit(1);
  }

  // Also update agents/forge-coding-agent-fallback.json
  const agentJsonPath = path.join(__dirname, 'agents', 'forge-coding-agent-fallback.json');
  if (fs.existsSync(agentJsonPath)) {
    const localAgent = JSON.parse(fs.readFileSync(agentJsonPath, 'utf8'));
    localAgent.manifest.model.name = 'groq/gpt-oss-120b';
    fs.writeFileSync(agentJsonPath, JSON.stringify(localAgent, null, 2), 'utf8');
  }

  console.log('\x1b[32m[Groq Setup] ✓ Fallback agent (forge-coding-agent-fallback) is now bound to groq/gpt-oss-120b!\x1b[0m');
  console.log('\x1b[36m[Groq Setup] TrueForge resilience configuration is ready for Task C.\x1b[0m');
}

configureGroq().catch((err) => {
  console.error('\x1b[31m[Unexpected Error]:\x1b[0m', err);
});
