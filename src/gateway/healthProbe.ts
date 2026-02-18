import type { ServiceRegistry, ProtocolAdapters } from '../types/index.js';
import { sendRequest } from '../adapters/ProtocolAdaptersImpl.js';
import { mcpRequest } from '../core/mcpMessage.js';

/**
 * Register a default health probe that uses tools/list to check service health.
 */
export function registerDefaultHealthProbe(
  serviceRegistry: ServiceRegistry,
  protocolAdapters: ProtocolAdapters
): void {
  try {
    serviceRegistry.setHealthProbe(async (serviceId: string) => {
      const service = await serviceRegistry.getService(serviceId);
      if (!service) {
        return { healthy: false, error: 'Service not found', timestamp: new Date() };
      }
      if (service.state !== 'running') {
        return { healthy: false, error: 'Service not running', timestamp: new Date() };
      }
      const start = Date.now();
      try {
        const result = await protocolAdapters.withAdapter(service.config, async (adapter) => {
          return sendRequest(adapter, mcpRequest('tools/list', {}, 'health'));
        });
        const latency = Date.now() - start;
        const r = result as Record<string, unknown> | null;
        const ok = !!(r && r.result);
        if (!ok && (r?.error as Record<string, unknown>)?.message) {
          try {
            await serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', String((r!.error as Record<string, unknown>).message));
          } catch { /* best-effort metadata update */ }
        }
        return { healthy: ok, latency, timestamp: new Date() };
      } catch (error: unknown) {
        const errMsg = (error as Error)?.message || 'probe failed';
        try {
          await serviceRegistry.setInstanceMetadata(serviceId, 'lastProbeError', errMsg);
        } catch { /* best-effort metadata update */ }
        return { healthy: false, error: errMsg, latency: Date.now() - start, timestamp: new Date() };
      }
    });
  } catch { /* best-effort: health probe registration is non-critical */ }
}
