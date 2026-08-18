const DEFAULT_BATCH_SIZE = 8;

module.exports = function createMemoryVectorIndexer({ memory, embedding, batchSize = DEFAULT_BATCH_SIZE, logger = console }) {
  const capacity = Math.max(1, Math.min(16, Number.parseInt(batchSize, 10) || DEFAULT_BATCH_SIZE));
  let queue = Promise.resolve();
  let stopped = false;

  async function indexEpisodes(episodes) {
    const status = embedding.getStatus();
    if (stopped || !status.ready || !Array.isArray(episodes) || !episodes.length) return { indexed: 0, skipped: 0 };
    const unique = [];
    const seen = new Set();
    for (const episode of episodes) {
      const id = typeof episode?.id === 'string' ? episode.id.trim().slice(0, 120) : '';
      const content = String(episode?.summary || episode?.content || '').trim().slice(0, 4000);
      if (!id || !content || seen.has(id) || episode?.recallState && episode.recallState !== 'active') continue;
      seen.add(id);
      unique.push({ id, content, createdAt: episode.startedAt || episode.createdAt });
    }
    let indexed = 0;
    for (let offset = 0; offset < unique.length; offset += capacity) {
      if (stopped) break;
      const batch = unique.slice(offset, offset + capacity);
      const result = await embedding.embed(batch.map((item) => item.content));
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index];
        const stored = await memory.upsertVector({
          chunkId: item.id,
          model: result.model,
          dimensions: result.dimensions,
          content: item.content,
          vector: result.vectors[index],
          sourceIds: [item.id],
          createdAt: item.createdAt,
        });
        if (stored) indexed += 1;
      }
    }
    return { indexed, skipped: unique.length - indexed };
  }

  function enqueue(episodes) {
    if (stopped || !embedding.getStatus().ready) return Promise.resolve({ indexed: 0, skipped: 0 });
    const run = queue.then(() => indexEpisodes(episodes));
    queue = run.catch((error) => {
      logger.warn?.('[memory-vector] indexing failed:', error.message);
    });
    return run;
  }

  async function syncPending(limit = 50) {
    if (stopped || !embedding.getStatus().ready) return { indexed: 0, skipped: 0 };
    const episodes = await memory.listVectorPending(embedding.getStatus().model, limit);
    return enqueue(episodes);
  }

  function stop() {
    stopped = true;
  }

  return { enqueue, syncPending, stop, getStatus: () => ({ ...embedding.getStatus(), stopped }) };
};
