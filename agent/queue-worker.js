// Queue Worker - High-speed job processing with atomic operations
// Processes jobs one by one with configurable concurrency

const { extractOptimizedContent, calculateSmartTokenLimit, cleanContentForAI } = require('./content-extractor');
const { aiRouter } = require('./ai-router');
const { configManager } = require('./config-manager');
const { 
    claimNextJob, 
    updateJobStatus, 
    cleanupStaleJobs,
    getQueueStats 
} = require('./queue-database');
const axios = require('axios');

class QueueWorker {
    constructor(workerId = null, options = {}) {
        this.workerId = workerId || `worker-${process.pid}-${Date.now()}`;
        this.isRunning = false;
        this.concurrency = options.concurrency || 1; // Process one job at a time as requested
        this.pollInterval = options.pollInterval || 1000; // Check for jobs every second
        this.staleJobCleanupInterval = options.staleJobCleanupInterval || 5 * 60 * 1000; // 5 minutes
        this.clientCallbackUrl = options.clientCallbackUrl || 'http://localhost:5000/api/summary-callback';

        this.activeJobs = new Set();
        this.processedJobs = 0;
        this.failedJobs = 0;
        this.startTime = null;

        console.log(`🏗️ Queue worker initialized: ${this.workerId}`);
        console.log(`⚙️ Concurrency: ${this.concurrency}, Poll interval: ${this.pollInterval}ms`);
    }

    /**
     * Start the worker
     */
    async start() {
        if (this.isRunning) {
            console.log(`⚠️ Worker ${this.workerId} is already running`);
            return;
        }

        this.isRunning = true;
        this.startTime = new Date();
        console.log(`🚀 Starting queue worker: ${this.workerId}`);

        // Start cleanup interval
        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, this.staleJobCleanupInterval);

