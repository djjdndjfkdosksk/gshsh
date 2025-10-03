// Configuration Manager for API providers and models
// Handles setup and management of multiple Google APIs with rate limiting

const { upsertProvider, upsertModel, getAvailableModels } = require('./queue-database');

class ConfigManager {
    constructor() {
        this.defaultModels = [
            {
                name: 'gemini-2.0-flash',
                perMinuteLimit: 10,
                perDayLimit: 200
            },
            {
                name: 'gemini-2.5-flash-lite',
                perMinuteLimit: 10,
                perDayLimit: 200
            },
            {
                name: 'gemini-2.0-flash-lite',
                perMinuteLimit: 10,
                perDayLimit: 200
            }
        ];
    }

    /**
     * Setup API providers and models from environment variables
     */
    async setupFromEnvironment() {
        console.log('🔧 Setting up API configuration from environment...');
        
        try {
            // Setup primary Google API (legacy support)
            const primaryApiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
            if (primaryApiKey) {
                await this.addGoogleProvider('google-primary', 'Google Primary', primaryApiKey, 1);
                console.log('✅ Primary Google API configured');
            }

            // Setup secondary Google API if available
            const secondaryApiKey = process.env.GOOGLE_API_KEY_2 || process.env.GEMINI_API_KEY_2;
            if (secondaryApiKey) {
                await this.addGoogleProvider('google-secondary', 'Google Secondary', secondaryApiKey, 2);
                console.log('✅ Secondary Google API configured');
            }

            // Setup custom API configurations
            await this.setupCustomConfigurations();

            // Add small delay to ensure database writes are visible
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const models = await getAvailableModels();
            console.log(`✅ Configuration complete. ${models.length} models available.`);
            
            return true;
        } catch (error) {
            console.error('❌ Failed to setup configuration:', error);
            return false;
        }
    }

    /**
     * Add a Google API provider with default models
     */
    async addGoogleProvider(providerId, name, apiKey, priority = 1) {
        // Add provider
        await upsertProvider(providerId, name, apiKey, priority, true);
        
        // Add default models for this provider
        for (const model of this.defaultModels) {
            const modelId = `${providerId}-${model.name}`;
            await upsertModel(
                modelId,
                providerId,
                model.name,
                model.perMinuteLimit,
                model.perDayLimit,
                true
            );
            console.log(`📋 Added model: ${model.name} (${model.perMinuteLimit}/min, ${model.perDayLimit}/day)`);
        }
    }

    /**
     * Setup custom API configurations from environment variables
     */
    async setupCustomConfigurations() {
        // Check for custom model configurations
        // Format: MODEL_CONFIG_<PROVIDER>_<MODEL>=minuteLimit,dayLimit
        
        const envKeys = Object.keys(process.env);
        const modelConfigs = envKeys.filter(key => key.startsWith('MODEL_CONFIG_'));
        
        for (const configKey of modelConfigs) {
            try {
                const [, , providerId, modelName] = configKey.split('_');
                const configValue = process.env[configKey];
                const [minuteLimit, dayLimit] = configValue.split(',').map(x => parseInt(x.trim()));
                
                if (providerId && modelName && !isNaN(minuteLimit) && !isNaN(dayLimit)) {
                    // Update existing model or create new one
                    const modelId = `${providerId.toLowerCase()}-${modelName.toLowerCase()}`;
                    await upsertModel(modelId, providerId.toLowerCase(), modelName, minuteLimit, dayLimit, true);
                    console.log(`🔧 Custom model config: ${modelName} (${minuteLimit}/min, ${dayLimit}/day)`);
                }
            } catch (error) {
                console.error(`❌ Invalid model config: ${configKey}`, error.message);
            }
        }

        // Check for provider enable/disable flags
        // Format: PROVIDER_ENABLED_<PROVIDER>=true/false
        const providerFlags = envKeys.filter(key => key.startsWith('PROVIDER_ENABLED_'));
        
        for (const flagKey of providerFlags) {
            try {
                const [, , providerId] = flagKey.split('_');
                const enabled = process.env[flagKey] === 'true';
                
                if (providerId) {
                    // This would require a separate function to update provider status
                    console.log(`🔧 Provider ${providerId}: ${enabled ? 'enabled' : 'disabled'}`);
                }
            } catch (error) {
                console.error(`❌ Invalid provider flag: ${flagKey}`, error.message);
            }
        }
    }

