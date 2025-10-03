// Simplified AI Service - Fast and Robust
// Direct model switching without complex queue system

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ModelCache } = require('./config');

class SimplifiedAIService {
    constructor() {
        this.modelCache = new ModelCache();
        this.aiInstances = new Map();
        this.rateLimits = new Map(); // Simple in-memory rate limiting
        this.initialize();
    }

    initialize() {
        // Get API keys from environment
        this.apiKeys = [
            process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
            process.env.GOOGLE_API_KEY_2 || process.env.GEMINI_API_KEY_2
        ].filter(Boolean);

        if (this.apiKeys.length === 0) {
            throw new Error('No API keys configured. Please set GOOGLE_API_KEY or GEMINI_API_KEY');
        }

        console.log(`🔑 Initialized with ${this.apiKeys.length} API key(s)`);
        
        // Initialize AI instances
        this.apiKeys.forEach((key, index) => {
            this.aiInstances.set(`api-${index}`, new GoogleGenerativeAI(key));
        });
    }

    // Fast rate limiting check (in-memory)
    checkRateLimit(modelName, apiKeyIndex) {
        const model = this.modelCache.getModelByName(modelName);
        if (!model) return false;

        const key = `${modelName}-${apiKeyIndex}`;
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        
        if (!this.rateLimits.has(key)) {
            this.rateLimits.set(key, { minute, count: 0 });
        }
        
        const limit = this.rateLimits.get(key);
        
        // Reset if new minute
        if (limit.minute !== minute) {
            limit.minute = minute;
            limit.count = 0;
        }
        
        // Check if under limit
        if (limit.count >= model.perMinuteLimit) {
            return false;
        }
        
        limit.count++;
        return true;
    }

    // Main summarization method with robust error handling
    async summarizeContent(content, maxTokens, requestId) {
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            throw new Error('Content is empty or invalid');
        }

        console.log(`🤖 [${requestId}] Starting AI summarization...`);
        console.log(`📏 [${requestId}] Content length: ${content.length} characters`);
        console.log(`🎯 [${requestId}] Max tokens: ${maxTokens}`);

        const availableModels = this.modelCache.getAvailableModels();
        const errors = [];
        
        // Try each model in priority order
        for (const model of availableModels) {
            if (!this.modelCache.isModelAvailable(model.name)) {
                console.log(`⏭️ [${requestId}] Skipping ${model.name} - temporarily unavailable`);
                continue;
            }

            // Try each API key for this model
            for (let keyIndex = 0; keyIndex < this.apiKeys.length; keyIndex++) {
                try {
                    console.log(`🔄 [${requestId}] Trying ${model.name} with API key ${keyIndex + 1}`);
                    
                    // Check rate limit
                    if (!this.checkRateLimit(model.name, keyIndex)) {
                        console.log(`⏰ [${requestId}] Rate limit exceeded for ${model.name}`);
                        continue;
                    }

                    const result = await this.callAIModel(model.name, content, maxTokens, keyIndex, requestId);
                    
                    console.log(`✅ [${requestId}] Success with ${model.name}`);
                    return result;
                    
                } catch (error) {
                    const errorMsg = `${model.name} (key ${keyIndex + 1}): ${error.message}`;
                    errors.push(errorMsg);
                    console.log(`❌ [${requestId}] ${errorMsg}`);
                    
                    // Mark model as temporarily unavailable on certain errors
                    if (error.message.includes('quota') || error.message.includes('limit')) {
                        this.modelCache.markModelError(model.name, error.message);
                    }
                }
            }
        }

        // If all models failed
        throw new Error(`All AI models failed. Errors: ${errors.join('; ')}`);
    }

    // Direct AI model call
    async callAIModel(modelName, content, maxTokens, keyIndex, requestId) {
        const aiInstance = this.aiInstances.get(`api-${keyIndex}`);
        if (!aiInstance) {
            throw new Error(`AI instance not found for key ${keyIndex}`);
        }

        const model = aiInstance.getGenerativeModel({ 
            model: modelName,
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens: maxTokens
            }
        });
        
        const prompt = `Summarize the following content in English using markdown formatting:

FORMAT REQUIREMENTS:
- Use # for main title/heading
- Use ## for important sections  
- Use **bold** for key points
- Use - for bullet points
- Use proper line breaks between sections

CONTENT TO SUMMARIZE:

${content}

Please provide a comprehensive and useful summary that covers all key points.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const summary = response.text();

        if (!summary || summary.trim().length === 0) {
            throw new Error('Empty response from AI model');
        }

        console.log(`📄 [${requestId}] Generated summary: ${summary.length} characters`);
        return summary.trim();
    }

    // Get service status
    getStatus() {
        const models = this.modelCache.getAvailableModels();
        const availableModels = models.filter(m => this.modelCache.isModelAvailable(m.name));
        
        return {
            configured: this.apiKeys.length > 0,
            apiKeys: this.apiKeys.length,
            totalModels: models.length,
            availableModels: availableModels.length,
            models: availableModels.map(m => ({
                name: m.name,
                priority: m.priority,
                available: this.modelCache.isModelAvailable(m.name)
            }))
        };
    }

    // Clear error cache (for recovery)
    clearErrors() {
        this.modelCache.errors.clear();
        console.log('🧹 AI service error cache cleared');
    }
}

// Legacy functions for backward compatibility
async function summarizeContent(content, maxTokens, fileId) {
    return await aiService.summarizeContent(content, maxTokens, fileId);
}

async function testAIService() {
    try {
        const testContent = "This is a test content for verifying AI service connectivity.";
        const testSummary = await aiService.summarizeContent(testContent, 400, 'test');
        
        console.log('✓ AI service test successful');
        console.log('Test summary:', testSummary);
        
        return true;
    } catch (error) {
        console.error('✗ AI service test failed:', error.message);
        return false;
    }
}

function getServiceStatus() {
    return aiService.getStatus();
}

// Export singleton instance
const aiService = new SimplifiedAIService();

module.exports = {
    SimplifiedAIService,
    aiService,
    // Legacy exports for backward compatibility
    summarizeContent,
    testAIService,
    getServiceStatus
};