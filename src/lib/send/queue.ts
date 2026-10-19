import type Redis from "ioredis";

export type SendJob = { scheduleId: string };

export type ClaimedJob = { job: SendJob; raw: string };

export interface SendQueue {
  push(job: SendJob): Promise<void>;
  claim(): Promise<ClaimedJob | null>;
  ack(raw: string): Promise<void>;
  release(raw: string): Promise<void>;
  requeueInflight(): Promise<void>;
  size(): Promise<number>;
}

export class MemorySendQueue implements SendQueue {
  private ready: string[] = [];
  private processing: string[] = [];

  async push(job: SendJob): Promise<void> {
    this.ready.push(JSON.stringify(job));
  }

  async claim(): Promise<ClaimedJob | null> {
    const raw = this.ready.shift();
    if (!raw) return null;
    this.processing.push(raw);
    return { job: JSON.parse(raw) as SendJob, raw };
  }

  async ack(raw: string): Promise<void> {
    const index = this.processing.indexOf(raw);
    if (index >= 0) this.processing.splice(index, 1);
  }

  async release(raw: string): Promise<void> {
    await this.ack(raw);
    this.ready.push(raw);
  }

  async requeueInflight(): Promise<void> {
    while (this.processing.length > 0) {
      const raw = this.processing.pop();
      if (raw) this.ready.unshift(raw);
    }
  }

  async size(): Promise<number> {
    return this.ready.length;
  }

  inflight(): number {
    return this.processing.length;
  }
}

export const SEND_QUEUE_READY = "outreach:send-queue";
export const SEND_QUEUE_PROCESSING = "outreach:send-queue:processing";

/** RPUSH ready, claim moves the job onto a processing list, restart puts that list back. */
export class RedisSendQueue implements SendQueue {
  constructor(
    private readonly redis: Redis,
    private readonly readyKey = SEND_QUEUE_READY,
    private readonly processingKey = SEND_QUEUE_PROCESSING,
  ) {}

  async push(job: SendJob): Promise<void> {
    await this.redis.rpush(this.readyKey, JSON.stringify(job));
  }

  async claim(): Promise<ClaimedJob | null> {
    const raw = await this.redis.lmove(this.readyKey, this.processingKey, "LEFT", "RIGHT");
    if (!raw) return null;
    return { job: JSON.parse(raw) as SendJob, raw };
  }

  async ack(raw: string): Promise<void> {
    await this.redis.lrem(this.processingKey, 1, raw);
  }

  async release(raw: string): Promise<void> {
    await this.ack(raw);
    await this.redis.rpush(this.readyKey, raw);
  }

  async requeueInflight(): Promise<void> {
    for (;;) {
      const raw = await this.redis.lmove(this.processingKey, this.readyKey, "RIGHT", "LEFT");
      if (!raw) break;
    }
  }

  async size(): Promise<number> {
    return this.redis.llen(this.readyKey);
  }

  async clear(): Promise<void> {
    await this.redis.del(this.readyKey, this.processingKey);
  }
}
