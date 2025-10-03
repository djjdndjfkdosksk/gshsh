// AI Router with multiple Google API support, rate limiting, and automatic failover
// Manages multiple Google API keys and models with intelligent routing

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { 
    getAvailableModels, 
    checkAndIncrementRateLimit, 
    setProviderBackoff,
    incrementJobAttempt 
} = require('./queue-database');

class AIRouter {
    constructor() {
        this.aiInstances = new Map(); // Cache AI instances by API key
        this.lastFailover = new Map(); // Track failover times per provider
    }

    /**
     * Get or create Google AI instance for given API key
     */
    getAIInstance(apiKey) {
        if (!this.aiInstances.has(apiKey)) {
            this.aiInstances.set(apiKey, new GoogleGenerativeAI(apiKey));
        }
        return this.aiInstances.get(apiKey);
    }

    /**
     * Summarize content with automatic model selection and failover
     */
    async summarizeContent(content, maxTokens, fileId, jobId) {
        if (!content || content.trim().length === 0) {
            throw new Error('Content is empty or invalid');
        }

        console.log(`🤖 [${fileId}] Starting AI summarization with router...`);
        console.log(`📏 [${fileId}] Content length: ${content.length} characters`);
        console.log(`🎯 [${fileId}] Max tokens: ${maxTokens}`);

        // Get available models sorted by priority
        const availableModels = await getAvailableModels();
        
        if (availableModels.length === 0) {
            throw new Error('No available AI models configured');
        }

        console.log(`📋 [${fileId}] Found ${availableModels.length} available models`);

        let lastError = null;
        
        // Try each model in order of priority
        for (const model of availableModels) {
            try {
                console.log(`🔄 [${fileId}] Trying model: ${model.model_name} (provider: ${model.provider_name})`);
                
                // Check rate limits (both minute and day)
                const minuteCheck = await this.checkRateLimit(model.id, 'minute');
                if (!minuteCheck.allowed) {
                    console.log(`⏰ [${fileId}] Model ${model.model_name} minute limit exceeded (${minuteCheck.count}/${minuteCheck.limit})`);
                    continue;
                }

                const dayCheck = await this.checkRateLimit(model.id, 'day');
                if (!dayCheck.allowed) {
                    console.log(`📅 [${fileId}] Model ${model.model_name} daily limit exceeded (${dayCheck.count}/${dayCheck.limit})`);
                    continue;
                }

                // Attempt to use this model
                const result = await this.callAIModel(model, content, maxTokens, fileId);
                
                // Record successful attempt
                await incrementJobAttempt(jobId, model.provider_id, model.id, true, null);
                
                console.log(`✅ [${fileId}] Successfully generated summary using ${model.model_name}`);
                return result;

            } catch (error) {
                console.log(`❌ [${fileId}] Model ${model.model_name} failed: ${error.message}`);
                lastError = error;
                
                // Record failed attempt
                await incrementJobAttempt(jobId, model.provider_id, model.id, false, error.message);
                
                // Handle specific error types
                await this.handleModelError(model, error, fileId);
                
                // Continue to next model
                continue;
            }
        }

        // All models failed
        throw new Error(`All available AI models failed. Last error: ${lastError?.message || 'Unknown error'}`);
    }

    /**
     * Check rate limit with atomic increment
     */
    async checkRateLimit(modelId, period) {
        try {
            return await checkAndIncrementRateLimit(modelId, period);
        } catch (error) {
            console.error(`Rate limit check failed for model ${modelId}:`, error);
            return { allowed: false, error: error.message };
        }
    }

    /**
     * Call AI model with the actual Google API
     */
    async callAIModel(model, content, maxTokens, fileId) {
        const ai = this.getAIInstance(model.api_key);
        
        // Create enhanced prompt with formatting instructions
        const fullPrompt = `Summarize this content in English. Use markdown formatting for better readability:

IMPORTANT FORMATTING REQUIREMENTS:
- Use # for main title/heading
- Use ## for important sections  
- Use **bold** for key points
- Use - for bullet points
- Use proper line breaks between sections
- Make the summary well-structured and visually appealing

Content to summarize:

${content}`;

        console.log(`🚀 [${fileId}] Calling ${model.model_name}...`);
        
        // Create model instance with configuration
        const aiModel = ai.getGenerativeModel({ 
            model: model.model_name,
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens: maxTokens
            }
        });

