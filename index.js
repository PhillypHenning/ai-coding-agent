#!/usr/bin/env node

/**
 * AI Coding Agent
 * 
 * This is an AI coding agent that runs Claude Code while providing it 
 * access tokens for MCP services.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConfigManager } from './src/config/ConfigManager.js';
import { AuthManager } from './src/auth/AuthManager.js';
import { AuthService } from './src/auth/AuthService.js';
import { isServerAuthorized } from './src/auth/authUtils.js';
import { PromptManager } from './src/prompts/PromptManager.js';
import { ClaudeServiceFactory } from './src/services/ClaudeServiceFactory.js';
import { EmailService } from './src/services/EmailService.js';
import { WebUIService } from './src/services/WebUIService.js';
import { ExecutionHistoryService } from './src/services/ExecutionHistoryService.js';
import { AuthMiddleware } from './src/middleware/AuthMiddleware.js';
import { mergeParametersWithDefaults } from './public/js/prompt-utils.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AICodingAgent {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    
    // Initialize services
    this.configManager = new ConfigManager();
    this.authManager = new AuthManager();
    this.promptManager = new PromptManager();
    this.executionHistoryService = new ExecutionHistoryService();
    this.claudeService = ClaudeServiceFactory.create(this.executionHistoryService);
    this.emailService = new EmailService();
    this.authService = new AuthService(this.emailService);
    this.webUIService = new WebUIService();
    this.authMiddleware = new AuthMiddleware(this.authService);
  }

  /**
   * Merge request parameters with default values from prompt schema
   * @deprecated Use shared utility from prompt-utils.js instead
   */
  mergeParametersWithDefaults(prompt, requestParameters = {}) {
    return mergeParametersWithDefaults(prompt, requestParameters);
  }

  async initialize() {
    try {
      // Validate Claude service configuration
      const serviceValidation = await ClaudeServiceFactory.validateConfiguration();
      console.log(`🔧 Claude Service: ${serviceValidation.serviceType}`);
      for (const message of serviceValidation.messages) {
        console.log(`   ${message}`);
      }
      
      if (!serviceValidation.isValid) {
        console.error('❌ Claude service configuration is invalid');
        const instructions = ClaudeServiceFactory.getConfigurationInstructions();
        console.log('\\n📖 Configuration Instructions:');
        console.log(`   ${instructions.title}`);
        for (const instruction of instructions.instructions) {
          console.log(`   ${instruction}`);
        }
        process.exit(1);
      }
      
      // Load configurations
      await this.configManager.loadConfigurations();
      await this.promptManager.loadPrompts();
      
      // Setup middleware
      this.setupMiddleware();
      
      // Setup routes
      this.setupRoutes();
      
      console.log('✅ AI Coding Agent initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize AI Coding Agent:', error);
      process.exit(1);
    }
  }

  setupMiddleware() {
    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Serve static files
    this.app.use('/static', express.static(path.join(__dirname, 'public')));
    
    // CORS for development
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  setupRoutes() {
    // Authentication routes
    this.app.get('/login', (req, res) => {
      this.webUIService.renderLoginPage(req, res);
    });

    this.app.post('/auth/request-login', async (req, res) => {
      try {
        const { email } = req.body;
        
        if (!email) {
          return res.status(400).json({ 
            error: 'Email required',
            message: 'Please provide an email address' 
          });
        }

        const result = await this.authService.requestMagicLink(email);
        res.json(result);
      } catch (error) {
        console.error('❌ Magic link request error:', error);
        res.status(400).json({ 
          error: 'Login request failed',
          message: error.message 
        });
      }
    });

    this.app.get('/auth/login', async (req, res) => {
      try {
        const { token } = req.query;
        
        if (!token) {
          return res.redirect('/login?error=invalid_token');
        }

        const loginResult = await this.authService.verifyMagicLink(token);
        
        // Set session cookie
        this.authMiddleware.setSessionCookie(res, loginResult.sessionId);
        
        // Redirect to dashboard with success message
        res.redirect('/?success=login');
      } catch (error) {
        console.error('❌ Magic link verification error:', error);
        let errorCode = 'invalid_token';
        if (error.message.includes('expired')) {
          errorCode = 'expired_token';
        } else if (error.message.includes('used')) {
          errorCode = 'token_used';
        }
        res.redirect(`/login?error=${errorCode}`);
      }
    });

    this.app.post('/auth/logout', (req, res) => {
      const sessionId = this.authMiddleware.getSessionIdFromRequest(req);
      if (sessionId) {
        this.authService.logout(sessionId);
      }
      
      // Clear session cookie
      this.authMiddleware.clearSessionCookie(res);
      
      res.json({ success: true, message: 'Logged out successfully' });
    });

    // Dashboard and protected routes
    this.app.get('/', 
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      (req, res) => {
        this.webUIService.renderIndexPage(req, res, {
          prompts: this.promptManager.getPrompts(),
          mcpServers: this.configManager.getMcpServers(),
          authManager: this.authManager,
          user: req.user
        });
      }
    );

    this.app.get('/index.html', (req, res) => {
      res.redirect('/');
    });

    // Prompt activity page
    this.app.get('/prompts/:promptName/activity.html', 
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      (req, res) => {
        this.webUIService.renderPromptActivityPage(req, res, {
          promptName: req.params.promptName,
          promptManager: this.promptManager,
          executionHistoryService: this.executionHistoryService
        });
      }
    );

    // MCP authorization endpoint
    this.app.post('/mcp/:mcpName/authorize',
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      async (req, res) => {
        try {
          const mcpName = req.params.mcpName;
          const mcpServer = this.configManager.getMcpServer(mcpName);
          
          if (!mcpServer) {
            return res.status(404).json({ error: 'MCP server not found' });
          }
          
          const authUrl = await this.authManager.initiateAuthorization(mcpServer);
          res.json({ authUrl });
        } catch (error) {
          console.error('❌ Authorization error:', error);
          res.status(500).json({ error: error.message });
        }
      }
    );

    // OAuth callback endpoint
    this.app.get('/oauth/callback', async (req, res) => {
      try {
        await this.authManager.handleOAuthCallback(req, res);
      } catch (error) {
        console.error('❌ OAuth callback error:', error);
        res.status(500).send('OAuth callback failed');
      }
    });

    // Prompt execution endpoint
    this.app.post('/prompt/:promptName/run',
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      async (req, res) => {
        try {
          const promptName = req.params.promptName;
          const requestParameters = req.body.parameters || {};
          
          const prompt = this.promptManager.getPrompt(promptName);
          if (!prompt) {
            return res.status(404).json({ error: 'Prompt not found' });
          }

          // Merge request parameters with defaults from prompt schema
          const parameters = this.mergeParametersWithDefaults(prompt, requestParameters);

          // Check if all required MCP servers are authorized
          const unauthorizedServers = [];
          for (const mcpServerName of prompt.mcp_servers) {
            const mcpServer = this.configManager.getMcpServer(mcpServerName);
            
            // Use the new authUtils function that includes custom credential validation
            const isAuthorized = isServerAuthorized(mcpServerName, mcpServer, this.authManager);
            if (!isAuthorized) {
              unauthorizedServers.push(mcpServerName);
            }
          }

          if (unauthorizedServers.length > 0) {
            // Save prompt for later execution
            this.promptManager.savePendingPrompt(promptName, parameters);
            
            // Send email notification
            await this.emailService.sendAuthorizationNeededEmail(
              process.env.EMAIL,
              unauthorizedServers
            );
            
            return res.status(401).json({
              error: 'Authorization required',
              unauthorizedServers,
              message: 'Please authorize the required MCP servers. An email has been sent with instructions.'
            });
          }

          // Execute the prompt
          const userEmail = req.user?.email || 'unknown';
          await this.claudeService.executePromptStream(
            prompt,
            parameters,
            this.configManager,
            this.authManager,
            res,
            userEmail
          );
          
        } catch (error) {
          console.error('❌ Prompt execution error:', error);
          if (!res.headersSent) {
            res.status(500).json({ error: error.message });
          }
        }
      }
    );

    // Execution history API endpoint
    this.app.get('/api/executions',
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        const promptName = req.query.prompt;
        
        let history;
        if (promptName) {
          history = this.executionHistoryService.getPromptHistory(promptName, limit);
        } else {
          history = this.executionHistoryService.getAllHistory(limit);
        }
        
        const stats = this.executionHistoryService.getStats();
        
        res.json({
          stats,
          executions: history
        });
      }
    );

    // Individual execution details API
    this.app.get('/api/executions/:executionId',
      this.authMiddleware.authenticate.bind(this.authMiddleware),
      (req, res) => {
        const execution = this.executionHistoryService.getExecution(req.params.executionId);
        if (!execution) {
          return res.status(404).json({ error: 'Execution not found' });
        }
        res.json(execution);
      }
    );

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Claude service management endpoints
    this.app.get('/api/claude/service', (req, res) => {
      const serviceType = ClaudeServiceFactory.getServiceType();
      const capabilities = ClaudeServiceFactory.getServiceCapabilities();
      
      res.json({
        currentService: serviceType,
        capabilities: capabilities[serviceType],
        allCapabilities: capabilities
      });
    });

    this.app.post('/api/claude/service/validate', async (req, res) => {
      try {
        const validation = await ClaudeServiceFactory.validateConfiguration();
        res.json(validation);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/claude/service/switch', async (req, res) => {
      try {
        const { serviceType } = req.body;
        
        if (!serviceType || !['claude-sdk', 'claude-code'].includes(serviceType)) {
          return res.status(400).json({ 
            error: 'Invalid service type. Must be "claude-sdk" or "claude-code"' 
          });
        }

        const result = await ClaudeServiceFactory.switchServiceType(serviceType);
        
        if (result.success) {
          // Recreate the service instance
          this.claudeService = ClaudeServiceFactory.create(this.executionHistoryService);
          console.log(`🔄 Switched Claude service to: ${serviceType}`);
        }
        
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/claude/service/instructions', (req, res) => {
      const instructions = ClaudeServiceFactory.getConfigurationInstructions();
      res.json(instructions);
    });

    // Claude Code specific endpoints (only available when using Claude Code)
    this.app.get('/api/claude/mcp/servers', async (req, res) => {
      if (ClaudeServiceFactory.getServiceType() !== 'claude-code') {
        return res.status(400).json({ 
          error: 'MCP server management only available with Claude Code service' 
        });
      }

      try {
        const servers = await this.claudeService.listMcpServers();
        res.json({ servers: servers.split('\n').filter(s => s.trim()) });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/claude/mcp/servers', async (req, res) => {
      if (ClaudeServiceFactory.getServiceType() !== 'claude-code') {
        return res.status(400).json({ 
          error: 'MCP server management only available with Claude Code service' 
        });
      }

      try {
        const { name, config, scope = 'local' } = req.body;
        
        if (!name || !config) {
          return res.status(400).json({ 
            error: 'Server name and config are required' 
          });
        }

        const result = await this.claudeService.addMcpServer(name, config, scope);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.delete('/api/claude/mcp/servers/:name', async (req, res) => {
      if (ClaudeServiceFactory.getServiceType() !== 'claude-code') {
        return res.status(400).json({ 
          error: 'MCP server management only available with Claude Code service' 
        });
      }

      try {
        const { name } = req.params;
        const result = await this.claudeService.removeMcpServer(name);
        res.json({ success: true, output: result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  async start() {
    await this.initialize();
    
    this.app.listen(this.port, () => {
      console.log(`🚀 AI Coding Agent listening on port ${this.port}`);
      console.log(`📋 Dashboard: http://localhost:${this.port}`);
    });
  }
}

// Start the application
const agent = new AICodingAgent();
agent.start().catch(console.error);
