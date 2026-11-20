import React, { useEffect, useState } from 'react';
import { Activity, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { config } from '../lib/config';
import type { HealthCheckResponse } from '@hostelcode/shared';

export const HealthStatus: React.FC = () => {
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const checkHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${config.serverHttpUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data: HealthCheckResponse = await res.json();
      setHealth(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to reach collaboration server');
      setHealth(null);
    } finally {
      setLoading(false);
      setLastChecked(new Date());
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-[#252526] border border-[#3c3c3c] rounded text-xs">
      <div className="flex items-center gap-1.5">
        {loading ? (
          <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
        ) : health?.status === 'ok' ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
        )}

        <span className="font-medium">
          Server:{' '}
          <span
            className={
              health?.status === 'ok'
                ? 'text-emerald-400 font-semibold'
                : 'text-rose-400 font-semibold'
            }
          >
            {health?.status === 'ok' ? 'Connected' : 'Offline'}
          </span>
        </span>
      </div>

      {error && (
        <span className="text-rose-400 text-[11px] truncate max-w-[150px]" title={error}>
          ({error})
        </span>
      )}

      <button
        onClick={checkHealth}
        disabled={loading}
        title={lastChecked ? `Last checked at ${lastChecked.toLocaleTimeString()}` : 'Refresh health status'}
        className="text-neutral-400 hover:text-white transition-colors ml-1"
      >
        <Activity className="w-3 h-3" />
      </button>
    </div>
  );
};
