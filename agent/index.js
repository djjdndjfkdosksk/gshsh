// Simplified Agent Server - Fast and Robust AI Processing
// Direct processing without complex queue system

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { extractOptimizedContent, calculateSmartTokenLimit, validateExtractedContent, cleanContentForAI } = require('./content-extractor');
const { summarizeContent, testAIService, getServiceStatus } = require('./ai-service');

const app = express();
const PORT = process.env.PORT || 3002;

// Performance tracking
const stats = {
    processed: 0,
    failed: 0,
    totalProcessingTime: 0,
    startTime: Date.now()
};

const axios = require('axios');

// Function to send summary back to Browser
async function sendSummaryToBrowser(fileId, summary, extractionResult) {
    try {
        const payload = {
            fileId,
            summary,
            metadata: {
                contentBlocks: extractionResult.contentBlocks,
                totalWords: extractionResult.totalWords,
                mainContentWords: extractionResult.mainContentWords,
                processingTimeMs: extractionResult.processingTimeMs,
                processedAt: new Date().toISOString()
            }
        };

        // Generate authentication for callback request
        const crypto = require('crypto');
        const authTimestamp = Date.now().toString();
        const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'development-internal-secret-for-mvp-only';
        
        const signature = crypto.createHmac('sha256', INTERNAL_SECRET)
            .update(`${authTimestamp}.${JSON.stringify(payload)}`)
            .digest('hex');

        const response = await axios.post('http://localhost:5000/api/summary-callback', payload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'x-internal-auth': `${authTimestamp}.${signature}`
            }
        });

        return response.status === 200;
    } catch (error) {
        console.error(`❌ [${fileId}] Failed to send summary to Browser:`, error.message);
        return false;
    }
}



