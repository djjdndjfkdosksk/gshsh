// Queue management database for agent server
// Handles job queues, API providers, models, rate limiting, and deduplication

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

// Create database connection with WAL mode for better concurrency
const dbPath = path.join(__dirname, 'queue.db');
const db = new sqlite3.Database(dbPath);

// Enable WAL mode and proper synchronization
db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
`);

/**
 * Initialize all database tables
 */
function initializeQueueDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // API Providers table
            db.run(`
                CREATE TABLE IF NOT EXISTS providers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    api_key TEXT NOT NULL,
                    priority INTEGER DEFAULT 1,
                    enabled BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // AI Models table
            db.run(`
                CREATE TABLE IF NOT EXISTS models (
                    id TEXT PRIMARY KEY,
                    provider_id TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    per_minute_limit INTEGER DEFAULT 60,
                    per_day_limit INTEGER DEFAULT 1000,
                    enabled BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (provider_id) REFERENCES providers (id)
                )
            `);

            // Jobs queue table
            db.run(`
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    file_id TEXT NOT NULL,
                    dedupe_key TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    priority INTEGER DEFAULT 1,
                    state TEXT DEFAULT 'queued' CHECK(state IN ('queued', 'processing', 'succeeded', 'failed', 'dead')),
                    attempts INTEGER DEFAULT 0,
                    max_attempts INTEGER DEFAULT 3,
                    error TEXT,
                    result TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    locked_at DATETIME,
                    worker_id TEXT
                )
            `);

            // Job attempts tracking
            db.run(`
                CREATE TABLE IF NOT EXISTS job_attempts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    attempt_no INTEGER NOT NULL,
                    provider_id TEXT,
                    model_id TEXT,
                    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    finished_at DATETIME,
                    success BOOLEAN DEFAULT 0,
                    error TEXT,
                    FOREIGN KEY (job_id) REFERENCES jobs (id),
                    FOREIGN KEY (provider_id) REFERENCES providers (id),
                    FOREIGN KEY (model_id) REFERENCES models (id)
                )
            `);

            // Rate limiting counters
            db.run(`
                CREATE TABLE IF NOT EXISTS rate_counters (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    model_id TEXT NOT NULL,
                    period TEXT NOT NULL CHECK(period IN ('minute', 'day')),
                    window_start DATETIME NOT NULL,
                    used_count INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (model_id) REFERENCES models (id)
                )
            `);

            // Provider backoff table
            db.run(`
                CREATE TABLE IF NOT EXISTS provider_backoff (
                    provider_id TEXT PRIMARY KEY,
                    until DATETIME NOT NULL,
                    reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (provider_id) REFERENCES providers (id)
                )
            `);

            // Create indexes for performance
            db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority DESC, created_at ASC)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, content_hash, state)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_rate_counters_lookup ON rate_counters(model_id, period, window_start)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled, provider_id)`);

            // Create unique constraint for deduplication (prevent duplicate active jobs)
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_active 
                   ON jobs(dedupe_key, content_hash) 
                   WHERE state IN ('queued', 'processing')`, (err) => {
                if (err) {
                    console.error('Error creating unique index:', err);
                    reject(err);
                    return;
                }
                console.log('Queue database initialized successfully');
                resolve();
            });
        });
    });
}

/**
 * Generate content hash for deduplication
 */
function generateContentHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generate unique job ID
 */
function generateJobId() {
    return crypto.randomUUID();
}

/**
 * Add or update API provider
 */
