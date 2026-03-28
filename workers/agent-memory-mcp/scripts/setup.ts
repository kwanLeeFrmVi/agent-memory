#!/usr/bin/env npx tsx
import * as p from '@inquirer/prompts';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

// Colors for terminal
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg: string) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warn: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  step: (msg: string) => console.log(`\n${colors.cyan}▶${colors.reset} ${colors.bright}${msg}${colors.reset}`),
};

const CONFIG_FILE = path.join(os.homedir(), '.agent-memory-mcp.json');

interface Config {
  kvNamespaceId?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  embeddingProvider?: 'openai' | 'cohere' | 'voyage' | 'gemini';
  embeddingModel?: string;
  embeddingDim?: number;
  providerApiKey?: string;
  authUsers?: Array<{ username: string; password_hash: string }>;
  workerName?: string;
}

async function loadConfig(): Promise<Config> {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {};
}

async function saveConfig(config: Config): Promise<void> {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  log.success(`Config saved to ${CONFIG_FILE}`);
}

function checkCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getWranglerCmd(): string {
  return checkCommand('bun') ? 'bunx wrangler' : 'npx wrangler';
}

function runCommand(cmd: string, cwd?: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { 
      cwd: cwd || process.cwd(), 
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, output };
  } catch (e: any) {
    return { success: false, output: e.stdout || e.stderr || e.message };
  }
}

async function getExistingUsers(): Promise<Array<{ username: string; password_hash: string }>> {
  const wranglerCmd = getWranglerCmd();
  const result = runCommand(`${wranglerCmd} secret get AUTH_ALLOWED_USERS --json`);
  if (result.success) {
    try {
      const parsed = JSON.parse(result.output);
      if (parsed?.raw?.value) {
        return JSON.parse(parsed.raw.value);
      }
    } catch {
      // Fallback to trying to parse output directly
      try {
        return JSON.parse(result.output);
      } catch {}
    }
  }
  // Try loading from config file
  const config = await loadConfig();
  return config.authUsers || [];
}

async function updateAuthUsers(users: Array<{ username: string; password_hash: string }>): Promise<boolean> {
  const wranglerCmd = getWranglerCmd();
  const usersJson = JSON.stringify(users);
  log.info('Updating AUTH_ALLOWED_USERS secret...');
  const result = runCommand(`echo '${usersJson}' | ${wranglerCmd} secret put AUTH_ALLOWED_USERS`);
  if (result.success) {
    log.success('Auth users updated successfully');
    // Update local config
    const config = await loadConfig();
    config.authUsers = users.map(u => ({ username: u.username, password_hash: '***' }));
    await saveConfig(config);
    return true;
  } else {
    log.error('Failed to update auth users');
    log.info(result.output);
    return false;
  }
}