        // Make the API call
        const result = await aiModel.generateContent(fullPrompt);

        // Extract text using modern SDK method
        let summary = '';
        if (result.response) {
            summary = result.response.text();
        }
        
        if (!summary || summary.trim().length === 0) {
            console.error(`[${fileId}] Empty response details:`, {
                hasResponse: !!result.response,
                responseKeys: result.response ? Object.keys(result.response) : [],
                usageMetadata: result.response?.usageMetadata
            });
            throw new Error('AI returned empty summary');
        }

        console.log(`📝 [${fileId}] Generated summary: ${summary.length} characters`);
        return summary.trim();
    }

    /**
     * Handle specific model errors and apply backoff if needed
     */
    async handleModelError(model, error, fileId) {
        const errorMessage = error.message.toLowerCase();
        
        // Handle quota exceeded errors
        if (errorMessage.includes('quota') || errorMessage.includes('rate limit') || 
            errorMessage.includes('429') || error.status === 429) {
            
            console.log(`🚫 [${fileId}] Rate limit hit for provider ${model.provider_name}, applying backoff`);
            
            // Apply backoff for 1 hour
            const backoffUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            await setProviderBackoff(model.provider_id, backoffUntil, 'Rate limit exceeded');
            return;
        }

        // Handle authentication errors
        if (errorMessage.includes('auth') || errorMessage.includes('api key') || 
            errorMessage.includes('unauthorized') || error.status === 401) {
            
            console.log(`🔑 [${fileId}] Authentication error for provider ${model.provider_name}, applying long backoff`);
            
            // Apply longer backoff for auth errors (4 hours)
            const backoffUntil = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
            await setProviderBackoff(model.provider_id, backoffUntil, 'Authentication failed');
            return;
        }

        // Handle service unavailable errors
        if (errorMessage.includes('service unavailable') || errorMessage.includes('503') || 
            errorMessage.includes('502') || errorMessage.includes('500') || 
            error.status >= 500) {
            
            console.log(`🔧 [${fileId}] Service error for provider ${model.provider_name}, applying short backoff`);
            
            // Apply short backoff for service errors (15 minutes)
            const backoffUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            await setProviderBackoff(model.provider_id, backoffUntil, 'Service unavailable');
            return;
        }

        // For other errors, just log them (no backoff)
        console.log(`⚠️ [${fileId}] Unhandled error for ${model.model_name}: ${error.message}`);
    }

    /**
     * Test AI service with specific model
     */
    async testAIModel(modelId) {
        try {
            const models = await getAvailableModels();
            const model = models.find(m => m.id === modelId);
            
            if (!model) {
                throw new Error(`Model ${modelId} not found or not available`);
            }

            const testContent = "This is a test message for AI service verification.";
            const result = await this.callAIModel(model, testContent, 100, 'test');
            
            return {
                success: true,
                model: model.model_name,
                provider: model.provider_name,
                result: result.substr(0, 100) + '...'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get router status and available models
     */
    async getRouterStatus() {
        try {
            const models = await getAvailableModels();
            
            const status = {
                configured: models.length > 0,
                availableModels: models.length,
                providers: [...new Set(models.map(m => m.provider_name))],
                models: models.map(m => ({
                    id: m.id,
                    name: m.model_name,
                    provider: m.provider_name,
                    enabled: !!m.enabled,
                    perMinuteLimit: m.per_minute_limit,
                    perDayLimit: m.per_day_limit
                }))
            };

            return status;
        } catch (error) {
            return {
                configured: false,
                error: error.message,
                availableModels: 0,
                providers: [],
                models: []
            };
        }
    }

    /**
     * Clear all cached AI instances (useful for key rotation)
     */
    clearCache() {
        this.aiInstances.clear();
        this.lastFailover.clear();
        console.log('🧹 AI Router cache cleared');
    }
}

// Create singleton instance
const aiRouter = new AIRouter();

module.exports = {
    AIRouter,
    aiRouter
};
