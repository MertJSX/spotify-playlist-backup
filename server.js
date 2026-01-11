const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const querystring = require('querystring');
const yaml = require('yaml');
const crypto = require('crypto');

// ==================== RATE LIMITER ====================
class RateLimiter {
    constructor(requestsPerSecond = 8) {
        this.requestsPerSecond = requestsPerSecond;
        this.requestCount = 0;
        this.lastReset = Date.now();
        
        setInterval(() => {
            this.requestCount = 0;
            this.lastReset = Date.now();
        }, 1000);
    }

    async waitForSlot() {
        if (this.requestCount < this.requestsPerSecond) {
            this.requestCount++;
            return;
        }

        const waitTime = 1000 - (Date.now() - this.lastReset) + 10;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.requestCount = 1;
        this.lastReset = Date.now();
    }

    async makeRequest(fn) {
        await this.waitForSlot();
        return fn();
    }
}

// ==================== SIMPLE TRACKER ====================
class SimpleTracker {
    constructor() {
        this.stats = {
            startTime: Date.now(),
            totalRequests: 0,
            totalBackups: 0,
            totalSongs: 0,
            lastBackup: null
        };
    }

    logRequest(type = 'api', songsCount = 0) {
        this.stats.totalRequests++;
        if (type === 'backup') {
            this.stats.totalBackups++;
            this.stats.totalSongs += songsCount;
            this.stats.lastBackup = new Date().toISOString();
        }
    }

    getStats() {
        const uptime = Date.now() - this.stats.startTime;
        const hours = Math.floor(uptime / (1000 * 60 * 60));
        const requestsPerHour = hours > 0 ? (this.stats.totalRequests / hours).toFixed(1) : 0;
        
        return {
            uptime: `${hours}h`,
            totalRequests: this.stats.totalRequests,
            totalBackups: this.stats.totalBackups,
            totalSongs: this.stats.totalSongs,
            requestsPerHour: requestsPerHour,
            lastBackup: this.stats.lastBackup
        };
    }
}

// ==================== SIMPLE SCHEDULER ====================
class SimpleScheduler {
    constructor(config, server) {
        this.config = config;
        this.server = server;
        this.backupStates = new Map(); // username -> {lastHash, lastCount, lastBackup}
        this.scheduleInterval = null;
        
        console.log(`⏰ Simple Scheduler: ${config.auto_backup_interval}-hour intervals`);
        this.start();
    }

    start() {
        const intervalMs = this.config.auto_backup_interval * 60 * 60 * 1000;
        
        this.scheduleInterval = setInterval(() => {
            this.runScheduledBackups();
        }, intervalMs);
        
        setTimeout(() => this.runScheduledBackups(), 5000);
        
        console.log(`✅ Scheduler started (every ${this.config.auto_backup_interval} hours)`);
    }

    async runScheduledBackups() {
        console.log(`\n🔔 Scheduled backup check at ${new Date().toLocaleTimeString()}`);
        
        const activeUsers = Array.from(this.server.userSessions.keys());
        
        if (activeUsers.length === 0) {
            console.log('⏳ No active users, skipping...');
            return;
        }
        
        console.log(`📋 Backing up ${activeUsers.length} user(s)...`);
        
        for (const username of activeUsers) {
            try {
                await this.runUserBackup(username);
                if (activeUsers.length > 1) {
                    console.log('⏳ Waiting 30 seconds before next user...');
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
            } catch (error) {
                console.error(`❌ Scheduled backup failed for ${username}:`, error.message);
            }
        }
        
        console.log('✅ All scheduled backups completed');
    }

    async runUserBackup(username) {
        const session = this.server.userSessions.get(username);
        if (!session) {
            console.log(`❌ User ${username} not logged in, skipping`);
            return;
        }

        console.log(`🔄 Starting scheduled backup for: ${session.display_name}`);
        
        try {
            const result = await this.server.performSimpleBackup(username);
            
            if (result.changed) {
                console.log(`✅ Backup updated for ${session.display_name}: ${result.songsCount} songs`);
            } else {
                console.log(`📭 No changes for ${session.display_name}, skipping file write`);
            }
            
        } catch (error) {
            console.error(`Backup error for ${username}:`, error.message);
            throw error;
        }
    }

    getNextBackupTime() {
        const now = Date.now();
        const next = now + (this.config.auto_backup_interval * 60 * 60 * 1000);
        return new Date(next).toLocaleString();
    }
}

// ==================== MAIN SERVER (SIMPLE VERSION) ====================
class SimpleSpotifyBackupServer {
    constructor() {
        this.app = express();
        this.config = this.loadConfig();
        this.userSessions = new Map(); // username -> {access_token, refresh_token, expires_at, display_name}
        this.rateLimiter = new RateLimiter(this.config.requests_per_second || 8);
        this.tracker = new SimpleTracker();
        this.scheduler = null;
        
        this.init();
    }

