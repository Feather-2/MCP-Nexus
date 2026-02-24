import { mapMiddlewareError } from '../../server/MiddlewareErrorMapper.js';
import {
  MiddlewareAbortedError,
  MiddlewareStageError,
  MiddlewareTimeoutError
} from '../../middleware/chain.js';

describe('MiddlewareErrorMapper', () => {
  it('maps timeout error to 504/MIDDLEWARE_TIMEOUT', () => {
    const mapped = mapMiddlewareError(new MiddlewareTimeoutError('beforeAgent', 'auth', 1000));
    expect(mapped).toEqual(expect.objectContaining({
      status: 504,
      code: 'MIDDLEWARE_TIMEOUT',
      recoverable: true
    }));
  });

  it('maps aborted error to 499/REQUEST_ABORTED', () => {
    const mapped = mapMiddlewareError(new MiddlewareAbortedError('beforeAgent', 'auth', new Error('client aborted')));
    expect(mapped).toEqual(expect.objectContaining({
      status: 499,
      code: 'REQUEST_ABORTED',
      recoverable: true
    }));
  });

  it('maps stage error with timeout cause preserving stage metadata', () => {
    const stage = new MiddlewareStageError('beforeAgent', 'rate', new MiddlewareTimeoutError('beforeAgent', 'rate', 500));
    const mapped = mapMiddlewareError(stage);
    expect(mapped.code).toBe('MIDDLEWARE_TIMEOUT');
  });

  it('maps unknown errors to 500/MIDDLEWARE_ERROR', () => {
    const mapped = mapMiddlewareError(new Error('boom'));
    expect(mapped).toEqual(expect.objectContaining({
      status: 500,
      code: 'MIDDLEWARE_ERROR',
      message: 'boom',
      recoverable: false
    }));
  });
});
