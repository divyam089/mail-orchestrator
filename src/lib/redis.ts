import Redis from "ioredis";

export function createRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return new Redis(url, {
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
  });
}

export async function redisPing(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const redis = new Redis(url, {
    connectTimeout: 1500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}
