const fs = require('fs');
const path = require('path');

const TRUEFORGE_URL = process.env.TRUEFORGE_URL || 'http://localhost:8790';

async function registerAgent(filePath) {
  const agentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`[TrueForge Loader] Checking agent: ${agentData.name}...`);

  try {
    const listRes = await fetch(`${TRUEFORGE_URL}/api/v1/agents`);
    if (listRes.ok) {
      const listJson = await listRes.json();
      const existing = (listJson.data || []).find((a) => a.name === agentData.name);
      if (existing) {
        console.log(`[TrueForge Loader] ✓ Agent '${agentData.name}' is already active and ready (id: ${existing.id}).`);
        return;
      }
    }

    const res = await fetch(`${TRUEFORGE_URL}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentData),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[TrueForge Loader] Could not register ${agentData.name} (${res.status}): ${text}`);
    } else {
      console.log(`[TrueForge Loader] ✓ Successfully registered '${agentData.name}'`);
    }
  } catch (err) {
    console.error(`[TrueForge Loader] Error registering ${agentData.name}:`, err.message);
  }
}

async function main() {
  console.log(`[TrueForge Loader] Connecting to ${TRUEFORGE_URL}...`);
  const agentsDir = path.join(__dirname, 'agents');
  const agentFiles = ['forge-coding-agent.json', 'forge-coding-agent-fallback.json'];

  for (const file of agentFiles) {
    const fullPath = path.join(agentsDir, file);
    if (fs.existsSync(fullPath)) {
      await registerAgent(fullPath);
    }
  }
  console.log('[TrueForge Loader] Done! All agents configured.');
}

main();