function upsertProvider(id, name, apiKey, priority = 1, enabled = true) {
    return new Promise((resolve, reject) => {
        const query = `
            INSERT OR REPLACE INTO providers (id, name, api_key, priority, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        db.run(query, [id, name, apiKey, priority, enabled], function(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(this.changes > 0);
        });
    });
}

/**
 * Add or update AI model configuration
 */
function upsertModel(id, providerId, modelName, perMinuteLimit = 60, perDayLimit = 1000, enabled = true) {
    return new Promise((resolve, reject) => {
        const query = `
            INSERT OR REPLACE INTO models (id, provider_id, model_name, per_minute_limit, per_day_limit, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        db.run(query, [id, providerId, modelName, perMinuteLimit, perDayLimit, enabled], function(err) {
            if (err) {
                reject(err);
                return;
            }
            resolve(this.changes > 0);
        });
    });
}

/**
 * Enqueue a new job with deduplication check
 */
function enqueueJob(fileId, jsonData, priority = 1, maxAttempts = 3) {
    return new Promise((resolve, reject) => {
        // Fix payload contract: store jsonData directly as payload, not wrapped
        const content = JSON.stringify(jsonData);
        const contentHash = generateContentHash(content);
        const dedupeKey = fileId;
        const jobId = generateJobId();

        // Check for existing active job first (without transaction)
        const checkQuery = `
            SELECT id, state, result FROM jobs 
            WHERE dedupe_key = ? AND content_hash = ? AND state IN ('queued', 'processing', 'succeeded')
        `;
        
        db.get(checkQuery, [dedupeKey, contentHash], (err, existingJob) => {
            if (err) {
                reject(err);
                return;
            }

            if (existingJob) {
                if (existingJob.state === 'succeeded') {
                    resolve({ jobId: existingJob.id, status: 'already_completed', result: existingJob.result });
                } else {
                    resolve({ jobId: existingJob.id, status: 'already_queued' });
                }
                return;
            }

            // Insert new job (simple insert without nested transaction)
            const insertQuery = `
                INSERT INTO jobs (id, file_id, dedupe_key, content_hash, payload_json, priority, max_attempts)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            
            db.run(insertQuery, [jobId, fileId, dedupeKey, contentHash, content, priority, maxAttempts], function(err) {
                if (err) {
                    // Handle unique constraint violation (race condition)
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        // Job was inserted by another request, try to find it
                        db.get(checkQuery, [dedupeKey, contentHash], (findErr, foundJob) => {
                            if (findErr) {
                                reject(findErr);
                                return;
                            }
                            if (foundJob) {
                                resolve({ jobId: foundJob.id, status: 'already_queued' });
                            } else {
                                reject(new Error('Constraint violation but job not found'));
                            }
                        });
                    } else {
                        reject(err);
                    }
                    return;
                }

                console.log(`✅ Job enqueued: ${jobId} for file: ${fileId}`);
                resolve({ jobId, status: 'enqueued' });
            });
        });
    });
}

/**
 * Get next available job for processing (atomic claim)
 */
function claimNextJob(workerId) {
    return new Promise((resolve, reject) => {
        // Find next available job
        const selectQuery = `
            SELECT * FROM jobs 
            WHERE state = 'queued' 
            ORDER BY priority DESC, created_at ASC 
            LIMIT 1
        `;

        db.get(selectQuery, [], (err, job) => {
            if (err) {
                reject(err);
                return;
            }

            if (!job) {
                resolve(null); // No jobs available
                return;
            }

            // Claim the job atomically
            const updateQuery = `
                UPDATE jobs 
                SET state = 'processing', locked_at = CURRENT_TIMESTAMP, worker_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND state = 'queued'
            `;

            db.run(updateQuery, [workerId, job.id], function(err) {
                if (err) {
                    reject(err);
                    return;
                }

                if (this.changes === 0) {
                    // Job was claimed by another worker, try again
                    resolve(null);
                    return;
                }
                
                // Parse the payload
                try {
                    job.payload = JSON.parse(job.payload_json);
                    delete job.payload_json; // Remove raw JSON
                    console.log(`🔒 Job claimed: ${job.id} by worker: ${workerId}`);
                    resolve(job);
                } catch (parseErr) {
                    reject(new Error(`Failed to parse job payload: ${parseErr.message}`));
                }
            });
        });
    });
}

/**
 * Update job status and result
 */
function updateJobStatus(jobId, state, result = null, error = null) {
    return new Promise((resolve, reject) => {
        const query = `
            UPDATE jobs 
            SET state = ?, result = ?, error = ?, updated_at = CURRENT_TIMESTAMP, locked_at = NULL, worker_id = NULL
            WHERE id = ?
        `;
        
        db.run(query, [state, result, error, jobId], function(err) {
            if (err) {
                reject(err);
                return;
            }
            console.log(`📝 Job ${jobId} updated to state: ${state}`);
            resolve(this.changes > 0);
        });
    });
}

/**
 * Increment job attempt count
 */
function incrementJobAttempt(jobId, providerId = null, modelId = null, success = false, error = null) {
    return new Promise((resolve, reject) => {
        // Increment attempts counter first
        db.run(`UPDATE jobs SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [jobId], function(err) {
            if (err) {
                reject(err);
                return;
            }

            // Get the current attempt number
            db.get(`SELECT attempts FROM jobs WHERE id = ?`, [jobId], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                // Record attempt details
                const insertQuery = `
                    INSERT INTO job_attempts (job_id, attempt_no, provider_id, model_id, finished_at, success, error)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
                `;

                db.run(insertQuery, [jobId, row.attempts, providerId, modelId, success, error], (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });
        });
    });
}

/**
 * Get available models with rate limit check
 */
function getAvailableModels() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT m.*, p.name as provider_name, p.api_key, p.enabled as provider_enabled
            FROM models m
            JOIN providers p ON m.provider_id = p.id
            WHERE m.enabled = 1 AND p.enabled = 1
            AND p.id NOT IN (
                SELECT provider_id FROM provider_backoff 
                WHERE until > CURRENT_TIMESTAMP
            )
            ORDER BY p.priority ASC, m.id ASC
        `;

        db.all(query, [], (err, models) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(models);
        });
    });
}

/**
 * Check and increment rate limit counter
 */
function checkAndIncrementRateLimit(modelId, period) {
    return new Promise((resolve, reject) => {
        const windowStart = period === 'minute' 
            ? new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()
            : new Date().toISOString().substr(0, 10) + ' 00:00:00';

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // Get or create rate counter
            const selectQuery = `
                SELECT * FROM rate_counters 
                WHERE model_id = ? AND period = ? AND window_start = ?
            `;

            db.get(selectQuery, [modelId, period, windowStart], (err, counter) => {
                if (err) {
                    db.run('ROLLBACK');
                    reject(err);
                    return;
                }

                if (!counter) {
                    // Create new counter
                    db.run(`INSERT INTO rate_counters (model_id, period, window_start, used_count) VALUES (?, ?, ?, 1)`,
                        [modelId, period, windowStart], (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            reject(err);
                            return;
                        }

                        db.run('COMMIT', (err) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            resolve({ allowed: true, count: 1 });
                        });
                    });
                } else {
                    // Get model limits
                    const limitQuery = `SELECT per_minute_limit, per_day_limit FROM models WHERE id = ?`;
                    db.get(limitQuery, [modelId], (err, model) => {
                        if (err) {
                            db.run('ROLLBACK');
                            reject(err);
                            return;
                        }

                        const limit = period === 'minute' ? model.per_minute_limit : model.per_day_limit;
                        
                        if (counter.used_count >= limit) {
                            db.run('ROLLBACK');
                            resolve({ allowed: false, count: counter.used_count, limit });
                            return;
                        }

                        // Increment counter
                        db.run(`UPDATE rate_counters SET used_count = used_count + 1 WHERE id = ?`,
                            [counter.id], (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                reject(err);
                                return;
                            }

                            db.run('COMMIT', (err) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                resolve({ allowed: true, count: counter.used_count + 1 });
                            });
                        });
                    });
                }
            });
        });
    });
}

/**
 * Set provider backoff
 */
function setProviderBackoff(providerId, until, reason) {
    return new Promise((resolve, reject) => {
        const query = `
            INSERT OR REPLACE INTO provider_backoff (provider_id, until, reason)
            VALUES (?, ?, ?)
        `;
        
        db.run(query, [providerId, until, reason], function(err) {
            if (err) {
                reject(err);
                return;
            }
            console.log(`⏰ Provider ${providerId} backed off until ${until}: ${reason}`);
            resolve();
        });
    });
}

/**
 * Get queue statistics
 */
function getQueueStats() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT 
                state,
                COUNT(*) as count
            FROM jobs 
            GROUP BY state
        `;

        db.all(query, [], (err, stats) => {
            if (err) {
                reject(err);
                return;
            }

            const result = {
                queued: 0,
                processing: 0,
                succeeded: 0,
                failed: 0,
                dead: 0
            };

            stats.forEach(stat => {
                result[stat.state] = stat.count;
            });

            resolve(result);
        });
    });
}

