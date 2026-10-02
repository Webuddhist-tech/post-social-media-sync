import { EventEmitter } from "node:events";
import type { PostSyncEventName, PostSyncEvents } from "./types.js";

type Listener<E extends PostSyncEventName> = (payload: PostSyncEvents[E]) => void;

/** Typed event emitter for engine events (`post.created`, `target.succeeded`, ...). */
export class PostSyncEmitter {
  private readonly emitter = new EventEmitter();

  constructor(private readonly onListenerError: (event: string, err: unknown) => void) {
    this.emitter.setMaxListeners(50);
  }

  on<E extends PostSyncEventName>(event: E, listener: Listener<E>): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  once<E extends PostSyncEventName>(event: E, listener: Listener<E>): void {
    this.emitter.once(event, listener);
  }

  off<E extends PostSyncEventName>(event: E, listener: Listener<E>): void {
    this.emitter.off(event, listener);
  }

  /** Listens to every event (handy for webhooks). */
  onAny(listener: <E extends PostSyncEventName>(event: E, payload: PostSyncEvents[E]) => void): () => void {
    const wrapped = (event: PostSyncEventName, payload: unknown) => listener(event, payload as any);
    this.emitter.on("*", wrapped);
    return () => this.emitter.off("*", wrapped);
  }

  /** Emits without ever letting a listener's exception break the engine. */
  emit<E extends PostSyncEventName>(event: E, payload: PostSyncEvents[E]): void {
    for (const name of [event, "*"] as const) {
      for (const listener of this.emitter.listeners(name)) {
        try {
          const result = name === "*" ? (listener as any)(event, payload) : (listener as any)(payload);
          if (result && typeof result.catch === "function") result.catch((err: unknown) => this.onListenerError(event, err));
        } catch (err) {
          this.onListenerError(event, err);
        }
      }
    }
  }
}
