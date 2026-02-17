import { sleep, sleepBackoff, retry, withTimeout, unrefTimer } from '../../utils/async.js';

describe('async utilities', () => {
  describe('sleep', () => {
    it('resolves after the specified delay', async () => {
      const start = Date.now();
      await sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });

  describe('sleepBackoff', () => {
    it('delays increase exponentially', async () => {
      const start0 = Date.now();
      await sleepBackoff(0, 10, 5000);
      const d0 = Date.now() - start0;

      const start1 = Date.now();
      await sleepBackoff(1, 10, 5000);
      const d1 = Date.now() - start1;

      expect(d1).toBeGreaterThanOrEqual(d0);
    });

    it('respects maxMs cap', async () => {
      const start = Date.now();
      await sleepBackoff(20, 100, 50); // 2^20 * 100 >> 50, should cap at 50
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('retry', () => {
    it('returns on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await retry(fn, 3, 10);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure then succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'))
        .mockResolvedValue('ok');
      const result = await retry(fn, 3, 10);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('throws last error after exhausting attempts', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('always-fail'));
      await expect(retry(fn, 2, 10)).rejects.toThrow('always-fail');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('wraps non-Error throws', async () => {
      const fn = vi.fn().mockRejectedValue('string-error');
      await expect(retry(fn, 1, 10)).rejects.toThrow('string-error');
    });
  });

  describe('withTimeout', () => {
    it('returns result when fn completes before timeout', async () => {
      const fn = () => Promise.resolve('fast');
      const result = await withTimeout(fn, 1000);
      expect(result).toBe('fast');
    });

    it('rejects with timeout error when fn is slow', async () => {
      const fn = () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 5000));
      await expect(withTimeout(fn, 50, 'too slow')).rejects.toThrow('too slow');
    });

    it('uses default error message', async () => {
      const fn = () => new Promise<never>(() => {});
      await expect(withTimeout(fn, 50)).rejects.toThrow('Operation timed out');
    });
  });

  describe('unrefTimer', () => {
    it('calls unref on a timer with unref method', () => {
      const timer = setInterval(() => {}, 10000);
      expect(() => unrefTimer(timer)).not.toThrow();
      clearInterval(timer);
    });

    it('does not throw for objects without unref', () => {
      const fakeTimer = { ref: () => {} } as unknown as ReturnType<typeof setInterval>;
      expect(() => unrefTimer(fakeTimer)).not.toThrow();
    });
  });
});