/**
 * Clean up stale jobs (unlock jobs that have been processing too long)
 */
function cleanupStaleJobs(timeoutMinutes = 10) {
    return new Promise((resolve, reject) => {
        const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
        
        const query = `
            UPDATE jobs 
            SET state = 'failed', error = 'Job timed out', locked_at = NULL, worker_id = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE state = 'processing' AND locked_at < ?
        `;

        db.run(query, [cutoffTime], function(err) {
            if (err) {
                reject(err);
                return;
            }
            
            if (this.changes > 0) {
                console.log(`🧹 Cleaned up ${this.changes} stale jobs`);
            }
            resolve(this.changes);
        });
    });
}

/**
 * Close database connection
 */
function closeQueueDatabase() {
    return new Promise((resolve) => {
        db.close((err) => {
            if (err) {
                console.error('Error closing queue database:', err);
            } else {
                console.log('Queue database connection closed');
            }
            resolve();
        });
    });
}

module.exports = {
    initializeQueueDatabase,
    generateContentHash,
    generateJobId,
    upsertProvider,
    upsertModel,
    enqueueJob,
    claimNextJob,
    updateJobStatus,
    incrementJobAttempt,
    getAvailableModels,
    checkAndIncrementRateLimit,
    setProviderBackoff,
    getQueueStats,
    cleanupStaleJobs,
    closeQueueDatabase,
    db
};
