import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

const QUEUE_KEY = 'offline_queue';

interface QueuedRequest {
  id: string;
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  description: string;
  timestamp: number;
}

interface OfflineQueueContextType {
  queuedCount: number;
  enqueue: (req: Omit<QueuedRequest, 'id' | 'timestamp'>) => Promise<void>;
  processQueue: () => Promise<void>;
  isProcessing: boolean;
}

const OfflineQueueContext = createContext<OfflineQueueContextType | null>(null);

export function OfflineQueueProvider({ children }: { children: React.ReactNode }) {
  const [queuedCount, setQueuedCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const queue = useRef<QueuedRequest[]>([]);

  const loadQueue = async () => {
    try {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      if (raw) {
        queue.current = JSON.parse(raw);
        setQueuedCount(queue.current.length);
      }
    } catch {
      queue.current = [];
    }
  };

  const saveQueue = async () => {
    try {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.current));
      setQueuedCount(queue.current.length);
    } catch {}
  };

  useEffect(() => {
    loadQueue();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && queue.current.length > 0) {
        processQueue();
      }
    });
    return () => sub.remove();
  }, []);

  const enqueue = async (req: Omit<QueuedRequest, 'id' | 'timestamp'>) => {
    const item: QueuedRequest = {
      ...req,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
    };
    queue.current = [...queue.current, item];
    await saveQueue();
  };

  const processQueue = async () => {
    if (isProcessing || queue.current.length === 0) return;
    setIsProcessing(true);
    const toProcess = [...queue.current];
    const failed: QueuedRequest[] = [];

    for (const req of toProcess) {
      try {
        const resp = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body || undefined,
        });
        if (!resp.ok) failed.push(req);
      } catch {
        failed.push(req);
      }
    }

    queue.current = failed;
    await saveQueue();
    setIsProcessing(false);
  };

  return (
    <OfflineQueueContext.Provider value={{ queuedCount, enqueue, processQueue, isProcessing }}>
      {children}
    </OfflineQueueContext.Provider>
  );
}

export function useOfflineQueue() {
  const ctx = useContext(OfflineQueueContext);
  if (!ctx) throw new Error('useOfflineQueue must be used within OfflineQueueProvider');
  return ctx;
}