// Middleware with optimization
app.use(cors());
app.use(express.json({ 
    limit: '50mb',
    // Fast JSON parsing
    strict: false,
    type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Fast request logging
app.use((req, res, next) => {
    req.startTime = Date.now();
    console.log(`[${new Date().toLocaleString()}] ${req.method} ${req.path}`);
    next();
});

// Health check - simplified
app.get('/api/health', async (req, res) => {
    try {
        const serviceStatus = getServiceStatus();
        const uptime = Date.now() - stats.startTime;
        
        res.json({
            success: true,
            message: 'Agent server is running',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(uptime / 1000),
            stats: {
                processed: stats.processed,
                failed: stats.failed,
                avgProcessingTime: stats.processed > 0 ? Math.round(stats.totalProcessingTime / stats.processed) : 0
            },
            aiService: serviceStatus
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Health check failed'
        });
    }
});

// AI service test - simplified
app.get('/api/test', async (req, res) => {
    try {
        const testResult = await testAIService();
        const serviceStatus = getServiceStatus();

        res.json({
            success: testResult,
            message: testResult ? 'AI service is working correctly' : 'AI service test failed',
            service: serviceStatus,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'AI service test failed'
        });
    }
});

// Fast content processing endpoint
app.post('/api/process', async (req, res) => {
    const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const processingStart = Date.now();

    try {
        const { jsonData, fileId } = req.body;
        const actualFileId = fileId || requestId;

        if (!jsonData) {
            return res.status(400).json({
                success: false,
                error: 'Missing jsonData in request body',
                requestId
            });
        }

        console.log(`🚀 [${actualFileId}] Starting fast processing...`);

        // Step 1: Fast content extraction
        const extractionResult = extractOptimizedContent(jsonData);
        console.log(`📊 [${actualFileId}] Extracted ${extractionResult.contentBlocks} blocks, ${extractionResult.mainContentWords} words`);

        // Step 2: Quick validation
        if (!validateExtractedContent(extractionResult.extractedText)) {
            throw new Error('Extracted content is too short or invalid');
        }

        // Step 3: Fast content cleaning
        const cleanedContent = cleanContentForAI(extractionResult.extractedText);

        // Step 4: Smart token calculation based on mainContentWords
        const wordCount = extractionResult.mainContentWords || extractionResult.totalWords;
        const maxTokens = calculateSmartTokenLimit(wordCount);

        console.log(`🧠 [${actualFileId}] Token limit: ${maxTokens} (for ${wordCount} words)`);

        // Step 5: AI summarization with robust model switching
        const summary = await summarizeContent(cleanedContent, maxTokens, actualFileId);

        // Performance tracking
        const processingTime = Date.now() - processingStart;
        stats.processed++;
        stats.totalProcessingTime += processingTime;

        console.log(`✅ [${actualFileId}] Completed in ${processingTime}ms`);

        // Send callback to Browser if this came from Browser
        if (req.headers['x-request-id']) {
            try {
                await sendSummaryToBrowser(actualFileId, summary, extractionResult);
                console.log(`📤 [${actualFileId}] Summary sent to Browser via callback`);
            } catch (callbackError) {
                console.warn(`⚠️ [${actualFileId}] Failed to send callback to Browser:`, callbackError.message);
            }
        }

        res.json({
            success: true,
            requestId,
            fileId: actualFileId,
            summary,
            metadata: {
                contentBlocks: extractionResult.contentBlocks,
                totalWords: extractionResult.totalWords,
                mainContentWords: extractionResult.mainContentWords,
                maxTokensUsed: maxTokens,
                processingTimeMs: processingTime
            }
        });

    } catch (error) {
        stats.failed++;
        const processingTime = Date.now() - processingStart;
        
        console.error(`❌ [${requestId}] Failed after ${processingTime}ms:`, error.message);
        
        res.status(500).json({
            success: false,
            error: error.message,
            requestId,
            processingTimeMs: processingTime
        });
    }
});

// Simplified batch processing
app.post('/api/process-batch', async (req, res) => {
    const requestId = req.headers['x-request-id'] || `batch-${Date.now()}`;
    const batchStart = Date.now();

    try {
        const { files } = req.body;

        if (!files || !Array.isArray(files)) {
            return res.status(400).json({
                success: false,
                error: 'Files array is required',
                requestId
            });
        }

        console.log(`📦 [${requestId}] Processing batch of ${files.length} files...`);

        const results = [];
        const maxConcurrent = 3; // Process up to 3 files concurrently for speed

        // Process in chunks for better performance
        for (let i = 0; i < files.length; i += maxConcurrent) {
            const chunk = files.slice(i, i + maxConcurrent);
            
            const chunkPromises = chunk.map(async (file, index) => {
                const fileId = file.fileId || `${requestId}-${i + index}`;
                
                try {
                    const extractionResult = extractOptimizedContent(file.jsonData);
                    const cleanedContent = cleanContentForAI(extractionResult.extractedText);
                    const wordCount = extractionResult.mainContentWords || extractionResult.totalWords;
                    const maxTokens = calculateSmartTokenLimit(wordCount);

                    const summary = await summarizeContent(cleanedContent, maxTokens, fileId);

                    return {
                        fileId,
                        success: true,
                        summary,
                        metadata: {
                            contentBlocks: extractionResult.contentBlocks,
                            totalWords: extractionResult.totalWords,
                            mainContentWords: extractionResult.mainContentWords,
                            maxTokensUsed: maxTokens
                        }
                    };
                } catch (error) {
                    console.error(`❌ [${fileId}] Batch processing failed:`, error.message);
                    return {
                        fileId,
                        success: false,
                        error: error.message
                    };
                }
            });

            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
        }

        const processingTime = Date.now() - batchStart;
        const successCount = results.filter(r => r.success).length;

        console.log(`📦 [${requestId}] Batch completed: ${successCount}/${files.length} successful in ${processingTime}ms`);

        res.json({
            success: true,
            requestId,
            totalFiles: files.length,
            successfulFiles: successCount,
            failedFiles: files.length - successCount,
            results,
            processingTimeMs: processingTime
        });

    } catch (error) {
        const processingTime = Date.now() - batchStart;
        console.error(`❌ [${requestId}] Batch processing failed:`, error.message);
        
        res.status(500).json({
            success: false,
            error: error.message,
            requestId,
            processingTimeMs: processingTime
        });
    }
});

// Statistics endpoint
app.get('/api/stats', (req, res) => {
    const uptime = Date.now() - stats.startTime;
    
    res.json({
        success: true,
        stats: {
            uptime: Math.floor(uptime / 1000),
            processed: stats.processed,
            failed: stats.failed,
            successRate: stats.processed > 0 ? Math.round((stats.processed / (stats.processed + stats.failed)) * 100) : 0,
            avgProcessingTime: stats.processed > 0 ? Math.round(stats.totalProcessingTime / stats.processed) : 0,
            requestsPerMinute: stats.processed > 0 ? Math.round((stats.processed / uptime) * 60000) : 0
        },
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        timestamp: new Date().toISOString()
    });
});

// Start server
async function startServer() {
    try {
        console.log('🚀 Starting Simplified Agent Server...');
        
        // Test AI service on startup
        const aiWorking = await testAIService();
        if (!aiWorking) {
            console.warn('⚠️ AI service test failed - server will start but may not function properly');
        }
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Agent server running on port ${PORT}`);
            console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
            console.log(`🧪 Test endpoint: http://localhost:${PORT}/api/test`);
            console.log(`📊 Stats endpoint: http://localhost:${PORT}/api/stats`);
            console.log('🎯 Ready to process AI summarization requests!');
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down agent server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Shutting down agent server...');
    process.exit(0);
});

startServer().catch(console.error);
