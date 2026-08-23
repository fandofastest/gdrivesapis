import { scanDriveMovies, enrichMetadata, migrateMisclassifiedEpisodes } from './scanDriveMovies.js';

class ScanManager {
  constructor() {
    this.status = 'idle'; // 'idle' | 'running' | 'completed' | 'failed' | 'cancelling'
    this.mode = 'full';
    this.startTime = null;
    this.endTime = null;
    this.error = null;
    this.abortController = null;
    this.maxLogs = 300;
    this.logs = [];

    this.progress = {
      scanned: 0,
      scannedFolders: 0,
      discoveredFolders: 0,
      detected: 0,
      saved: 0,
      skipped: 0,
      skippedNonVideo: 0,
      skippedParseFailed: 0,
      skippedDuplicate: 0,
      skippedFolder: 0,
    };
  }

  resetProgress() {
    this.progress = {
      scanned: 0,
      scannedFolders: 0,
      discoveredFolders: 0,
      detected: 0,
      saved: 0,
      skipped: 0,
      skippedNonVideo: 0,
      skippedParseFailed: 0,
      skippedDuplicate: 0,
      skippedFolder: 0,
    };
  }

  addLog(msg) {
    const time = new Date().toISOString().split('T')[1].slice(0, 8);
    const entry = { time, message: String(msg) };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  getStatus() {
    let durationSeconds = 0;
    if (this.startTime) {
      const end = this.endTime ? new Date(this.endTime) : new Date();
      durationSeconds = Math.floor((end - new Date(this.startTime)) / 1000);
    }

    return {
      status: this.status,
      mode: this.mode,
      startTime: this.startTime,
      endTime: this.endTime,
      durationSeconds,
      progress: { ...this.progress },
      error: this.error,
      recentLogs: this.logs.slice(-50),
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(-Math.min(limit, this.maxLogs));
  }

  async startScan({ mode = 'full', driveFolderId, tmdbApiKey, mongoUri, concurrency }) {
    if (this.status === 'running' || this.status === 'cancelling') {
      throw new Error('Scan is already running or cancelling.');
    }

    const folderId = driveFolderId || process.env.DRIVE_FOLDER_ID;
    const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY;
    const mUri = mongoUri || process.env.MONGO_URI;

    if (mode !== 'enrich' && mode !== 'migrate' && !folderId) {
      throw new Error('DRIVE_FOLDER_ID is required to start a scan.');
    }
    if (!mUri) {
      throw new Error('MONGO_URI is required to start a scan.');
    }

    this.status = 'running';
    this.mode = mode;
    this.startTime = new Date().toISOString();
    this.endTime = null;
    this.error = null;
    this.logs = [];
    this.resetProgress();
    this.abortController = new AbortController();

    if (concurrency) {
      process.env.CONCURRENCY = String(concurrency);
    }

    this.addLog(`[manager] Starting scan mode='${mode}' folder='${folderId || 'n/a'}'`);

    // Run in background without blocking API caller
    (async () => {
      try {
        const hooks = {
          onLog: (msg) => this.addLog(msg),
          onProgress: (p) => {
            this.progress = { ...this.progress, ...p };
          },
          signal: this.abortController.signal,
          interactive: false,
        };

        if (mode === 'enrich') {
          await enrichMetadata({ mongoUri: mUri, tmdbApiKey: tmdbKey, ...hooks });
        } else if (mode === 'migrate') {
          await migrateMisclassifiedEpisodes({ mongoUri: mUri, tmdbApiKey: tmdbKey, ...hooks });
        } else {
          process.env.INDEX_MODE = mode; // 'full' or 'raw'
          await scanDriveMovies({ driveFolderId: folderId, tmdbApiKey: tmdbKey, mongoUri: mUri, ...hooks });
        }

        if (this.abortController.signal.aborted) {
          this.status = 'idle';
          this.addLog('[manager] Scan cancelled by user.');
        } else {
          this.status = 'completed';
          this.addLog('[manager] Scan completed successfully.');
        }
      } catch (err) {
        this.status = 'failed';
        this.error = err?.message || String(err);
        this.addLog(`[manager] Scan failed: ${this.error}`);
      } finally {
        this.endTime = new Date().toISOString();
        this.abortController = null;
      }
    })();

    return this.getStatus();
  }

  stopScan() {
    if (this.status !== 'running' || !this.abortController) {
      throw new Error('No scan is currently running.');
    }
    this.status = 'cancelling';
    this.addLog('[manager] Cancellation requested...');
    this.abortController.abort();
    return this.getStatus();
  }
}

export const scanManager = new ScanManager();