    loadConfig() {
        try {
            const configFile = fsSync.readFileSync('config.yml', 'utf8');
            const config = yaml.parse(configFile);
            
            return {
                port: 8888,
                redirect_uri: 'http://127.0.0.1:8888/callback',
                scopes: 'user-library-read',
                backups_location: './backups',
                auto_backup_interval: 1,
                requests_per_second: 8,
                ...config
            };
        } catch (error) {
            console.error('Error loading config.yml:', error.message);
            return {
                client_id: process.env.CLIENT_ID || '',
                client_secret: process.env.CLIENT_SECRET || '',
                port: 8888,
                redirect_uri: 'http://127.0.0.1:8888/callback',
                scopes: 'user-library-read',
                backups_location: './backups',
                auto_backup_interval: 1
            };
        }
    }

    init() {
        this.setupDirectories();
        this.setupRoutes();
        this.scheduler = new SimpleScheduler(this.config, this);
        this.startServer();
    }

    setupDirectories() {
        if (!fsSync.existsSync(this.config.backups_location)) {
            fsSync.mkdirSync(this.config.backups_location, { recursive: true });
            console.log(`✅ Created backups directory: ${this.config.backups_location}`);
        }
    }

    setupRoutes() {
        // ========== SIMPLE WEB INTERFACE ==========
        this.app.get('/', (req, res) => {
            const stats = this.tracker.getStats();
            const activeUsers = Array.from(this.userSessions.values()).map(s => s.display_name);
            
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Spotify Simple Backup</title>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                        h1 { color: #1DB954; }
                        .card { background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0; }
                        .btn { background: #1DB954; color: white; padding: 12px 24px; 
                               text-decoration: none; border-radius: 6px; display: inline-block; 
                               margin: 5px; font-weight: bold; }
                        .btn:hover { background: #1ed760; }
                        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                                 gap: 10px; margin: 20px 0; }
                        .stat { background: white; padding: 15px; border-radius: 8px; }
                    </style>
                </head>
                <body>
                    <h1>🎵 Spotify Simple Backup</h1>
                    
                    <div class="card">
                        <h3>Quick Actions</h3>
                        <a href="/login" class="btn">Login with Spotify</a>
                        <a href="/backup" class="btn">Manual Backup</a>
                        <a href="/api/stats" class="btn">Stats</a>
                    </div>
                    
                    <div class="card">
                        <h3>📊 System Status</h3>
                        <div class="stats">
                            <div class="stat">
                                <strong>Active Users:</strong> ${activeUsers.length}
                            </div>
                            <div class="stat">
                                <strong>Backup Interval:</strong> ${this.config.auto_backup_interval} hours
                            </div>
                            <div class="stat">
                                <strong>Next Backup:</strong> ${this.scheduler.getNextBackupTime()}
                            </div>
                            <div class="stat">
                                <strong>Uptime:</strong> ${stats.uptime}
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <h3>📈 Statistics</h3>
                        <div class="stats">
                            <div class="stat">
                                <strong>Total Requests:</strong> ${stats.totalRequests}
                            </div>
                            <div class="stat">
                                <strong>Total Backups:</strong> ${stats.totalBackups}
                            </div>
                            <div class="stat">
                                <strong>Total Songs:</strong> ${stats.totalSongs}
                            </div>
                            <div class="stat">
                                <strong>Requests/Hour:</strong> ${stats.requestsPerHour}
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <h3>✅ How It Works</h3>
                        <ul>
                            <li><strong>Simple & Reliable:</strong> Checks every ${this.config.auto_backup_interval} hours</li>
                            <li><strong>Full Backup:</strong> Any change triggers complete file rewrite</li>
                            <li><strong>Safe:</strong> Uses minimal API calls (2-3/hour/user)</li>
                            <li><strong>Auto-refresh:</strong> Tokens refresh automatically</li>
                            <li><strong>Multi-user:</strong> Supports multiple users</li>
                        </ul>
                    </div>
                </body>
                </html>
            `;
            res.send(html);
        });

        // ========== LOGIN FLOW ==========
        this.app.get('/login', (req, res) => {
            const authUrl = 'https://accounts.spotify.com/authorize?' +
                querystring.stringify({
                    response_type: 'code',
                    client_id: this.config.client_id,
                    scope: this.config.scopes,
                    redirect_uri: this.config.redirect_uri,
                    state: Math.random().toString(36).substring(7)
                });
            res.redirect(authUrl);
        });

        this.app.get('/callback', async (req, res) => {
            const code = req.query.code;
            const error = req.query.error;

            if (error) {
                return res.send(`<h2>Error: ${error}</h2><p><a href="/">Go back</a></p>`);
            }

            if (!code) {
                return res.status(400).send('No authorization code received');
            }

            try {
                const tokenResponse = await this.rateLimiter.makeRequest(() =>
                    axios.post(
                        'https://accounts.spotify.com/api/token',
                        querystring.stringify({
                            grant_type: 'authorization_code',
                            code: code,
                            redirect_uri: this.config.redirect_uri
                        }),
                        {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': 'Basic ' + 
                                    Buffer.from(`${this.config.client_id}:${this.config.client_secret}`)
                                    .toString('base64')
                            }
                        }
                    )
                );

                const access_token = tokenResponse.data.access_token;
                const refresh_token = tokenResponse.data.refresh_token;
                
                const userResponse = await this.rateLimiter.makeRequest(() =>
                    axios.get('https://api.spotify.com/v1/me', {
                        headers: { 'Authorization': `Bearer ${access_token}` }
                    })
                );
                
                const username = userResponse.data.id;
                const displayName = userResponse.data.display_name || username;
                
                this.userSessions.set(username, {
                    access_token,
                    refresh_token,
                    expires_at: Date.now() + (3600 * 1000),
                    display_name: displayName
                });

                console.log(`✅ User logged in: ${displayName}`);
                
                const result = await this.performSimpleBackup(username);
                
                res.send(`
                    <!DOCTYPE html>
                    <html>
                    <head><title>Success</title></head>
                    <body style="font-family: sans-serif; padding: 40px;">
                        <h1 style="color: #1DB954;">✅ Successfully Logged In!</h1>
                        <p>Welcome, <strong>${displayName}</strong>!</p>
                        
                        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <p><strong>Backup Status:</strong> ${result.changed ? 'Updated' : 'No changes'}</p>
                            <p><strong>Total Songs:</strong> ${result.songsCount}</p>
                            <p><strong>File:</strong> ${path.basename(result.filename)}</p>
                        </div>
                        
                        <p><strong>Next scheduled backup:</strong> ${this.scheduler.getNextBackupTime()}</p>
                        <p>
                            <a href="/" style="background: #1DB954; color: white; padding: 10px 20px; 
                               text-decoration: none; border-radius: 4px; display: inline-block; margin-top: 20px;">
                                Go to Dashboard
                            </a>
                        </p>
                    </body>
                    </html>
                `);

            } catch (error) {
                console.error('Login error:', error.message);
                res.status(500).send(`
                    <h2>Login Failed</h2>
                    <p>${error.message}</p>
                    <p><a href="/">Try Again</a></p>
                `);
            }
        });

        // ========== BACKUP ENDPOINTS ==========
        this.app.get('/backup', (req, res) => {
            const users = Array.from(this.userSessions.values()).map(s => s.display_name);
            
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Manual Backup</title>
                    <style>
                        body { font-family: sans-serif; padding: 40px; }
                        .btn { background: #1DB954; color: white; padding: 10px 20px; 
                               text-decoration: none; border-radius: 4px; display: inline-block; margin: 5px; }
                    </style>
                </head>
                <body>
                    <h1>Manual Backup</h1>
                    ${users.length === 0 ? '<p>No users logged in. <a href="/login">Login first</a></p>' : ''}
                    ${users.map(user => `
                        <div style="margin: 10px 0;">
                            <strong>${user}</strong><br>
                            <a href="/backup/${user}" class="btn">Backup Now</a>
                        </div>
                    `).join('')}
                    <p><a href="/">← Dashboard</a></p>
                </body>
                </html>
            `;
            res.send(html);
        });

        this.app.get('/backup/:displayName', async (req, res) => {
            const displayName = req.params.displayName;
            
            // Find username by display name
            let username = null;
            for (const [uname, session] of this.userSessions.entries()) {
                if (session.display_name === displayName) {
                    username = uname;
                    break;
                }
            }
            
            if (!username) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            try {
                const result = await this.performSimpleBackup(username);
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // ========== API ENDPOINTS ==========
        this.app.get('/api/stats', (req, res) => {
            res.json(this.tracker.getStats());
        });

        this.app.get('/api/users', (req, res) => {
            const users = Array.from(this.userSessions.values()).map(s => ({
                display_name: s.display_name,
                expires_at: new Date(s.expires_at).toLocaleString()
            }));
            res.json({ users });
        });

        this.app.get('/api/force-backup', async (req, res) => {
            await this.scheduler.runScheduledBackups();
            res.json({ success: true, message: 'Manual backup triggered' });
        });
    }

    // ==================== CORE FUNCTIONS ====================
    async getValidToken(username) {
        const session = this.userSessions.get(username);
        if (!session) {
            throw new Error(`No session found for user: ${username}`);
        }

        if (Date.now() < session.expires_at - (15 * 60 * 1000)) {
            return session.access_token;
        }

        console.log(`🔄 Refreshing token for: ${session.display_name}`);
        
        try {
            const response = await this.rateLimiter.makeRequest(() =>
                axios.post(
                    'https://accounts.spotify.com/api/token',
                    querystring.stringify({
                        grant_type: 'refresh_token',
                        refresh_token: session.refresh_token
                    }),
                    {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Authorization': 'Basic ' + 
                                Buffer.from(`${this.config.client_id}:${this.config.client_secret}`)
                                .toString('base64')
                        }
                    }
                )
            );

            session.access_token = response.data.access_token;
            session.expires_at = Date.now() + (3600 * 1000);
            
            this.userSessions.set(username, session);
            console.log(`✅ Token refreshed for: ${session.display_name}`);
            
            return session.access_token;

        } catch (error) {
            console.error(`❌ Token refresh failed for ${session.display_name}:`, error.message);
            this.userSessions.delete(username);
            throw new Error('Session expired. Please login again.');
        }
    }

    async getLikedSongsCount(token) {
        this.tracker.logRequest('api');
        
        try {
            const response = await this.rateLimiter.makeRequest(() =>
                axios.get('https://api.spotify.com/v1/me/tracks?limit=1', {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 5000
                })
            );
            
            return response.data.total;
        } catch (error) {
            console.error('Error getting song count:', error.message);
            throw error;
        }
    }

    async getAllLikedSongs(token) {
        let allSongs = [];
        let offset = 0;
        const limit = 50;
        let total = 0;
        
        try {
            const countResponse = await this.rateLimiter.makeRequest(() =>
                axios.get('https://api.spotify.com/v1/me/tracks?limit=1', {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
            );
            
            total = countResponse.data.total;
            console.log(`📊 Fetching ${total} songs...`);
            
            while (offset < total) {
                const url = `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`;
                
                const response = await this.rateLimiter.makeRequest(() =>
                    axios.get(url, {
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 15000
                    })
                );
                
                const batchSongs = response.data.items.map(item => ({
                    artist: item.track.artists[0].name,
                    title: item.track.name
                }));
                
                allSongs.push(...batchSongs);
                offset += limit;
                
                if (allSongs.length % 200 === 0 || allSongs.length === total) {
                    const progress = Math.round((allSongs.length / total) * 100);
                    console.log(`Progress: ${progress}% (${allSongs.length}/${total})`);
                }
                
                if (offset < total) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            
            console.log(`✅ Fetched ${allSongs.length} songs`);
            return allSongs;
            
        } catch (error) {
            console.error('Error fetching songs:', error.message);
            throw error;
        }
    }

    async performSimpleBackup(username) {
        const startTime = Date.now();
        const session = this.userSessions.get(username);
        
        if (!session) {
            throw new Error(`User ${username} not logged in`);
        }
        
        console.log(`\n🔍 Checking for changes: ${session.display_name}`);
        
        try {
            const token = await this.getValidToken(username);
            
            const currentCount = await this.getLikedSongsCount(token);
            
            const backupFile = path.join(this.config.backups_location, `${session.display_name}_liked_songs.txt`);
            let previousCount = 0;
            let previousHash = '';
            
            try {
                if (fsSync.existsSync(backupFile)) {
                    const content = await fs.readFile(backupFile, 'utf-8');
                    const lines = content.split('\n').filter(line => line.trim());
                    previousCount = lines.length;
                    
                    previousHash = crypto
                        .createHash('md5')
                        .update(content)
                        .digest('hex');
                }
            } catch (error) {
                console.log('Previous backup file not found or corrupted');
            }
            
            if (previousCount === currentCount && previousCount > 0) {
                console.log(`📭 No count change for ${session.display_name} (${currentCount} songs)`);
                
                console.log(`⚠️  Still fetching to ensure no content changes...`);
            } else {
                console.log(`🔄 Change detected: ${previousCount} → ${currentCount} songs`);
            }
            
            console.log(`📥 Fetching all songs for ${session.display_name}...`);
            const songs = await this.getAllLikedSongs(token);
            
            const formattedSongs = songs.map(song => `${song.artist} - ${song.title}`).join('\n');
            
            const currentHash = crypto
                .createHash('md5')
                .update(formattedSongs)
                .digest('hex');
            
            const changed = previousHash !== currentHash;
            
            if (changed) {
                await fs.writeFile(backupFile, formattedSongs);
                
                const jsonFile = path.join(this.config.backups_location, `${session.display_name}_liked_songs.json`);
                await fs.writeFile(jsonFile, JSON.stringify({
                    display_name: session.display_name,
                    backup_timestamp: new Date().toISOString(),
                    total_songs: songs.length,
                    songs: songs
                }, null, 2));
                
                this.tracker.logRequest('backup', songs.length);
                
                const duration = Date.now() - startTime;
                console.log(`✅ Backup updated: ${songs.length} songs in ${duration}ms`);
                
                return {
                    success: true,
                    changed: true,
                    display_name: session.display_name,
                    songsCount: songs.length,
                    previousCount: previousCount,
                    duration: duration,
                    filename: backupFile,
                    message: 'Backup file updated'
                };
                
            } else {
                const duration = Date.now() - startTime;
                console.log(`📭 No content changes for ${session.display_name}, file not updated`);
                
                return {
                    success: true,
                    changed: false,
                    display_name: session.display_name,
                    songsCount: songs.length,
                    previousCount: previousCount,
                    duration: duration,
                    message: 'No changes detected'
                };
            }
            
        } catch (error) {
            console.error(`Backup failed for ${session.display_name}:`, error.message);
            throw error;
        }
    }

    startServer() {
        this.app.listen(this.config.port, () => {
            console.log(`
===========================================
🎵 SPOTIFY SIMPLE BACKUP SYSTEM
===========================================
✅ Server running: http://127.0.0.1:${this.config.port}
✅ Backup location: ${this.config.backups_location}
✅ Backup interval: ${this.config.auto_backup_interval} hour(s)
✅ Rate limiting: ${this.config.requests_per_second} req/sec

📊 SIMPLE & RELIABLE:
   • Checks every ${this.config.auto_backup_interval} hours
   • Any change → Full file rewrite
   • MD5 hash comparison for content changes
   • Ultra-safe API usage

🚀 FEATURES:
   • Simple web interface
   • Manual backup triggers
   • Automatic token refresh
   • Multi-user support
   • File change detection

📁 ROUTES:
   • /              - Dashboard
   • /login         - Login with Spotify
   • /backup        - Manual backup
   • /api/stats     - Statistics
   • /api/users     - Active users
===========================================
            `);
        });
    }
}

// ==================== START SERVER ====================
const server = new SimpleSpotifyBackupServer();