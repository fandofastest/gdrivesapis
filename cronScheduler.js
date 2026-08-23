import { scanManager } from './scanManager.js';

let timerId = null;

function getMsUntilMidnight() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0); // Next 00:00:00
  return nextMidnight.getTime() - now.getTime();
}

export function initCronScheduler() {
  if (timerId) clearTimeout(timerId);

  const msToMidnight = getMsUntilMidnight();
  const hours = (msToMidnight / (1000 * 60 * 60)).toFixed(1);

  console.log(`[cron] Auto-scan harian dijadwalkan pada pukul 00:00 WIB (dalam ${hours} jam).`);

  timerId = setTimeout(async () => {
    try {
      console.log('[cron] Menjalankan auto-scan harian 00:00...');
      const status = scanManager.getStatus();
      if (!status.isRunning) {
        await scanManager.startScan({ mode: 'full' });
        console.log('[cron] Auto-scan harian berhasil dimulai.');
      } else {
        console.log('[cron] Process scan sedang berjalan, melewatkan jadwal 00:00.');
      }
    } catch (err) {
      console.error('[cron] Gagal menjalankan auto-scan harian:', err?.message || err);
    } finally {
      // Re-schedule for next midnight
      initCronScheduler();
    }
  }, msToMidnight);
}

export function stopCronScheduler() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
    console.log('[cron] Auto-scan harian dihentikan.');
  }
}
