/**
 * Store — Application-wide state container.
 *
 * Plain TypeScript class, no framework. The Store holds the single
 * source of truth for runtime state. Views read from it; Services
 * and Controllers write to it via EventBus events.
 *
 * Follows the Single Responsibility Principle: it only holds state
 * and notifies observers. It never fetches data itself.
 */

import type { ILMSNode, IModel, IUser, IInferenceSlot } from '@/types';
import { EventBus } from './EventBus';

interface IAppState {
  readonly currentUser: IUser | null;
  readonly activeNodeId: string | null;
  readonly nodes: ReadonlyMap<string, ILMSNode>;
  readonly loadedModels: ReadonlyMap<string, IModel>;   // nodeId → active model
  readonly inferenceSlots: ReadonlyArray<IInferenceSlot>;
  readonly currentRoute: string;
  readonly isConnecting: boolean;
}

type StateListener = (state: Readonly<IAppState>) => void;

class StoreClass {
  private state: IAppState = {
    currentUser: null,
    activeNodeId: null,
    nodes: new Map(),
    loadedModels: new Map(),
    inferenceSlots: [],
    currentRoute: '/login',   // safe default — Router.init() will correct it from the hash
    isConnecting: false,
  };

  private readonly listeners = new Set<StateListener>();

  getState(): Readonly<IAppState> {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(partial: Partial<IAppState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(l => l(this.state));
  }

  // --- Mutations ---

  setUser(user: IUser | null): void {
    this.setState({ currentUser: user });
  }

  setActiveNode(nodeId: string): void {
    this.setState({ activeNodeId: nodeId });
  }

  upsertNode(node: ILMSNode): void {
    const nodes = new Map(this.state.nodes);
    nodes.set(node.nodeId, node);
    this.setState({ nodes });
  }

  setLoadedModel(nodeId: string, model: IModel): void {
    const loadedModels = new Map(this.state.loadedModels);
    loadedModels.set(nodeId, model);
    this.setState({ loadedModels });
  }

  clearLoadedModel(nodeId: string): void {
    const loadedModels = new Map(this.state.loadedModels);
    loadedModels.delete(nodeId);
    this.setState({ loadedModels });
  }

  setInferenceSlots(slots: IInferenceSlot[]): void {
    this.setState({ inferenceSlots: slots });
  }

  navigate(route: string): void {
    this.setState({ currentRoute: route });
    EventBus.emit({ type: 'NAVIGATION', payload: { route } });
  }

  setConnecting(value: boolean): void {
    this.setState({ isConnecting: value });
  }
}

// Singleton
export const Store = new StoreClass();
