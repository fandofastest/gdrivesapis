import { EventEmitter } from 'node:events';

class PlayEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.recentLogs = [];
    this.maxLogs = 50;
  }

  emitPlay(data) {
    const payload = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date().toISOString(),
      mediaType: data.mediaType || 'unknown',
      title: data.title || 'Unknown Title',
      driveFileId: data.driveFileId || null,
      movieId: data.movieId || null,
      resolution: data.resolution || null,
      playCount: data.playCount || 1,
    };

    this.recentLogs.unshift(payload);
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.pop();
    }

    this.emit('play', payload);
    return payload;
  }

  getRecentLogs() {
    return [...this.recentLogs];
  }
}

export const playEvents = new PlayEventEmitter();