    /**
     * Add a new API provider manually
     */
    async addProvider(providerId, name, apiKey, priority = 1, models = null) {
        try {
            await upsertProvider(providerId, name, apiKey, priority, true);
            console.log(`✅ Provider added: ${name} (priority: ${priority})`);

            // Add models if provided
            if (models && Array.isArray(models)) {
                for (const model of models) {
                    const modelId = `${providerId}-${model.name}`;
                    await upsertModel(
                        modelId,
                        providerId,
                        model.name,
                        model.perMinuteLimit || 60,
                        model.perDayLimit || 1000,
                        true
                    );
                    console.log(`📋 Added model: ${model.name}`);
                }
            } else {
                // Add default models
                await this.addGoogleProvider(providerId, name, apiKey, priority);
            }

            return true;
        } catch (error) {
            console.error(`❌ Failed to add provider ${name}:`, error);
            return false;
        }
    }

    /**
     * Update model rate limits
     */
    async updateModelLimits(modelId, perMinuteLimit, perDayLimit) {
        try {
            // Get existing model info
            const models = await getAvailableModels();
            const model = models.find(m => m.id === modelId);
            
            if (!model) {
                throw new Error(`Model ${modelId} not found`);
            }

            await upsertModel(
                model.id,
                model.provider_id,
                model.model_name,
                perMinuteLimit,
                perDayLimit,
                model.enabled
            );

            console.log(`✅ Updated model ${model.model_name}: ${perMinuteLimit}/min, ${perDayLimit}/day`);
            return true;
        } catch (error) {
            console.error(`❌ Failed to update model limits:`, error);
            return false;
        }
    }

    /**
     * Get current configuration summary
     */
    async getConfigurationSummary() {
        try {
            const models = await getAvailableModels();
            
            const providers = [...new Set(models.map(m => ({
                id: m.provider_id,
                name: m.provider_name,
                enabled: m.provider_enabled
            })))];

            const summary = {
                providers: providers.length,
                models: models.length,
                enabledModels: models.filter(m => m.enabled).length,
                providerDetails: providers,
                modelDetails: models.map(m => ({
                    id: m.id,
                    name: m.model_name,
                    provider: m.provider_name,
                    perMinuteLimit: m.per_minute_limit,
                    perDayLimit: m.per_day_limit,
                    enabled: m.enabled
                }))
            };

            return summary;
        } catch (error) {
            console.error(`❌ Failed to get configuration summary:`, error);
            return null;
        }
    }

    /**
     * Validate current configuration
     */
    async validateConfiguration() {
        try {
            const models = await getAvailableModels();
            
            if (models.length === 0) {
                return {
                    valid: false,
                    error: 'No models configured',
                    recommendations: ['Add at least one API provider with models']
                };
            }

            const enabledModels = models.filter(m => m.enabled);
            if (enabledModels.length === 0) {
                return {
                    valid: false,
                    error: 'No enabled models',
                    recommendations: ['Enable at least one model']
                };
            }

            const providers = [...new Set(models.map(m => m.provider_id))];
            const recommendations = [];

            if (providers.length === 1) {
                recommendations.push('Consider adding a secondary API provider for redundancy');
            }

            return {
                valid: true,
                providers: providers.length,
                models: enabledModels.length,
                recommendations
            };
        } catch (error) {
            return {
                valid: false,
                error: error.message,
                recommendations: ['Check database connectivity and schema']
            };
        }
    }
}

// Create singleton instance
const configManager = new ConfigManager();

module.exports = {
    ConfigManager,
    configManager
};