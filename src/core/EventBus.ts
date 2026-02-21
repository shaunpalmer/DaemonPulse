/**
 * EventBus — Central pub/sub for the entire application.
 *
 * This is the "circular" pattern: every layer (service, controller, view)
 * communicates exclusively through typed events. No direct references
 * between layers. Satisfies the Open/Closed principle — new event types
 * can be added without modifying existing subscribers.
 *
 * Usage:
 *   EventBus.on('DAEMON_STATE_CHANGED', ({ payload }) => { ... });
 *   EventBus.emit({ type: 'DAEMON_STATE_CHANGED', payload: { ... } });
 *   EventBus.off('DAEMON_STATE_CHANGED', handler);
 */

import type { AppEvent } from '@/types';

type EventType = AppEvent['type'];
type EventPayload<T extends EventType> = Extract<AppEvent, { type: T }>['payload'];
type Handler<T extends EventType> = (event: { type: T; payload: EventPayload<T> }) => void;

class EventBusClass {
  private readonly listeners = new Map<EventType, Set<Handler<EventType>>>();

  on<T extends EventType>(type: T, handler: Handler<T>): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler as unknown as Handler<EventType>);
  }

  off<T extends EventType>(type: T, handler: Handler<T>): void {
    this.listeners.get(type)?.delete(handler as unknown as Handler<EventType>);
  }

  emit<T extends EventType>(event: Extract<AppEvent, { type: T }>): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      handlers.forEach(handler => handler(event as { type: EventType; payload: EventPayload<EventType> }));
    }
  }

  /** Remove all listeners — useful for teardown / testing */
  clear(): void {
    this.listeners.clear();
  }
}

// Singleton — one bus for the whole app
export const EventBus = new EventBusClass();