async function manageUsers() {
  console.log(`\n${colors.bright}${colors.cyan}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}║           User Management - Add/Remove Users              ║${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╚══════════════════════════════════════════════════════════╝${colors.reset}\n`);

  let users = await getExistingUsers();
  let running = true;

  while (running) {
    // Display current users
    log.step('Current Users');
    if (users.length === 0) {
      console.log('  (No users configured)');
    } else {
      users.forEach((u, i) => {
        console.log(`  ${i + 1}. ${colors.cyan}${u.username}${colors.reset}`);
      });
    }
    console.log('');

    const action = await p.select({
      message: 'Choose an action:',
      choices: [
        { name: '➕ Add new user', value: 'add' },
        { name: '➖ Remove user', value: 'remove', disabled: users.length === 0 },
        { name: '✅ Done', value: 'done' },
      ],
    });

    switch (action) {
      case 'add': {
        const username = await p.input({
          message: 'Username:',
          validate: (value: string) => {
            if (value.length < 1) return 'Username is required';
            if (users.some(u => u.username === value)) return 'Username already exists';
            return true;
          },
        });

        const password = await p.password({
          message: 'Password:',
          mask: '*',
          validate: (value: string) => value.length >= 8 || 'Password must be at least 8 characters',
        });

        const passwordHash = generatePasswordHash(password);
        users.push({ username, password_hash: passwordHash });
        log.success(`User "${username}" added`);

        const shouldUpdate = await p.confirm({
          message: 'Update secret now?',
          default: true,
        });

        if (shouldUpdate) {
          await updateAuthUsers(users);
        }
        break;
      }

      case 'remove': {
        const userToRemove = await p.select({
          message: 'Select user to remove:',
          choices: users.map((u, i) => ({
            name: `${i + 1}. ${u.username}`,
            value: i,
          })),
        });

        const confirmRemove = await p.confirm({
          message: `Remove user "${users[userToRemove].username}"?`,
          default: false,
        });

        if (confirmRemove) {
          const removed = users.splice(userToRemove, 1)[0];
          log.success(`User "${removed.username}" removed`);

          const shouldUpdate = await p.confirm({
            message: 'Update secret now?',
            default: true,
          });

          if (shouldUpdate) {
            await updateAuthUsers(users);
          }
        }
        break;
      }

      case 'done':
        running = false;
        break;
    }

    console.log('');
  }

  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}User management complete!${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════${colors.reset}\n`);
}

function generatePasswordHash(password: string): string {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `sha256:${salt}:${hash}`;
}

async function main() {
  console.log(`\n${colors.bright}${colors.cyan}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}║     Agent Memory MCP Server - Cloudflare Setup Wizard    ║${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╚══════════════════════════════════════════════════════════╝${colors.reset}\n`);

  // Check for command line args or prompt for mode
  const mode = await p.select({
    message: 'What would you like to do?',
    choices: [
      { name: '🔧 Full Setup - Configure everything from scratch', value: 'setup' },
      { name: '👤 Manage Users - Quick add/remove users only', value: 'users' },
    ],
    default: 'setup',
  });

  if (mode === 'users') {
    const wranglerCmd = getWranglerCmd();
    // Quick check for Cloudflare auth
    const whoami = runCommand(`${wranglerCmd} whoami`);
    if (!whoami.success) {
      log.error('Not logged in to Cloudflare. Please run setup first.');
      process.exit(1);
    }
    await manageUsers();
    return;
  }

  // Load existing config
  const existingConfig = await loadConfig();
  
  // Check prerequisites
  log.step('Checking prerequisites...');
  
  const hasBun = checkCommand('bun');
  if (!hasBun && !checkCommand('node')) {
    log.error('Bun or Node.js is required. Please install one first.');
    process.exit(1);
  }
  log.success(hasBun ? 'Bun is installed' : 'Node.js is installed');

  const wranglerCmd = getWranglerCmd();
  log.success(`Will use: ${wranglerCmd}`);

  // Check if already logged in to Cloudflare
  log.step('Checking Cloudflare authentication...');
  const whoami = runCommand(`${wranglerCmd} whoami`);
  if (!whoami.success) {
    log.warn('Not logged in to Cloudflare. Starting login...');
    console.log('');
    const login = runCommand(`${wranglerCmd} login`);
    if (!login.success) {
      log.error(`Failed to login. Please run \`${wranglerCmd} login\` manually.`);
      process.exit(1);
    }
    log.success('Logged in to Cloudflare');
  } else {
    log.success(`Already logged in: ${whoami.output.split('\n')[0]}`);
  }

  // Step 1: Worker name
  log.step('Configure Worker');
  const workerName = await p.input({
    message: 'Worker name:',
    default: existingConfig.workerName || 'agent-memory-mcp',
    validate: (value: string) => /^[a-z][a-z0-9-]*$/.test(value) || 'Name must start with lowercase letter and contain only lowercase letters, numbers, and hyphens',
  });

  // Step 2: KV Namespace
  log.step('KV Namespace Setup');
  const createKV = await p.confirm({
    message: 'Create new KV namespace?',
    default: !existingConfig.kvNamespaceId,
  });

  let kvNamespaceId: string;
  if (createKV) {
    log.info('Creating KV namespace...');
    const result = runCommand(`${wranglerCmd} kv namespace create OAUTH_KV`);
    
    // Parse the namespace ID from output
    const idMatch = result.output.match(/id = "([^"]+)"/);
    if (idMatch) {
      kvNamespaceId = idMatch[1];
      log.success(`Created KV namespace: ${kvNamespaceId}`);
    } else {
      log.error('Failed to create KV namespace');
      log.info('Output: ' + result.output);
      kvNamespaceId = await p.input({
        message: 'Enter KV namespace ID manually:',
        default: existingConfig.kvNamespaceId || '',
      });
    }
  } else {
    kvNamespaceId = await p.input({
      message: 'Enter existing KV namespace ID:',
      default: existingConfig.kvNamespaceId || '',
    });
  }

  // Step 3: Supabase
  log.step('Supabase Configuration');
  const supabaseUrl = await p.input({
    message: 'Supabase URL:',
    default: existingConfig.supabaseUrl || '',
    validate: (value: string) => value.startsWith('https://') || 'URL must start with https://',
  });
  
  const supabaseServiceKey = await p.password({
    message: 'Supabase API Private Key (Project Settings → API Keys → New Secret Key):',
    mask: '*',
  });

  // Step 4: Embedding Provider
  log.step('Embedding Provider Configuration');
  const embeddingProvider: Config['embeddingProvider'] = await p.select({
    message: 'Select embedding provider:',
    choices: [
      { name: 'OpenAI (text-embedding-3-small)', value: 'openai' },
      { name: 'Cohere', value: 'cohere' },
      { name: 'Voyage', value: 'voyage' },
      { name: 'Gemini', value: 'gemini' },
    ],
    default: existingConfig.embeddingProvider || 'openai',
  });

  let embeddingModel: string;
  let embeddingDim: number;
  
  switch (embeddingProvider) {
    case 'openai':
      embeddingModel = await p.select({
        message: 'Select embedding model:',
        choices: [
          { name: 'text-embedding-3-small (1536 dim)', value: 'text-embedding-3-small' },
          { name: 'text-embedding-3-large (3072 dim)', value: 'text-embedding-3-large' },
          { name: 'text-embedding-ada-002 (1536 dim)', value: 'text-embedding-ada-002' },
        ],
        default: existingConfig.embeddingModel || 'text-embedding-3-small',
      });
      embeddingDim = embeddingModel === 'text-embedding-3-large' ? 3072 : 1536;
      break;
    case 'cohere':
      embeddingModel = await p.input({
        message: 'Cohere model name:',
        default: existingConfig.embeddingModel || 'embed-english-v3.0',
      });
      embeddingDim = await p.number({
        message: 'Embedding dimension:',
        default: existingConfig.embeddingDim || 1024,
      }) || 1024;
      break;
    case 'voyage':
      embeddingModel = await p.input({
        message: 'Voyage model name:',
        default: existingConfig.embeddingModel || 'voyage-3',
      });
      embeddingDim = await p.number({
        message: 'Embedding dimension:',
        default: existingConfig.embeddingDim || 1024,
      }) || 1024;
      break;
    case 'gemini':
      embeddingModel = await p.input({
        message: 'Gemini model name:',
        default: existingConfig.embeddingModel || 'text-embedding-004',
      });
      embeddingDim = await p.number({
        message: 'Embedding dimension:',
        default: existingConfig.embeddingDim || 768,
      }) || 768;
      break;
    default:
      embeddingModel = 'text-embedding-3-small';
      embeddingDim = 1536;
  }

  const providerApiKey = await p.password({
    message: `${embeddingProvider.charAt(0).toUpperCase() + embeddingProvider.slice(1)} API Key:`,
    mask: '*',
  });

  // Step 5: Auth Users
  log.step('Authentication Configuration');
  const setupAuth = await p.confirm({
    message: 'Configure authentication users?',
    default: true,
  });

  const authUsers: Array<{ username: string; password_hash: string }> = [];
  
  if (setupAuth) {
    let addMore = true;
    while (addMore) {
      const username = await p.input({
        message: 'Username:',
        validate: (value: string) => value.length >= 1 || 'Username is required',
      });
      
      const password = await p.password({
        message: 'Password:',
        mask: '*',
        validate: (value: string) => value.length >= 8 || 'Password must be at least 8 characters',
      });

      const passwordHash = generatePasswordHash(password);
      authUsers.push({ username, password_hash: passwordHash });
      log.success(`User "${username}" configured`);

      addMore = await p.confirm({
        message: 'Add another user?',
        default: false,
      });
    }
  }

  // Step 6: Update wrangler.toml
  log.step('Updating wrangler.toml');
  const wranglerPath = path.join(process.cwd(), 'wrangler.toml');
  let wranglerContent = fs.readFileSync(wranglerPath, 'utf-8');
  
  // Update worker name
  wranglerContent = wranglerContent.replace(/^name = ".*"/m, `name = "${workerName}"`);
  
  // Update KV namespace ID
  wranglerContent = wranglerContent.replace(
    /\[\[kv_namespaces\]\][\s\S]*?id = ".*"/,
    `[[kv_namespaces]]\nbinding = "OAUTH_KV"\nid = "${kvNamespaceId}"`
  );
  
  fs.writeFileSync(wranglerPath, wranglerContent);
  log.success('Updated wrangler.toml');

  // Step 7: Set secrets
  log.step('Setting Cloudflare secrets');
  
  const secrets: Record<string, string> = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_KEY: supabaseServiceKey,
    EMBEDDING_PROVIDER: embeddingProvider,
    EMBEDDING_MODEL: embeddingModel,
    EMBEDDING_DIM: String(embeddingDim),
  };

  // Add provider API key
  const apiKeyName = embeddingProvider.toUpperCase() + '_API_KEY';
  secrets[apiKeyName] = providerApiKey;

  // Add auth users
  if (authUsers.length > 0) {
    secrets.AUTH_ALLOWED_USERS = JSON.stringify(authUsers);
  }

  const setSecrets = await p.confirm({
    message: 'Set secrets now? (Recommended)',
    default: true,
  });

  if (setSecrets) {
    for (const [name, value] of Object.entries(secrets)) {
      if (value) {
        log.info(`Setting ${name}...`);
        const result = runCommand(`echo "${value}" | ${wranglerCmd} secret put ${name}`);
        if (result.success) {
          log.success(`${name} set`);
        } else {
          log.error(`Failed to set ${name}`);
          log.info(result.output);
        }
      }
    }
  }

  // Save config for future use
  const config: Config = {
    workerName,
    kvNamespaceId,
    supabaseUrl,
    embeddingProvider,
    embeddingModel,
    embeddingDim,
    authUsers: authUsers.map(u => ({ username: u.username, password_hash: '***' })),
  };
  await saveConfig(config);

  // Step 8: Deploy
  log.step('Deployment');
  const deploy = await p.confirm({
    message: 'Deploy now?',
    default: true,
  });

  if (deploy) {
    log.info('Deploying to Cloudflare Workers...');
    const result = runCommand(`${wranglerCmd} deploy`);
    if (result.success) {
      log.success('Deployed successfully!');
      
      // Extract URL from output
      const urlMatch = result.output.match(/https:\/\/[^\s]+\.workers\.dev/);
      if (urlMatch) {
        const workerUrl = urlMatch[0];
        console.log(`\n${colors.bright}${colors.green}✓ Your MCP server is live at:${colors.reset}`);
        console.log(`${colors.cyan}  ${workerUrl}${colors.reset}\n`);
        console.log(`${colors.bright}Endpoints:${colors.reset}`);
        console.log(`  MCP:           ${workerUrl}/mcp`);
        console.log(`  MCP (SSE):     ${workerUrl}/mcp/sse`);
        console.log(`  OAuth:         ${workerUrl}/.well-known/oauth-authorization-server\n`);

        // Output mcpServer config JSON
        const mcpConfig = {
          mcpServers: {
            'agent-memory': {
              url: `${workerUrl}/mcp/sse`,
            },
          },
        };
        console.log(`${colors.bright}MCP Server Config (JSON):${colors.reset}`);
        console.log(`${colors.cyan}${JSON.stringify(mcpConfig, null, 2)}${colors.reset}\n`);
      }
    } else {
      log.error('Deployment failed');
      log.info(result.output);
    }
  }

  // Summary
  console.log(`\n${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}Setup Complete!${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}══════════════════════════════════════════════════════════${colors.reset}\n`);

  const pkgMgr = hasBun ? 'bun' : 'npm';
  const npxCmd = hasBun ? 'bunx' : 'npx';
  
  console.log(`${colors.bright}Next steps:${colors.reset}`);
  console.log(`  1. Test locally:     ${colors.cyan}${pkgMgr} run dev${colors.reset}`);
  console.log(`  2. Test with MCP Inspector:`);
  console.log(`     ${colors.cyan}${npxCmd} @modelcontextprotocol/inspector http://localhost:8787/mcp${colors.reset}`);
  console.log(`  3. Add to Claude Chat with your worker URL\n`);

  console.log(`${colors.bright}Configuration saved to:${colors.reset} ${CONFIG_FILE}`);
  console.log(`${colors.bright}To reconfigure, run:${colors.reset} ${colors.cyan}${pkgMgr} run setup${colors.reset}\n`);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
