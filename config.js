// AI Models Configuration - Simplified and Optimized
// Models are processed in the exact order specified below

const AI_MODELS = [
    {
        name: 'gemini-2.0-flash',
        priority: 1,
        perMinuteLimit: 10,
        perDayLimit: 200,
        enabled: true
    },
    {
        name: 'gemini-2.5-flash-lite',
        priority: 2,
        perMinuteLimit: 15,
        perDayLimit: 300,
        enabled: true
    },
    {
        name: 'gemini-2.0-flash-lite',
        priority: 3,
        perMinuteLimit: 20,
        perDayLimit: 400,
        enabled: true
    },
    {
        name: 'gemini-1.5-flash',
        priority: 4,
        perMinuteLimit: 25,
        perDayLimit: 500,
        enabled: true
    }
];

// Fast cache for model switching
class ModelCache {
    constructor() {
        this.cache = new Map();
        this.lastUsed = new Map();
        this.errors = new Map();
    }

    getAvailableModels() {
        return AI_MODELS.filter(model => model.enabled)
                       .sort((a, b) => a.priority - b.priority);
    }

    markModelError(modelName, error) {
        this.errors.set(modelName, {
            error,
            timestamp: Date.now()
        });
        // Auto-recovery after 5 minutes
        setTimeout(() => {
            this.errors.delete(modelName);
        }, 5 * 60 * 1000);
    }

    isModelAvailable(modelName) {
        const errorInfo = this.errors.get(modelName);
        if (errorInfo && Date.now() - errorInfo.timestamp < 5 * 60 * 1000) {
            return false;
        }
        return true;
    }

    getNextModel(excludeModels = []) {
        const available = this.getAvailableModels()
            .filter(model => !excludeModels.includes(model.name))
            .filter(model => this.isModelAvailable(model.name));
        
        return available.length > 0 ? available[0] : null;
    }

    getModelByName(name) {
        return AI_MODELS.find(m => m.name === name);
    }
}

// Export both configuration and cache
module.exports = {
    AI_MODELS,
    ModelCache,
    // Helper functions for backward compatibility
    getModels: () => AI_MODELS,
    getEnabledModels: () => AI_MODELS.filter(m => m.enabled),
    getModelByName: (name) => AI_MODELS.find(m => m.name === name)
};