        // Start main processing loop
        this.processingLoop();
    }

    /**
     * Stop the worker
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        console.log(`🛑 Stopping queue worker: ${this.workerId}`);
        this.isRunning = false;

        // Clear intervals
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        // Wait for active jobs to complete
        while (this.activeJobs.size > 0) {
            console.log(`⏳ Waiting for ${this.activeJobs.size} active jobs to complete...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`✅ Worker ${this.workerId} stopped successfully`);
    }

    /**
     * Main processing loop
     */
    async processingLoop() {
        while (this.isRunning) {
            try {
                // Check if we can take more jobs
                if (this.activeJobs.size < this.concurrency) {
                    const job = await claimNextJob(this.workerId);

                    if (job) {
                        // Process job asynchronously
                        this.processJob(job);
                    } else {
                        // No jobs available, wait before checking again
                        await this.sleep(this.pollInterval);
                    }
                } else {
                    // At capacity, wait
                    await this.sleep(this.pollInterval);
                }
            } catch (error) {
                console.error(`❌ Error in processing loop:`, error);
                await this.sleep(this.pollInterval);
            }
        }
    }

    /**
     * Process a single job
     */
    async processJob(job) {
        this.activeJobs.add(job.id);
        const startTime = Date.now();

        try {
            console.log(`\n🔄 [${job.file_id}] Processing job: ${job.id}`);
            console.log(`📊 [${job.file_id}] Attempt ${job.attempts + 1}/${job.max_attempts}`);

            // Step 1: Extract content
            console.log(`📋 [${job.file_id}] Extracting content...`);
            console.log(`🔍 [${job.file_id}] Payload keys:`, Object.keys(job.payload || {}));
            console.log(`🔍 [${job.file_id}] Has filteredData:`, !!(job.payload?.filteredData));
            console.log(`🔍 [${job.file_id}] Has jsonData:`, !!(job.payload?.jsonData));
            const extractionResult = extractOptimizedContent(job.payload);

            if (!extractionResult.extractedText || extractionResult.extractedText.trim().length === 0) {
                throw new Error('No extractable content found in payload');
            }

            console.log(`📊 [${job.file_id}] Extraction completed:`);
            console.log(`   - Content blocks: ${extractionResult.contentBlocks}`);
            console.log(`   - Total words: ${extractionResult.totalWords}`);
            console.log(`   - Processing time: ${extractionResult.processingTimeMs}ms`);

            // Step 2: Calculate token limits based on main content words
            const wordCount = extractionResult.mainContentWords || extractionResult.totalWords;
            const tokenLimit = calculateSmartTokenLimit(wordCount);
            console.log(`🎯 [${job.file_id}] Token limit: ${tokenLimit} (based on ${wordCount} main content words, total: ${extractionResult.totalWords})`);

            // Step 3: Clean content for AI
            const cleanedContent = cleanContentForAI(extractionResult.extractedText);
            console.log(`🧹 [${job.file_id}] Content cleaned: ${cleanedContent.length} characters`);

            // Step 4: Check available models from config
            console.log(`🔧 [${job.file_id}] Checking configured models...`);
            const configSummary = await configManager.getConfigurationSummary();
            console.log(`📋 [${job.file_id}] Available models: ${configSummary?.enabledModels || 0}`);
            
            if (!configSummary || configSummary.enabledModels === 0) {
                throw new Error('No AI models configured or enabled in config manager');
            }

            // Step 5: Generate summary using AI router
            const summary = await aiRouter.summarizeContent(
                cleanedContent, 
                tokenLimit, 
                job.file_id,
                job.id
            );

            if (!summary || summary.trim().length === 0) {
                throw new Error('AI returned empty summary');
            }

            // Step 5: Send result to client
            const callbackSuccess = await this.sendSummaryToClient(job.file_id, summary, extractionResult);

            if (!callbackSuccess) {
                throw new Error('Failed to send summary to client');
            }

            // Step 6: Mark job as succeeded
            await updateJobStatus(job.id, 'succeeded', summary);

            const processingTime = Date.now() - startTime;
            this.processedJobs++;

            console.log(`✅ [${job.file_id}] Job completed successfully in ${processingTime}ms`);
            console.log(`📝 [${job.file_id}] Summary length: ${summary.length} characters`);

        } catch (error) {
            console.error(`❌ [${job.file_id}] Job failed:`, error.message);

            const shouldRetry = job.attempts + 1 < job.max_attempts;

            if (shouldRetry) {
                // Requeue for retry
                await updateJobStatus(job.id, 'queued', null, error.message);
                console.log(`🔄 [${job.file_id}] Job requeued for retry (attempt ${job.attempts + 1}/${job.max_attempts})`);
            } else {
                // Mark as dead after max attempts
                await updateJobStatus(job.id, 'dead', null, error.message);
                console.log(`💀 [${job.file_id}] Job marked as dead after ${job.max_attempts} attempts`);
            }

            this.failedJobs++;
        } finally {
            this.activeJobs.delete(job.id);
        }
    }

    /**
     * Send summary to client via callback
     */
    async sendSummaryToClient(fileId, summary, extractionResult) {
        try {
            console.log(`📤 [${fileId}] Sending summary to client...`);

            const payload = {
                fileId,
                summary,
                metadata: {
                    contentBlocks: extractionResult.contentBlocks,
                    totalWords: extractionResult.totalWords,
                    mainContentWords: extractionResult.mainContentWords,
                    processingTimeMs: extractionResult.processingTimeMs,
                    extractionMethod: extractionResult.metadata?.extractionMethod,
                    processedAt: new Date().toISOString()
                }
            };

            // Generate authentication for callback request
            const crypto = require('crypto');
            const authTimestamp = Date.now().toString();
            const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
            if (!INTERNAL_SECRET || INTERNAL_SECRET === 'development-internal-secret-for-mvp-only') {
                console.error('❌ INTERNAL_SECRET not configured or using default value - security risk!');
                throw new Error('Server configuration error: INTERNAL_SECRET required');
            }

            const signature = crypto.createHmac('sha256', INTERNAL_SECRET)
                .update(`${authTimestamp}.${JSON.stringify(payload)}`)
                .digest('hex');

            const response = await axios.post(this.clientCallbackUrl, payload, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-auth': `${authTimestamp}.${signature}`
                }
            });

            if (response.status === 200) {
                console.log(`✅ [${fileId}] Summary sent to client successfully`);
                return true;
            } else {
                console.error(`❌ [${fileId}] Client callback failed with status: ${response.status}`);
                return false;
            }

        } catch (error) {
            console.error(`❌ [${fileId}] Failed to send summary to client:`, error.message);
            return false;
        }
    }

    /**
     * Perform periodic cleanup tasks
     */
    async performCleanup() {
        try {
            console.log(`🧹 [${this.workerId}] Performing cleanup...`);

            // Clean up stale jobs
            const staleJobs = await cleanupStaleJobs(10); // 10 minute timeout

            if (staleJobs > 0) {
                console.log(`🧹 [${this.workerId}] Cleaned up ${staleJobs} stale jobs`);
            }

        } catch (error) {
            console.error(`❌ [${this.workerId}] Cleanup failed:`, error);
        }
    }

    /**
     * Get worker statistics
     */
    getStats() {
        const uptime = this.startTime ? Date.now() - this.startTime.getTime() : 0;

        return {
            workerId: this.workerId,
            isRunning: this.isRunning,
            activeJobs: this.activeJobs.size,
            processedJobs: this.processedJobs,
            failedJobs: this.failedJobs,
            uptime: uptime,
            concurrency: this.concurrency,
            startTime: this.startTime?.toISOString()
        };
    }

    /**
     * Get detailed status including queue stats
     */
    async getDetailedStatus() {
        const workerStats = this.getStats();
        const queueStats = await getQueueStats();

        return {
            worker: workerStats,
            queue: queueStats,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export both the class and a default instance
const defaultWorker = new QueueWorker();

module.exports = {
    QueueWorker,
    defaultWorker
};
